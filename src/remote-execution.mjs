import { readFile, realpath, stat, glob } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const CWD = /^\/[^\x00-\x1f\x7f]*$/
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const command = (script, args) => `exec "\${SHELL:-/bin/sh}" -lc ${quote(['sh', '-c', script, 'dsh-superterminal', ...args].map(quote).join(' '))}`
const reason = '远程连接未完成，请检查 SSH 别名、已信任的主机密钥及远端 tmux，然后重试。'
class RemoteExecutionError extends Error {}
export const remoteExecutionFailure = error => error instanceof RemoteExecutionError ? error : new RemoteExecutionError(reason)
const limits = { files: 64, bytes: 1024 * 1024, aliases: 256, depth: 8 }

// Parse configuration as data. In particular, never run ssh -G: Match exec may
// execute local commands even when the user is only opening the target picker.
function words(line) {
  const result = []; let word = '', quoted = null, started = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') { if (i + 1 < line.length) { word += line[++i]; started = true }; continue }
    if (quoted) { if (ch === quoted) quoted = null; else word += ch; started = true; continue }
    if (ch === '"' || ch === "'") { quoted = ch; started = true; continue }
    if (ch === '#') break
    if (/\s/.test(ch)) { if (started) { result.push(word); word = ''; started = false }; continue }
    word += ch; started = true
  }
  if (quoted) throw new RemoteExecutionError('SSH 配置中的引号不完整')
  if (started) result.push(word)
  return result
}
export async function readSshTargets({ configPath = join(homedir(), '.ssh/config'), home = homedir() } = {}) {
  const aliases = new Set(), seen = new Set(), hash = createHash('sha256'); let bytes = 0
  async function visit(file, depth) {
    if (depth > limits.depth) throw new RemoteExecutionError('SSH Include 层级过多')
    let canonical
    try { canonical = await realpath(file) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (seen.has(canonical)) return
    seen.add(canonical)
    const info = await stat(canonical)
    if (!info.isFile() || seen.size > limits.files || (bytes += info.size) > limits.bytes) throw new RemoteExecutionError('SSH 配置超过读取上限')
    const text = await readFile(canonical, 'utf8')
    if (text.includes('\0')) throw new RemoteExecutionError('SSH 配置不是文本文件')
    hash.update(canonical).update('\0').update(text).update('\0')
    for (const line of text.replace(/\\\r?\n/g, '').split(/\r?\n/)) {
      const tokens = words(line.replace(/^\s*([A-Za-z]+)\s*=\s*/, '$1 '))
      const key = tokens.shift()?.toLowerCase()
      if (key === 'host') {
        const excluded = tokens.filter(token => token.startsWith('!')).map(token => new RegExp(`^${token.slice(1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, 'i'))
        for (const alias of tokens) if (ALIAS.test(alias) && !excluded.some(pattern => pattern.test(alias))) aliases.add(alias)
        if (aliases.size > limits.aliases) throw new RemoteExecutionError('SSH 别名数量超过上限')
      } else if (key === 'include') {
        for (const pattern of tokens) {
          if (/[\x00-\x1f%$]/.test(pattern) || (pattern.startsWith('~') && !pattern.startsWith('~/'))) throw new RemoteExecutionError('SSH Include 路径暂不支持')
          const expanded = pattern.startsWith('~/') ? join(home, pattern.slice(2)) : isAbsolute(pattern) ? pattern : resolve(home, '.ssh', pattern)
          const matches = []
          for await (const path of glob(expanded)) { matches.push(path); if (matches.length > limits.files) throw new RemoteExecutionError('SSH Include 文件过多') }
          for (const path of matches.sort()) await visit(path, depth + 1)
        }
      }
    }
  }
  await visit(configPath, 0)
  return { targets: [...aliases].sort().map(id => ({ id, label: id })), fingerprint: hash.digest('hex') }
}

const CHECK = `set -eu
cwd=$1; marker=$2; shift 2
command -v tmux >/dev/null 2>&1 || exit 71
[ -n "$cwd" ] || cwd=$HOME
cd -- "$cwd" 2>/dev/null || exit 72
cwd=$(pwd -P)
printf '%s\\000%s\\000' "$marker" "$cwd"
for item do
  if [ "$item" = shell ]; then [ -x "\${SHELL:-/bin/sh}" ] && printf 'shell\\000'
  elif command -v "$item" >/dev/null 2>&1; then printf '%s\\000' "$item"; fi
done
printf '%s\\000' "$marker"`

// A unique, mode-0700 namespace also owns a small cancellation fence. A close
// racing a lost create reply acquires the same lock before acknowledging close;
// a late create observes the fence and cannot launch another command.
const BASE = `set -eu
namespace=$1; marker=$2
base="/tmp/dsh-st-$(id -u)-$namespace"
socket="$base/socket"; session=dsh
private_base() {
  if mkdir -m 700 "$base" 2>/dev/null; then :
  else
    [ -d "$base" ] && [ ! -L "$base" ] || exit 74
    metadata=$(LC_ALL=C stat -c '%u:%a' "$base" 2>/dev/null) || metadata=$(LC_ALL=C stat -f '%u:%Lp' "$base" 2>/dev/null) || exit 74
    [ "$metadata" = "$(id -u):700" ] || exit 74
    case "$(LC_ALL=C ls -ld "$base" | awk '{print $1}')" in *+) exit 74 ;; esac
  fi
  base=$(cd "$base" && pwd -P); socket="$base/socket"
}
lock_base() {
  trap '' HUP INT TERM
  count=0
  until mkdir "$base/lock" 2>/dev/null; do
    count=$((count + 1)); [ "$count" -lt 80 ] || exit 75
    sleep 0.1
  done
  trap 'rmdir "$base/lock" 2>/dev/null || :' EXIT
}
`
const CREATE = `${BASE}
cwd=$3; launcher=$4; rows=$5; cols=$6
private_base
lock_base
[ ! -f "$base/closed" ] || exit 76
cd -- "$cwd" 2>/dev/null || exit 72
command -v tmux >/dev/null 2>&1 || exit 71
if [ "$launcher" = shell ]; then
  program=\${SHELL:-/bin/sh}; [ -x "$program" ] || exit 73
  set -- "$program" -l
else
  program=$(command -v "$launcher") || exit 73
  set -- "$program"
fi
tmux -u -S "$socket" -f /dev/null new-session -d -s "$session" -c "$(pwd -P)" -x "$cols" -y "$rows" sh -c 'ready=$1; shift; until [ -f "$ready" ]; do sleep 0.05; done; exec "$@"' dsh-terminal "$base/ready" "$@" \\; set-option -t "$session" status off \\; set-window-option -t "$session:0" remain-on-exit on \\; set-hook -t "$session" pane-died 'detach-client -s dsh' \\; set-hook -t "$session" client-attached 'if-shell -F "#{pane_dead}" "detach-client -s dsh"' >/dev/null 2>&1
: > "$base/ready"
rmdir "$base/lock"
trap - EXIT HUP INT TERM
printf '%s\\000%s\\000' "$marker" "$(pwd -P)"`
const ATTACH = `${BASE}
[ -d "$base" ] && [ ! -f "$base/closed" ] || exit 76
base=$(cd "$base" && pwd -P); socket="$base/socket"
receipt="$base/attach-$marker"
trap 'rm -f "$receipt"' EXIT
tmux -u -S "$socket" has-session -t "=$session" 2>/dev/null || exit 77
if [ "$(tmux -u -S "$socket" display-message -p -t "$session:0.0" '#{pane_dead}')" = 1 ]; then
  printf '\\033[H\\033[2J'
  tmux -u -S "$socket" capture-pane -p -e -t "$session:0.0" -S -200
  exit 200
fi
# The attach command opens the client tty (including its raw-mode input flush)
# before the next command runs. A receipt from this exact client queue avoids
# accepting input while OpenSSH/tmux are still starting, or trusting PTY text.
tmux -u -S "$socket" attach-session -t "=$session" \\; run-shell "umask 077; test ! -f '$base/closed' && : > '$receipt'" || :
if [ "$(tmux -u -S "$socket" display-message -p -t "$session:0.0" '#{pane_dead}' 2>/dev/null)" = 1 ]; then
  printf '\\033[H\\033[2J'
  tmux -u -S "$socket" capture-pane -p -e -t "$session:0.0" -S -200
  exit 200
fi
exit 0`
const ATTACH_READY = `${BASE}
receipt="$base/attach-$marker"
count=0
while :; do
  [ -d "$base" ] && [ ! -f "$base/closed" ] || exit 76
  dead=$(tmux -u -S "$socket" display-message -p -t "$session:0.0" '#{pane_dead}' 2>/dev/null) || exit 77
  if [ "$dead" = 1 ]; then printf '%s\\000exited\\000' "$marker"; exit 0; fi
  if [ -f "$receipt" ] && [ ! -L "$receipt" ]; then printf '%s\\000ready\\000' "$marker"; exit 0; fi
  count=$((count + 1)); [ "$count" -lt 100 ] || exit 79
  sleep 0.1
done`
const CLOSE = `${BASE}
known=$3
private_base
lock_base
: > "$base/closed"
if [ -S "$socket" ]; then
  if tmux -u -S "$socket" has-session -t "=$session" 2>/dev/null; then tmux -u -S "$socket" kill-session -t "=$session"; fi
  count=0
  while [ -S "$socket" ]; do
    if names=$(LC_ALL=C tmux -u -S "$socket" list-sessions -F '#{session_name}' 2>&1); then
      if ! printf '%s\\n' "$names" | grep -Fx "$session" >/dev/null; then break; fi
    else
      case "$names" in
        "no server running on $socket") rm -f "$socket"; break ;;
      esac
    fi
    count=$((count + 1)); [ "$count" -lt 30 ] || exit 78
    sleep 0.1
  done
fi
rmdir "$base/lock"
trap - EXIT HUP INT TERM
rm -f "$base/ready"
shift 3
for attachment do rm -f "$base/attach-$attachment"; done
if [ "$known" = yes ] && [ ! -S "$socket" ]; then rm -f "$base/closed"; rmdir "$base" 2>/dev/null || :; fi
printf '%s\\000' "$marker"`

export class RemoteExecution {
  constructor(terminals, { configPath, home = homedir() } = {}) {
    this.terminals = terminals
    this.home = home
    this.configPath = configPath ?? join(home, '.ssh/config')
    this.jobs = new Map()
  }
  policy(owner) {
    this.terminals.current(owner)
    const policy = this.terminals.ctx.sandboxPolicy.resolve({ session: owner.session })
    if (policy.mode !== 'danger-full-access') throw new RemoteExecutionError('远程终端需要当前会话使用完全访问权限；本地沙箱无法约束远端。')
    return policy
  }
  hasActive(owner) { return (this.jobs.get(owner)?.size ?? 0) > 0 }
  async targets(owner, signal) {
    this.terminals.current(owner); signal?.throwIfAborted()
    try {
      this.policy(owner)
      await this.terminals.ptyCompatibility.assertProvider(this.terminals.ctx.subprocess)
      const { targets } = await readSshTargets(this)
      await this.terminals.ctx.subprocess.resolveExecutable('ssh', undefined, signal)
      this.terminals.current(owner); signal?.throwIfAborted()
      return { targets, available: targets.length > 0, ...(targets.length ? {} : { reason: '请先在 SSH 配置中添加明确的主机别名。' }) }
    } catch (error) {
      signal?.throwIfAborted(); this.terminals.current(owner)
      return { targets: [], available: false, reason: error.message.startsWith('远程终端需要') ? error.message : '本机 SSH 或主机别名配置暂不可用。' }
    }
  }
  async connection(owner, targetId, signal) {
    this.policy(owner)
    await this.terminals.ptyCompatibility.assertProvider(this.terminals.ctx.subprocess)
    let config
    try { config = await readSshTargets(this) } catch { throw new RemoteExecutionError('SSH 主机别名配置暂不可用。') }
    if (!ALIAS.test(targetId) || !config.targets.some(target => target.id === targetId)) throw new RemoteExecutionError('请选择 SSH 配置中已有的明确主机别名。')
    let executable, shell
    try {
      executable = await this.terminals.ctx.subprocess.resolveExecutable('ssh', undefined, signal)
      shell = await this.terminals.ctx.subprocess.resolveExecutable('sh', undefined, signal)
    } catch { throw new RemoteExecutionError('本机 OpenSSH 暂不可用。') }
    this.policy(owner); signal?.throwIfAborted()
    return { targetId, label: targetId, executable, shell, fingerprint: config.fingerprint }
  }
  argv(connection, script, args, terminal = false) {
    return [connection.executable, '-F', this.configPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'PermitLocalCommand=no', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-o', 'UpdateHostKeys=no', '-o', 'ForwardX11=no', '-o', 'EscapeChar=none',
      '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
      '-o', 'NumberOfPasswordPrompts=0', '-o', 'RequestTTY=no', ...(terminal ? ['-tt'] : ['-T']), '--', connection.targetId, command(script, args)]
  }
  async verifyConnection(connection) {
    let config
    try { config = await readSshTargets(this) } catch { throw new RemoteExecutionError('SSH 主机别名配置暂不可用，无法核对原连接。') }
    if (config.fingerprint !== connection.fingerprint || !config.targets.some(target => target.id === connection.targetId)) throw new RemoteExecutionError('SSH 配置已改变；请恢复原主机配置后重连或关闭这个终端。')
  }
  async drainFailed(owner) {
    const jobs = this.jobs.get(owner)
    for (const job of [...jobs ?? []]) if (job.cleanupFailed) {
      try {
        job.handle?.terminate()
        if (job.handle && !await job.handle.waitForExit(AbortSignal.timeout(10000))) throw new RemoteExecutionError(reason)
      } catch { throw new RemoteExecutionError('SSH 传输仍在清理，请重试关闭。') }
      jobs.delete(job)
    }
    if (jobs && !jobs.size && this.jobs.get(owner) === jobs) this.jobs.delete(owner)
  }
  async control(owner, connection, script, args, signal, cleanup = false) {
    await this.drainFailed(owner)
    if (!cleanup) this.policy(owner)
    const controller = new AbortController(), combined = AbortSignal.any([controller.signal, AbortSignal.timeout(20000), ...(signal ? [signal] : [])])
    let jobs = this.jobs.get(owner)
    if (!jobs) this.jobs.set(owner, jobs = new Set())
    if (!cleanup && jobs.size >= 4) throw new RemoteExecutionError('正在处理远程连接，请稍候重试。')
    const job = { controller, cleanup, handle: null, done: null }; jobs.add(job)
    job.done = (async () => {
      combined.throwIfAborted()
      job.handle = this.terminals.ctx.subprocess.spawn({ argv: this.argv(connection, script, args), cwd: this.home,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 4096 } }, graceMs: 600, signal: combined })
      const outcome = await job.handle.done
      combined.throwIfAborted()
      const output = job.handle.collected?.stdout?.readFrom(0)
      if (outcome.exitCode !== 0 || !output || output.lossy) {
        const messages = { 71: '远端未安装 tmux。', 72: '远端工作目录不存在或不可访问。', 73: '远端未找到所选智能体。', 76: '这个远程任务已关闭，不能重新创建。', 77: '远端会话已不存在，无法重新接入。' }
        throw new RemoteExecutionError(messages[outcome.exitCode] ?? reason)
      }
      return output.text
    })()
    try { return await job.done }
    catch (error) {
      if (error instanceof RemoteExecutionError) throw error
      throw new RemoteExecutionError(combined.aborted ? '远程操作已取消或超时，请重新检查连接。' : reason)
    } finally {
      if (job.handle) {
        try {
          job.handle.terminate()
          if (!await job.handle.waitForExit(AbortSignal.timeout(10000))) throw new RemoteExecutionError('SSH 传输仍在清理，请重试关闭。')
        } catch { job.cleanupFailed = true; throw new RemoteExecutionError('SSH 传输仍在清理，请重试关闭。') }
      }
      jobs.delete(job)
      if (!jobs.size && this.jobs.get(owner) === jobs) this.jobs.delete(owner)
    }
  }
  async check(owner, input, signal) {
    const connection = await this.connection(owner, input.targetId, signal)
    const catalog = this.terminals.launcherCatalog(), marker = randomUUID()
    let cwd = input.cwd ?? '', available = false, failure
    try {
      const output = await this.control(owner, connection, CHECK, [cwd, marker, ...catalog.map(item => item.id)], signal)
      const fields = output.slice(output.indexOf(`${marker}\0`)).split('\0')
      if (fields[0] !== marker || fields.at(-2) !== marker || !CWD.test(fields[1]) || fields[1].length > 2048) throw new RemoteExecutionError(reason)
      cwd = fields[1]; available = true
      const installed = new Set(fields.slice(2, -2))
      this.policy(owner); signal?.throwIfAborted()
      return { targetId: connection.targetId, label: connection.label, cwd, checkedAt: Date.now(), available,
        launchers: catalog.map(item => ({ ...item, available: installed.has(item.id) })) }
    } catch (error) { this.terminals.current(owner); signal?.throwIfAborted(); failure = error.message }
    return { targetId: connection.targetId, label: connection.label, cwd, checkedAt: Date.now(), available, reason: failure,
      launchers: catalog.map(item => ({ ...item, available: false })) }
  }
  async create(owner, entry, input, signal) {
    const connection = await this.connection(owner, input.targetId, signal)
    if (!this.terminals.launcherCatalog().some(item => item.id === entry.launcher)) throw new RemoteExecutionError('请选择远程检查列表中的智能体。')
    entry.remote = { ...connection, namespace: randomUUID().replaceAll('-', ''), attempted: false, created: false, closed: false, owner }
    entry.execution = { kind: 'ssh', label: connection.label, targetId: connection.targetId, cwd: input.cwd }
    const marker = randomUUID()
    signal.throwIfAborted(); this.policy(owner)
    entry.remote.attempted = true
    const output = await this.control(owner, connection, CREATE, [entry.remote.namespace, marker, input.cwd, entry.launcher, String(entry.rows), String(entry.cols)], signal)
    const fields = output.slice(output.indexOf(`${marker}\0`)).split('\0')
    if (fields[0] !== marker || fields.length !== 3 || !CWD.test(fields[1]) || fields[1].length > 2048) throw new RemoteExecutionError(reason)
    entry.execution.cwd = fields[1]
    entry.remote.created = true
    signal.throwIfAborted(); this.policy(owner)
    return this.attach(owner, entry, signal)
  }
  async attach(owner, entry, signal) {
    this.policy(owner); signal?.throwIfAborted()
    await this.verifyConnection(entry.remote)
    this.policy(owner); signal?.throwIfAborted()
    if (entry.remote.closed) throw new RemoteExecutionError('这个远程终端已关闭。')
    const attachment = randomUUID()
    entry.remote.attachments ??= []
    entry.remote.attachments.push(attachment)
    const sshArgv = this.argv(entry.remote, ATTACH, [entry.remote.namespace, attachment], true)
    const handle = await this.terminals.ctx.subprocess.spawnTerminal({ argv: [entry.remote.shell, '-c',
      'export TERM=xterm-256color COLORTERM=truecolor; exec "$@"', 'dsh-remote-transport', ...sshArgv],
      cwd: this.home, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, rows: entry.rows, cols: entry.cols, graceMs: 600, signal })
    // Retain the raw handle before adapting so every failed adapter/allocation
    // still participates in the owner's cleanup boundary.
    entry.handle = handle
    entry.transportCleanup = undefined
    this.policy(owner); signal?.throwIfAborted()
    entry.handle = this.terminals.ptyCompatibility.adaptHandle(handle)
    this.terminals.watchRemote(entry, false)
    const readiness = new AbortController()
    // A dead remote task still needs its final screen captured by ATTACH. A
    // broken transport cancels the readiness check instead of enabling input.
    void entry.handle.done.then(outcome => { if (outcome.exitCode !== 200) readiness.abort() }, () => readiness.abort())
    const combined = AbortSignal.any([readiness.signal, ...(signal ? [signal] : [])])
    const result = await this.control(owner, entry.remote, ATTACH_READY, [entry.remote.namespace, attachment], combined)
    this.policy(owner); signal?.throwIfAborted()
    if (result === `${attachment}\0exited\0`) {
      await Promise.race([entry.completion, new Promise((_, reject) => {
        const timeout = setTimeout(() => reject(new RemoteExecutionError(reason)), 10000)
        void entry.completion.finally(() => clearTimeout(timeout)).catch(() => {})
      })])
      if (entry.state !== 'exited') throw new RemoteExecutionError(reason)
    } else if (result === `${attachment}\0ready\0` && ['starting', 'reconnecting', 'exited'].includes(entry.state)) {
      if (entry.state !== 'exited') entry.state = 'running'
    } else throw new RemoteExecutionError(reason)
    return entry.handle
  }
  async close(entry) {
    const remote = entry.remote
    if (!remote?.attempted || remote.closed) return
    await this.verifyConnection(remote)
    const marker = randomUUID()
    const output = await this.control(remote.owner, remote, CLOSE, [remote.namespace, marker, remote.created ? 'yes' : 'no', ...remote.attachments ?? []], undefined, true)
    if (!output.endsWith(`${marker}\0`)) throw new RemoteExecutionError('远程任务关闭结果未确认，请重试关闭。')
    remote.closed = true
  }
  async disposeOwner(owner) {
    const jobs = [...this.jobs.get(owner) ?? []]
    for (const job of jobs) if (!job.cleanup) job.controller.abort()
    await Promise.allSettled(jobs.map(job => job.done))
    for (const job of jobs) {
      if (job.handle) { job.handle.terminate(); if (!await job.handle.waitForExit(AbortSignal.timeout(10000))) throw new RemoteExecutionError('SSH 传输清理尚未完成。') }
      this.jobs.get(owner)?.delete(job)
    }
    if (this.jobs.get(owner)?.size === 0) this.jobs.delete(owner)
  }
}
