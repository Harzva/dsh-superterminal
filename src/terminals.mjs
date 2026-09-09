import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { join } from 'node:path'
import { requests } from './remote.mjs'
import { localPtyCompatibility } from './pty-compat.mjs'

const OUTPUT_BYTES = 8 * 1024 * 1024
const READ_CHARS = 64 * 1024
// Runs inside the same DSH sandbox as the CLI. Positional arguments carry all
// paths; the script contains no interpolated commands, secrets, or user input.
const TERMINAL_BOOTSTRAP = `export TERM=xterm-256color COLORTERM=truecolor
exec "$@"`
const CLI_STATE_BOOTSTRAP = `export TERM=xterm-256color COLORTERM=truecolor
umask 077
base=$1
state=$2
shift 2
if [ -L "$base" ] || [ -L "$state" ] || [ -L "$base/.gitignore" ]; then
  printf 'DSH Terminal: refusing a symlinked CLI data directory\\n' >&2
  exit 1
fi
mkdir -p "$base" || exit 1
if [ ! -e "$base/.gitignore" ]; then
  ignore_tmp=$(mktemp "$base/.gitignore.XXXXXX") || exit 1
  printf '*\\n' > "$ignore_tmp" || exit 1
  ln "$ignore_tmp" "$base/.gitignore" 2>/dev/null || [ -f "$base/.gitignore" ] || exit 1
  rm -f "$ignore_tmp"
fi
if [ "$(cat "$base/.gitignore")" != '*' ]; then
  printf 'DSH Terminal: CLI data directory must be excluded from Git\\n' >&2
  exit 1
fi
mkdir -p "$state" || exit 1
chmod 700 "$base" "$state" || exit 1
exec "$@"`
const launchers = {
  shell: { label: 'Shell', command: process.platform === 'win32' ? 'pwsh' : 'zsh', args: process.platform === 'win32' ? ['-NoLogo'] : ['-f'] },
  codex: { label: 'Codex', command: 'codex', args: ['-c', 'cli_auth_credentials_store="file"'] },
  claude: { label: 'Claude Code', command: 'claude', args: [] },
}

/** Raw PTYs never enter DSH's conversation log or model context. */
export class NativeTerminals {
  constructor(ctx, effectiveMode, ptyCompatibility = localPtyCompatibility) {
    this.ctx = ctx
    this.effectiveMode = effectiveMode
    this.ptyCompatibility = ptyCompatibility
    this.owners = new Map()
    this.stopped = false
  }

  current(owner) {
    if (this.stopped || this.ctx.agents.get(owner.id) !== owner || this.owners.get(owner)?.disposed) {
      throw new Error('终端所属 DSH 会话已失效')
    }
  }

  owned(owner) {
    this.current(owner)
    let state = this.owners.get(owner)
    if (state) return state
    state = { entries: new Map(), opens: new Map(), disposed: false, detachers: [] }
    this.owners.set(owner, state)
    state.detachers.push(owner.ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const [session, event] = args
      if (session !== owner.session || event.type !== 'sandbox/mode') return
      const current = this.effectiveMode(session.events) ?? this.ctx.sandboxPolicy.defaultMode
      if (event.data.mode !== current && [...state.entries.values()].some(entry => !entry.settled)) {
        throw new Error('原生终端仍在创建、运行或清理；请先关闭终端再切换 sandbox 模式')
      }
    }, { global: true }))
    state.detachers.push(owner.ctx.effect(() => () => this.disposeOwner(owner, state), 'native terminals: owner cleanup'))
    return state
  }

  entry(owner, id) {
    const entry = this.owned(owner).entries.get(id)
    if (!entry || entry.dismissed) throw new Error('当前会话没有这个终端')
    return entry
  }

  summary(entry) {
    return { id: entry.id, launcher: entry.launcher, pid: entry.handle?.pid ?? null, state: entry.state,
      rows: entry.rows, cols: entry.cols, writer: entry.writer, exitCode: entry.exitCode ?? null }
  }

  async list(owner, request, signal) {
    requests.list.parse(request)
    signal?.throwIfAborted()
    const state = this.owned(owner)
    const available = await Promise.all(Object.entries(launchers).map(async ([id, item]) => {
      try { await this.ctx.subprocess.resolveExecutable(item.command, undefined, signal); return { id, label: item.label, available: true } }
      catch { return { id, label: item.label, available: false } }
    }))
    this.current(owner)
    return { terminals: [...state.entries.values()].filter(item => !item.dismissed).map(item => this.summary(item)),
      launchers: available, cwd: this.ctx.sandboxPolicy.resolve({ session: owner.session }).workspaceRoot }
  }

  async open(owner, request, signal) {
    const input = requests.open.parse(request)
    signal?.throwIfAborted()
    const state = this.owned(owner)
    const previous = state.opens.get(input.requestId)
    if (previous) {
      if (previous.launcher !== input.launcher) throw new Error('创建请求标识已被使用')
      return previous.result
    }
    if ([...state.entries.values()].filter(item => !item.dismissed).length >= 12) throw new Error('同一会话最多打开 12 个终端')
    if (state.opens.size >= 256) throw new Error('本会话已达到终端创建次数上限，请新建会话')
    const entry = { id: randomUUID(), launcher: input.launcher, rows: input.rows, cols: input.cols,
      writer: null, lease: null, sequence: 0, state: 'starting', settled: false,
      data: [], bytes: 0, baseOffset: 0, offset: 0, dismissed: false, controller: new AbortController() }
    state.entries.set(entry.id, entry) // Reserve before any await; sandbox changes must see pending allocation.
    const result = this.spawn(owner, entry, signal)
    state.opens.set(input.requestId, { launcher: input.launcher, result })
    return result
  }

  async spawn(owner, entry, requestSignal) {
    const signal = requestSignal ? AbortSignal.any([requestSignal, entry.controller.signal]) : entry.controller.signal
    try {
      await this.ptyCompatibility.assertProvider(this.ctx.subprocess)
      this.current(owner)
      signal.throwIfAborted()
      const launch = launchers[entry.launcher]
      const executable = await this.ctx.subprocess.resolveExecutable(launch.command, undefined, signal)
      this.current(owner)
      signal.throwIfAborted()
      const policy = this.ctx.sandboxPolicy.resolve({ session: owner.session })
      let argv = [executable, ...launch.args]
      const env = { TERM: 'xterm-256color', COLORTERM: 'truecolor', DSH_SESSION_ID: owner.id, DSH_PTY_SESSION_ID: entry.id }
      const shell = await this.ctx.subprocess.resolveExecutable('sh', undefined, signal)
      this.current(owner)
      signal.throwIfAborted()
      if (entry.launcher !== 'shell') {
        const base = join(policy.workspaceRoot, '.dsh-terminal')
        const state = join(base, entry.launcher)
        env[entry.launcher === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = state
        if (entry.launcher === 'codex') env.CODEX_SQLITE_HOME = state
        else env.DISABLE_AUTOUPDATER = '1'
        argv = [shell, '-c', CLI_STATE_BOOTSTRAP, 'dsh-terminal-launch', base, state, ...argv]
      } else argv = [shell, '-c', TERMINAL_BOOTSTRAP, 'dsh-terminal-launch', ...argv]
      if (policy.mode !== 'danger-full-access') {
        const sandbox = this.ctx.get('sandbox')
        if (!sandbox) throw new Error(`当前 ${policy.mode} 模式没有 sandbox provider，不能创建终端`)
        argv = sandbox.confine(argv, { ...policy, mode: policy.mode }).argv
      }
      if (!argv[0]) throw new Error('sandbox provider 返回了空启动命令')
      entry.handle = await this.ctx.subprocess.spawnTerminal({ argv, cwd: policy.workspaceRoot,
        env,
        rows: entry.rows, cols: entry.cols, graceMs: 600, signal })
      this.current(owner)
      signal.throwIfAborted()
      entry.handle = this.ptyCompatibility.adaptHandle(entry.handle)
      entry.state = 'running'
      entry.consume = this.consume(entry)
      entry.completion = entry.handle.done.then(async outcome => {
        entry.exitCode = outcome.exitCode ?? null
        await this.settle(entry)
      }, async () => { entry.state = 'error'; await this.settle(entry) })
      void entry.completion.catch(() => { entry.state = 'cleanup-error' })
      return this.summary(entry)
    } catch (error) {
      entry.state = 'error'
      await this.settle(entry)
      entry.dismissed = true
      this.owners.get(owner)?.entries.delete(entry.id)
      throw error
    }
  }

  append(entry, data) {
    if (!data) return
    // Character offsets cross JSON losslessly; retained memory is bounded in UTF-8 bytes.
    const bytes = Buffer.byteLength(data)
    entry.data.push({ start: entry.offset, text: data, bytes })
    entry.offset += data.length
    entry.bytes += bytes
    while ((entry.bytes > OUTPUT_BYTES || entry.data.length > 8192) && entry.data.length) {
      const removed = entry.data.shift()
      entry.bytes -= removed.bytes
      entry.baseOffset = removed.start + removed.text.length
    }
  }

  async consume(entry) {
    const decoder = new StringDecoder('utf8')
    try {
      for await (const data of entry.handle.output) this.append(entry, decoder.write(data))
      this.append(entry, decoder.end())
    } catch {
      entry.state = 'error'
      // Start cleanup without awaiting our own consumer from within it.
      void this.settle(entry).catch(() => { entry.state = 'cleanup-error' })
    }
  }

  async settle(entry) {
    if (entry.cleanup) return entry.cleanup
    entry.lease = null
    entry.writer = null
    if (entry.state !== 'error') entry.state = 'closing'
    entry.cleanup = (async () => {
      await entry.handle?.terminate()
      await entry.consume
      entry.settled = true
      entry.state = entry.state === 'error' ? 'error' : 'exited'
    })()
    try { await entry.cleanup }
    catch (error) {
      entry.cleanup = undefined
      entry.state = 'cleanup-error'
      throw error
    }
  }

  async read(owner, request, signal) {
    const input = requests.read.parse(request)
    signal?.throwIfAborted()
    const entry = this.entry(owner, input.terminalId)
    const gap = input.offset < entry.baseOffset || input.offset > entry.offset
    let data = ''
    if (!gap) {
      for (const chunk of entry.data) {
        if (chunk.start + chunk.text.length <= input.offset) continue
        data += chunk.text.slice(Math.max(0, input.offset - chunk.start), Math.max(0, input.offset - chunk.start) + READ_CHARS - data.length)
        if (data.length >= READ_CHARS) break
      }
    }
    // Preserve Unicode scalar pairs across bounded reads.
    if (data.length && /[\uD800-\uDBFF]/.test(data.at(-1))) data = data.slice(0, -1)
    return { data, nextOffset: gap ? input.offset : input.offset + data.length, baseOffset: entry.baseOffset,
      gap, state: entry.state, exitCode: entry.exitCode ?? null }
  }

  async claim(owner, request, signal) {
    const input = requests.claim.parse(request)
    signal?.throwIfAborted()
    const entry = this.entry(owner, input.terminalId)
    if (entry.state !== 'running' && entry.state !== 'cleanup-error') throw new Error('终端未在运行')
    if (entry.writer !== input.viewerId || !entry.lease) {
      entry.writer = input.viewerId
      entry.lease = randomUUID()
      entry.sequence = 0
    }
    return { lease: entry.lease, nextSequence: entry.sequence }
  }

  writable(owner, input) {
    const entry = this.entry(owner, input.terminalId)
    if (entry.state !== 'running') throw new Error('终端未在运行')
    if (!entry.lease || entry.lease !== input.lease) throw new Error('输入控制权已失效，请重新接管')
    return entry
  }

  async write(owner, request, signal) {
    const input = requests.write.parse(request)
    signal?.throwIfAborted()
    const entry = this.writable(owner, input)
    if (input.sequence !== entry.sequence) throw new Error('输入顺序不确定，已拒绝重复或过期按键，请重新接管')
    entry.sequence++ // Fence before write; an uncertain delivery is never automatically retried.
    await entry.handle.write(input.data)
    return { nextSequence: entry.sequence }
  }

  async resize(owner, request, signal) {
    const input = requests.resize.parse(request)
    signal?.throwIfAborted()
    const entry = this.writable(owner, input)
    await entry.handle.resize(input.rows, input.cols)
    entry.rows = input.rows
    entry.cols = input.cols
    return { rows: entry.rows, cols: entry.cols }
  }

  async close(owner, request, signal) {
    const input = requests.close.parse(request)
    signal?.throwIfAborted()
    const entry = this.entry(owner, input.terminalId)
    if (!entry.settled && (!entry.lease || entry.lease !== input.lease)) throw new Error('输入控制权已失效，请重新接管')
    await this.settle(entry)
    entry.dismissed = true
    entry.data = []
    entry.bytes = 0
    this.owners.get(owner)?.entries.delete(entry.id)
    return { closed: true }
  }

  async disposeOwner(owner, state) {
    state.disposed = true
    for (const entry of state.entries.values()) entry.controller.abort(new Error('DSH owner disposed'))
    // Allocation promises must settle before final process cleanup, including late handles.
    await Promise.allSettled([...state.opens.values()].map(item => item.result))
    const outcomes = await Promise.allSettled([...state.entries.values()].map(entry => this.settle(entry)))
    if (outcomes.some(result => result.status === 'rejected')) throw new Error('部分原生终端清理失败')
    this.owners.delete(owner)
  }

  async stop() {
    this.stopped = true
    const states = [...this.owners]
    const results = await Promise.allSettled(states.map(([owner, state]) => this.disposeOwner(owner, state)))
    const detached = await Promise.allSettled(states.flatMap(([, state]) => state.detachers.map(detach => Promise.resolve().then(() => detach?.()))))
    const errors = [...results, ...detached].filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, '原生终端停用时有资源未完成清理')
  }
}
