import { join } from 'node:path'

const point = (state, label, detail, checkedAt = null) => ({ state, label, detail, checkedAt })
const isolated = { codex: ['codex', 'CODEX_HOME'], claude: ['claude', 'CLAUDE_CONFIG_DIR'] }
// A read-only login check must never fall back to another workspace or a global login.
const CHECK_BOOTSTRAP = `base=$1
state=$2
shift 2
if [ -L "$base" ] || [ -L "$state" ]; then exit 79; fi
if [ ! -d "$state" ]; then exit 78; fi
exec "$@"`

export function loginEvidence(launcher, outcome, stdout = '', stderr = '', checkedAt = Date.now()) {
  if (outcome.exitCode === 78) return point('missing', '未配置', '此工作区尚未建立该智能体的登录配置。', checkedAt)
  if (outcome.exitCode === 79) return point('unknown', '未知', '配置目录无法安全核对，请在该工作区检查。', checkedAt)
  if (launcher === 'codex') {
    if (outcome.exitCode === 0 && /logged in (?:using|with)/i.test(stdout + stderr)) return point('verified', '已登录', '本地登录检查通过；不代表模型连接或剩余额度。', checkedAt)
    if (/not logged in|not signed in/i.test(stdout + stderr)) return point('missing', '未登录', '请在此工作区打开 Codex 完成登录。', checkedAt)
  }
  if (launcher === 'claude') {
    try {
      const value = JSON.parse(stdout)
      if (value.loggedIn === true && outcome.exitCode === 0) return point('verified', '已登录', '本地登录检查通过；不代表模型连接或剩余额度。', checkedAt)
      if (value.loggedIn === false) return point('missing', '未登录', '请在此工作区打开 Claude Code 完成登录。', checkedAt)
    } catch {}
  }
  return point('unknown', '未知', '当前版本没有返回可确认的登录状态，请在智能体中查看。', checkedAt)
}

export function readinessSnapshot(launcher, available, { auth, tasks = [], checkedAt = Date.now() } = {}) {
  const shell = launcher === 'shell'
  const unknown = text => point('unknown', '未知', text)
  let authentication = shell ? point('not_required', '无需账号', 'Shell 无需模型账号。', checkedAt)
    : auth ?? unknown('尚未核对这个工作区的登录状态。')
  let connection = shell ? point('not_required', '不适用', 'Shell 不使用模型连接。', checkedAt)
    : unknown('尚无此工作区的模型请求结果。')
  let quota = shell ? point('not_required', '不适用', 'Shell 不使用模型额度。', checkedAt)
    : unknown('此智能体未提供可核对的套餐和剩余额度信息。')
  const matches = item => item.targetLauncher === launcher || (['pi', 'piagent'].includes(launcher) && ['pi', 'piagent'].includes(item.targetLauncher))
  const latest = tasks.filter(item => matches(item) && Number.isFinite(item.executionFinishedAt) && ['succeeded', 'failed'].includes(item.status))
    .sort((a, b) => b.executionFinishedAt - a.executionFinishedAt)[0]
  if (!shell && latest) {
    const at = latest.executionFinishedAt
    if (latest.status === 'succeeded') {
      connection = point('last_succeeded', '上次连接成功', '依据此工作区最近一次完整的 Agent 返回；当前在线状态仍可能变化。', at)
      if (!auth?.checkedAt || auth.checkedAt < at) authentication = point('last_succeeded', '上次认证可用', '依据此工作区最近一次成功任务。', at)
    } else {
      const error = latest.error ?? ''
      if (/登录|凭据/.test(error)) {
        if (!auth?.checkedAt || auth.checkedAt < at) authentication = point('missing', '需要登录', '最近任务报告登录或凭据不可用。', at)
      } else if (/暂时无法连接模型服务|没有可用的模型配置|服务请求受到限流/.test(error)) connection = point('failed', '上次请求失败', '最近任务报告模型配置、连接或限流问题；可在智能体中重试。', at)
      if (/额度|订阅/.test(error)) quota = point('limited', '额度受限', '最近任务报告额度或订阅限制，具体套餐与余额请在智能体中核对。', at)
    }
  }
  return { installation: point(available ? 'installed' : 'missing', available ? '已安装' : '未安装', available ? '已找到启动程序。' : '未找到启动程序。', checkedAt),
    authentication, connection, quota, canCheckLogin: available && !!isolated[launcher] }
}

export class AgentReadiness {
  constructor(terminals) { this.terminals = terminals; this.ctx = terminals.ctx; this.states = new Map(); this.timeoutMs = 8000 }
  state(owner) {
    this.terminals.current(owner)
    let state = this.states.get(owner)
    if (!state) { state = { auth: new Map(), jobs: new Map() }; this.states.set(owner, state) }
    return state
  }
  auth(owner, launcher) { return this.states.get(owner)?.auth.get(launcher) }
  hasActive(owner) { return !!this.states.get(owner)?.jobs.size }
  async check(owner, launcher, signal) {
    signal?.throwIfAborted()
    this.terminals.owned(owner)
    const state = this.state(owner)
    if (!isolated[launcher]) return { supported: false }
    const previous = state.jobs.get(launcher)
    if (previous) {
      if (previous.cleanupFailed) { await this.drain(previous); state.jobs.delete(launcher) }
      else return previous.promise
    }
    const job = { controller: new AbortController() }
    state.jobs.set(launcher, job)
    job.promise = this.run(owner, launcher, state, job, signal)
    return job.promise
  }
  async run(owner, launcher, state, job, requestSignal) {
    const signal = requestSignal ? AbortSignal.any([requestSignal, job.controller.signal]) : job.controller.signal
    const timer = setTimeout(() => job.controller.abort(), this.timeoutMs)
    let authentication
    try {
      const policy = this.ctx.sandboxPolicy.resolve({ session: owner.session })
      const executable = await this.ctx.subprocess.resolveExecutable(launcher, undefined, signal)
      const shell = await this.ctx.subprocess.resolveExecutable('sh', undefined, signal)
      this.terminals.current(owner); signal.throwIfAborted()
      const base = join(policy.workspaceRoot, '.dsh-terminal'), dir = join(base, isolated[launcher][0])
      const env = { NO_COLOR: '1', DSH_SESSION_ID: owner.id, [isolated[launcher][1]]: dir,
        ...(launcher === 'codex' ? { CODEX_SQLITE_HOME: dir } : { DISABLE_AUTOUPDATER: '1' }) }
      const args = launcher === 'codex' ? ['login', 'status', '-c', 'cli_auth_credentials_store="file"'] : ['auth', 'status', '--json']
      let argv = [shell, '-c', CHECK_BOOTSTRAP, 'dsh-terminal-check', base, dir, executable, ...args]
      if (policy.mode !== 'danger-full-access') {
        const sandbox = this.ctx.get('sandbox')
        if (!sandbox) throw new Error('sandbox unavailable')
        argv = sandbox.confine(argv, { ...policy, mode: policy.mode }).argv
      }
      if (!argv?.[0]) throw new Error('invalid sandbox command')
      job.handle = this.ctx.subprocess.spawn({ argv, cwd: policy.workspaceRoot, env, signal, graceMs: 600,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 16384 }, stderr: { maxBytes: 4096 } } })
      const aborted = new Promise((_, reject) => {
        job.onAbort = () => reject(new Error('check aborted'))
        signal.addEventListener('abort', job.onAbort, { once: true }); if (signal.aborted) job.onAbort()
      })
      const outcome = await Promise.race([job.handle.done, aborted])
      this.terminals.current(owner); signal.throwIfAborted()
      // Status output can contain account identifiers or key fragments: retain only scalar evidence.
      authentication = loginEvidence(launcher, outcome, job.handle.collected?.stdout?.readFrom(0).text, job.handle.collected?.stderr?.readFrom(0).text)
    } catch {
      authentication = point('unknown', '未知', signal.aborted ? '登录检查已停止或超时，请稍后重试。' : '暂时无法核对登录，请在此工作区打开智能体查看。', Date.now())
    } finally {
      clearTimeout(timer)
      if (job.onAbort) signal.removeEventListener('abort', job.onAbort)
      try { await this.drain(job); state.jobs.delete(launcher) }
      catch { job.cleanupFailed = true; authentication = point('unknown', '未知', '检查进程尚未结束，请再次检查以完成清理。', Date.now()) }
    }
    this.terminals.current(owner)
    state.auth.set(launcher, authentication)
    return { supported: true, authentication }
  }
  async drain(job) {
    if (!job.handle) return
    job.handle.terminate()
    if (typeof job.handle.waitForExit !== 'function' || !await job.handle.waitForExit(AbortSignal.timeout(10000))) throw new Error('login check cleanup incomplete')
    job.handle = null
  }
  async disposeOwner(owner) {
    const state = this.states.get(owner)
    if (!state) return
    for (const job of state.jobs.values()) job.controller.abort()
    await Promise.allSettled([...state.jobs.values()].map(job => job.promise))
    await Promise.all([...state.jobs.values()].map(job => this.drain(job)))
    this.states.delete(owner)
  }
}
