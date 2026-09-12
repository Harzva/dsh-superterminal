import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { NativeTerminals } from '../src/terminals.mjs'
import { readSshTargets } from '../src/remote-execution.mjs'
import { requests } from '../src/remote.mjs'

function tokens(text) {
  const result = []; let value = '', quoted = null, active = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && quoted !== "'") { value += text[++i]; active = true; continue }
    if (quoted) { if (ch === quoted) quoted = null; else value += ch; active = true; continue }
    if (ch === '"' || ch === "'") { quoted = ch; active = true; continue }
    if (/\s/.test(ch)) { if (active) { result.push(value); value = ''; active = false }; continue }
    value += ch; active = true
  }
  if (active) result.push(value)
  return result
}
const protocol = argv => { const inner = tokens(tokens(argv.at(-1)).at(-1)); return { script: inner[2], args: inner.slice(4) } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t, { mode = 'danger-full-access' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-remote-unit-'))
  await mkdir(join(home, '.ssh'))
  const configPath = join(home, '.ssh/config')
  await writeFile(configPath, 'Host work\n  HostName example.invalid\n')
  const agents = new Map(), effects = [], hooks = [], specs = [], handles = [], controls = [], sessions = new Set(), closed = new Set()
  const owner = { id: 'owner', session: { events: [] }, ctx: { on(_event, callback) { hooks.push(callback); return () => {} }, effect(factory) { const dispose = factory(); effects.push(dispose); return dispose } } }
  agents.set(owner.id, owner)
  const f = { home, configPath, agents, effects, hooks, specs, handles, controls, sessions, closed, owner, closeFails: false, checkFails: false, attachGate: null, cleanupFails: false }
  const ctx = { agents, get: () => undefined, sandboxPolicy: { defaultMode: mode, resolve: () => ({ mode, workspaceRoot: '/local/work' }) }, subprocess: {
    async resolveExecutable(name) { return `/system/${name}` },
    spawn(spec) {
      controls.push(spec)
      const { script, args } = protocol(spec.argv), done = Promise.withResolvers()
      let stdout = '', exitCode = 0
      if (script.includes('for item do')) {
        if (f.checkFails) exitCode = 71
        else stdout = `${args[1]}\0/remote/physical\0shell\0codex\0${args[1]}\0`
      } else if (script.includes('new-session -d')) {
        if (closed.has(args[0])) exitCode = 76
        else { sessions.add(args[0]); stdout = `${args[1]}\0/remote/physical\0` }
      } else if (script.includes(': > "$base/closed"')) {
        if (f.closeFails) exitCode = 255
        else { closed.add(args[0]); sessions.delete(args[0]); stdout = `${args[1]}\0` }
      } else if (script.includes('receipt="$base/attach-$marker"')) {
        if (f.readyFails) exitCode = 79
        else stdout = `${f.wrongReadyToken ?? args[1]}\0${f.readyStatus ?? 'ready'}\0`
      } else throw new Error('unexpected control protocol')
      const handle = { done: done.promise, collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false }) } },
        terminate() {}, async waitForExit() { return !f.cleanupFails } }
      const gate = script.includes('receipt="$base/attach-$marker"') ? f.readyGate : f.controlGate
      if (gate) {
        void gate.then(() => done.resolve({ exitCode, signal: null }))
        spec.signal.addEventListener('abort', () => done.resolve({ exitCode: 255, signal: 'SIGTERM' }), { once: true })
      } else done.resolve({ exitCode, signal: null })
      return handle
    },
    async spawnTerminal(spec) {
      specs.push(spec)
      await f.attachGate
      const finished = Promise.withResolvers(), output = new PassThrough()
      const handle = { pid: 100 + handles.length, spec, output, done: finished.promise, writes: [], resizes: [], terminated: false,
        async write(data) { this.writes.push(data) }, async resize(rows, cols) { this.resizes.push([rows, cols]) },
        finish(code) { output.end(); finished.resolve({ exitCode: code }) },
        async terminate() { this.terminated = true; this.finish(0) } }
      handles.push(handle)
      return handle
    },
  } }
  f.service = new NativeTerminals(ctx, () => undefined, { assertProvider() {}, adaptHandle: handle => {
    if (f.badAdapter) throw new Error(`provider failed at private ${home}`)
    return handle
  } }, {}, { configPath, home })
  t.after(async () => { f.closeFails = false; f.cleanupFails = false; f.attachGate = null; await f.service.stop().catch(() => {}); await rm(home, { recursive: true, force: true }) })
  return f
}
const open = (f, extra = {}) => f.service.open(f.owner, { launcher: 'shell', requestId: 'open-1', rows: 24, cols: 80, remote: { targetId: 'work', cwd: '/remote/work' }, ...extra })
const claim = (f, terminal, viewerId = 'viewer') => f.service.claim(f.owner, { terminalId: terminal.id, viewerId })
const close = async (f, terminal) => { const lease = await claim(f, terminal); return f.service.close(f.owner, { terminalId: terminal.id, lease: lease.lease }) }

test('SSH target listing parses explicit Host/Include as data, ignores wildcards and never connects', async t => {
  const f = await fixture(t)
  await mkdir(join(f.home, '.ssh/includes'))
  await writeFile(join(f.home, '.ssh/includes/other'), 'Host second !excluded * wildcard-*\n Match exec "must-not-run"\n')
  await writeFile(f.configPath, 'Host=work alias-2\nInclude includes/*\nInclude config\nHost "quoted-host"\nHost forbidden !forb*\n')
  const result = await f.service.remoteTargets(f.owner, {})
  assert.deepEqual(result.targets.map(item => item.id), ['alias-2', 'quoted-host', 'second', 'work'])
  assert.equal(result.available, true)
  assert.equal(f.controls.length + f.specs.length, 0)
  const original = await readSshTargets({ home: f.home, configPath: f.configPath })
  await writeFile(join(f.home, '.ssh/includes/other'), 'Host changed\n')
  assert.notEqual((await readSshTargets({ home: f.home, configPath: f.configPath })).fingerprint, original.fingerprint)
})

test('malformed/oversized SSH includes fail closed without leaking machine paths', async t => {
  const f = await fixture(t)
  await writeFile(f.configPath, 'Include ${PRIVATE_PATH}\nHost work\n')
  const result = await f.service.remoteTargets(f.owner, {})
  assert.equal(result.available, false)
  assert.equal(JSON.stringify(result).includes(f.home), false)
  await assert.rejects(f.service.remoteCheck(f.owner, { targetId: 'work' }), error => !error.message.includes(f.home))
  await writeFile(f.configPath, 'Host work\n' + ' '.repeat(1024 * 1024))
  assert.equal((await f.service.remoteTargets(f.owner, {})).available, false)
})

test('remote requires explicit full access before networking; arbitrary hosts and cwd controls are rejected', async t => {
  const f = await fixture(t, { mode: 'workspace-write' })
  assert.match((await f.service.remoteTargets(f.owner, {})).reason, /完全访问/)
  await assert.rejects(open(f), /完全访问/)
  await assert.rejects(f.service.remoteCheck(f.owner, { targetId: 'work' }), /完全访问/)
  assert.equal(f.controls.length + f.specs.length, 0)
  assert.equal(requests.open.safeParse({ launcher: 'shell', requestId: 'x', rows: 24, cols: 80, remote: { targetId: '-evil', cwd: '/tmp' } }).success, false)
  assert.equal(requests.remoteCheck.safeParse({ targetId: 'work', cwd: '/tmp\nattack' }).success, false)
  const other = await fixture(t)
  await assert.rejects(open(other, { remote: { targetId: 'invented', cwd: '/tmp' } }))
  assert.equal(other.controls.length + other.specs.length, 0)
})

test('explicit check uses the same remote login environment as launch and only reports measured CLI availability', async t => {
  const f = await fixture(t)
  const result = await f.service.remoteCheck(f.owner, { targetId: 'work' })
  assert.equal(result.cwd, '/remote/physical')
  assert.equal(result.available, true)
  assert.deepEqual(result.launchers.filter(item => item.available).map(item => item.id), ['shell', 'codex'])
  assert.ok(result.checkedAt > 0)
  const spec = f.controls[0]
  assert.match(spec.argv.at(-1), /exec "\$\{SHELL:-\/bin\/sh\}" -lc/)
  assert.ok(spec.argv.includes('StrictHostKeyChecking=yes'))
  assert.ok(spec.argv.includes('BatchMode=yes'))
  assert.ok(spec.argv.includes('ForwardAgent=no'))
  assert.ok(spec.argv.includes('PermitLocalCommand=no'))
  assert.ok(spec.argv.includes('UpdateHostKeys=no'))
  assert.ok(spec.argv.includes('ControlPath=none'))
  assert.equal(protocol(spec.argv).script.includes('mkdir'), false)
  f.checkFails = true
  const failed = await f.service.remoteCheck(f.owner, { targetId: 'work' })
  assert.equal(failed.available, false)
  assert.match(failed.reason, /tmux/)
  assert.ok(failed.launchers.every(item => !item.available))
})

test('open binds the whole payload, confirms physical cwd and never applies local CLI state or shell integration', async t => {
  const f = await fixture(t)
  const [a, b] = await Promise.all([open(f), open(f)])
  assert.equal(a.id, b.id)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.handles.length, 1)
  assert.deepEqual(a.execution, { kind: 'ssh', label: 'work', targetId: 'work', cwd: '/remote/physical' })
  assert.equal(a.pid, null)
  const entry = f.service.entry(f.owner, a.id)
  assert.equal(entry.shellIntegration, undefined)
  assert.equal(entry.commands, undefined)
  assert.equal(f.specs[0].env.CODEX_HOME, undefined)
  assert.equal(f.specs[0].env.DSH_SESSION_ID, undefined)
  assert.deepEqual(f.specs[0].argv.slice(0, 2), ['/system/sh', '-c'])
  assert.match(f.specs[0].argv[2], /export TERM=xterm-256color/)
  assert.match(protocol(f.specs[0].argv).script, /attach-session/)
  assert.doesNotMatch(protocol(f.specs[0].argv).script, /new-session/)
  const creation = f.controls.map(spec => protocol(spec.argv)).find(item => item.script.includes('new-session -d')).script
  assert.ok(creation.indexOf("trap '' HUP INT TERM") < creation.indexOf('until mkdir "$base/lock"'))
  assert.ok(creation.indexOf("trap 'rmdir") > creation.indexOf('until mkdir "$base/lock"'))
  await assert.rejects(open(f, { remote: { targetId: 'work', cwd: '/other' } }), /标识/)
  await assert.rejects(open(f, { launcher: 'codex' }), /标识/)
  assert.equal(f.handles.length, 1)
  const snap = f.service.supervisionSnapshot({ sessionId: f.owner.id })
  assert.deepEqual(snap.terminals[0].execution, a.execution)
})

test('quoted remote cwd stays one positional argument and never becomes a remote shell program', async t => {
  const f = await fixture(t), cwd = "/remote/a'$(touch BAD); space"
  await open(f, { remote: { targetId: 'work', cwd } })
  const creation = f.controls.map(spec => protocol(spec.argv)).find(item => item.script.includes('new-session -d'))
  assert.equal(creation.args[2], cwd)
  assert.equal(creation.script.includes('touch BAD'), false)
})

test('transport loss keeps output and remote task; reconnect attaches once and fences old input', async t => {
  const f = await fixture(t), terminal = await open(f), writer = await claim(f, terminal)
  f.handles[0].output.write('before disconnect\n')
  await tick()
  await f.service.write(f.owner, { terminalId: terminal.id, lease: writer.lease, sequence: 0, data: 'sent-once' })
  f.handles[0].finish(255)
  await tick()
  const disconnected = (await f.service.list(f.owner, {})).terminals[0]
  assert.equal(disconnected.state, 'disconnected')
  assert.equal(f.sessions.size, 1)
  await assert.rejects(f.service.write(f.owner, { terminalId: terminal.id, lease: writer.lease, sequence: 1, data: 'never-replay' }), /未在运行/)
  const request = { terminalId: terminal.id, requestId: 'reconnect-1' }
  const [a, b] = await Promise.all([f.service.remoteReconnect(f.owner, request), f.service.remoteReconnect(f.owner, request)])
  assert.equal(a.id, b.id)
  assert.equal(a.id, terminal.id)
  assert.equal(f.handles.length, 2)
  assert.equal(f.controls.filter(spec => protocol(spec.argv).script.includes('new-session -d')).length, 1)
  assert.deepEqual(f.handles[1].writes, [])
  f.handles[1].output.write('after reconnect\n')
  await tick()
  assert.equal((await f.service.read(f.owner, { terminalId: terminal.id, offset: 0 })).data, 'before disconnect\nafter reconnect\n')
  const current = await claim(f, terminal)
  assert.notEqual(current.lease, writer.lease)
  await f.service.resize(f.owner, { terminalId: terminal.id, lease: current.lease, rows: 36, cols: 120 })
  assert.deepEqual(f.handles[1].resizes, [[36, 120]])
  await close(f, terminal)
  assert.equal(f.sessions.size, 0)
})

test('remote process completion comes only from the attach protocol, not output or SSH disconnect', async t => {
  const f = await fixture(t), terminal = await open(f)
  f.handles[0].output.write('exit 0\n[finished]\n')
  await tick()
  assert.equal(f.service.entry(f.owner, terminal.id).state, 'running')
  f.handles[0].finish(200)
  await tick()
  assert.equal(f.service.entry(f.owner, terminal.id).state, 'exited')
  assert.equal(f.service.summary(f.service.entry(f.owner, terminal.id)).exitCode, null)
  await assert.rejects(f.service.remoteReconnect(f.owner, { terminalId: terminal.id, requestId: 'ended' }))
  await f.service.close(f.owner, { terminalId: terminal.id, lease: 'dismiss-exited' })
})

test('open and reconnect remain unwritable until this attachment confirms readiness', async t => {
  const f = await fixture(t), firstGate = Promise.withResolvers()
  f.readyGate = firstGate.promise
  let resolved = false
  const opening = open(f).then(value => { resolved = true; return value })
  while (!f.controls.some(spec => protocol(spec.argv).script.includes('receipt="$base/attach-$marker"'))) await tick()
  const entry = [...f.service.owners.get(f.owner).entries.values()][0]
  assert.equal(entry.state, 'starting'); assert.equal(resolved, false)
  f.handles[0].output.write('screen while connecting\n'); await tick()
  assert.equal((await f.service.read(f.owner, { terminalId: entry.id, offset: 0 })).data, 'screen while connecting\n')
  await assert.rejects(f.service.claim(f.owner, { terminalId: entry.id, viewerId: 'early' }), /未在运行/)
  await assert.rejects(f.service.write(f.owner, { terminalId: entry.id, lease: 'early', sequence: 0, data: 'do not queue' }), /未在运行/)
  firstGate.resolve(); const terminal = await opening, writer = await claim(f, terminal)
  await f.service.write(f.owner, { terminalId: terminal.id, lease: writer.lease, sequence: 0, data: 'first command' })
  assert.deepEqual(f.handles[0].writes, ['first command'])
  f.handles[0].finish(255); await tick()
  const secondGate = Promise.withResolvers(); f.readyGate = secondGate.promise
  const reconnecting = f.service.remoteReconnect(f.owner, { terminalId: terminal.id, requestId: 'delayed-reconnect' })
  while (f.handles.length < 2) await tick()
  assert.equal(entry.state, 'reconnecting')
  await assert.rejects(f.service.write(f.owner, { terminalId: terminal.id, lease: writer.lease, sequence: 1, data: 'never replay' }), /未在运行/)
  secondGate.resolve(); assert.equal((await reconnecting).state, 'running')
  assert.deepEqual(f.handles[1].writes, [])
  const probes = f.controls.map(spec => protocol(spec.argv)).filter(item => item.script.includes('receipt="$base/attach-$marker"'))
  assert.notEqual(probes[0].args[1], probes[1].args[1])
})

test('wrong or timed-out attach readiness cannot enable input; reconnect retries without re-execution', async t => {
  const f = await fixture(t)
  f.wrongReadyToken = 'previous-attachment'
  await assert.rejects(open(f))
  assert.equal(f.handles[0].terminated, true); assert.equal(f.sessions.size, 0)
  f.wrongReadyToken = undefined
  const terminal = await open(f, { requestId: 'second-open' })
  f.handles.at(-1).finish(255); await tick()
  f.readyFails = true
  const request = { terminalId: terminal.id, requestId: 'retry-ready' }
  await assert.rejects(f.service.remoteReconnect(f.owner, request))
  assert.equal(f.service.entry(f.owner, terminal.id).state, 'disconnected')
  assert.equal(f.handles.at(-1).terminated, true)
  assert.equal(f.sessions.size, 1)
  f.readyFails = false
  assert.equal((await f.service.remoteReconnect(f.owner, request)).state, 'running')
  assert.deepEqual(f.handles.at(-1).writes, [])
  assert.equal(f.controls.filter(spec => protocol(spec.argv).script.includes('new-session -d')).length, 2)
})

test('transport loss during readiness rejects open and closes only its owned task', async t => {
  const f = await fixture(t), gate = Promise.withResolvers()
  f.readyGate = gate.promise
  const pending = open(f), rejected = assert.rejects(pending)
  while (!f.controls.some(spec => protocol(spec.argv).script.includes('receipt="$base/attach-$marker"'))) await tick()
  f.handles[0].finish(255)
  await rejected
  assert.equal(f.sessions.size, 0)
  assert.equal(f.handles[0].terminated, true)
  gate.resolve()
})

test('owner disposal during readiness cancels the control and closes the same attachment receipt', async t => {
  const f = await fixture(t), gate = Promise.withResolvers()
  f.readyGate = gate.promise
  const pending = open(f), rejected = assert.rejects(pending)
  while (!f.controls.some(spec => protocol(spec.argv).script.includes('receipt="$base/attach-$marker"'))) await tick()
  const readiness = f.controls.map(spec => protocol(spec.argv)).find(item => item.script.includes('receipt="$base/attach-$marker"'))
  await f.service.disposeOwner(f.owner, f.service.owners.get(f.owner)); await rejected
  assert.equal(f.handles[0].terminated, true); assert.equal(f.sessions.size, 0)
  assert.equal(f.service.owners.has(f.owner), false)
  const cleanup = f.controls.map(spec => protocol(spec.argv)).find(item => item.script.includes(': > "$base/closed"'))
  assert.equal(cleanup.args[0], readiness.args[0])
  assert.ok(cleanup.args.slice(3).includes(readiness.args[1]))
  gate.resolve()
})

test('a task that exits before readiness returns its final screen and exited state', async t => {
  const f = await fixture(t), gate = Promise.withResolvers()
  f.readyGate = gate.promise; f.readyStatus = 'exited'
  const pending = open(f)
  while (!f.controls.some(spec => protocol(spec.argv).script.includes('receipt="$base/attach-$marker"'))) await tick()
  f.handles[0].output.write('early task error\n'); f.handles[0].finish(200)
  gate.resolve(); const terminal = await pending
  assert.equal(terminal.state, 'exited')
  assert.equal((await f.service.read(f.owner, { terminalId: terminal.id, offset: 0 })).data, 'early task error\n')
  await f.service.close(f.owner, { terminalId: terminal.id, lease: 'dismiss-exited' })
})

test('a drained failed reconnect can retry the same receipt without re-execution or leaked late handles', async t => {
  const f = await fixture(t), terminal = await open(f)
  f.handles[0].finish(255); await tick()
  f.badAdapter = true
  const request = { terminalId: terminal.id, requestId: 'retry-same' }
  await assert.rejects(f.service.remoteReconnect(f.owner, request), error => !error.message.includes(f.home))
  assert.equal(f.handles[1].terminated, true)
  assert.equal(f.service.entry(f.owner, terminal.id).state, 'disconnected')
  f.badAdapter = false
  const resumed = await f.service.remoteReconnect(f.owner, request)
  assert.equal(resumed.state, 'running')
  assert.equal(resumed.id, terminal.id)
  assert.equal(f.handles.length, 3)
  assert.equal(f.controls.filter(spec => protocol(spec.argv).script.includes('new-session -d')).length, 1)
})

test('pending remote checks fence sandbox changes and owner disposal cancels their local SSH jobs', async t => {
  const f = await fixture(t), gate = Promise.withResolvers()
  f.controlGate = gate.promise
  const pending = f.service.remoteCheck(f.owner, { targetId: 'work' })
  const rejected = assert.rejects(pending)
  while (!f.controls.length) await tick()
  assert.equal(f.service.remoteExecution.hasActive(f.owner), true)
  assert.throws(() => f.hooks[0]('emit', 'session/event', [f.owner.session, { type: 'sandbox/mode', data: { mode: 'read-only' } }]), /sandbox/)
  await f.service.disposeOwner(f.owner, f.service.owners.get(f.owner))
  await rejected
  gate.resolve()
  assert.equal(f.service.remoteExecution.hasActive(f.owner), false)
})

test('an unproven SSH cleanup stays tracked and the next explicit check drains it before starting another job', async t => {
  const f = await fixture(t)
  f.cleanupFails = true
  const failed = await f.service.remoteCheck(f.owner, { targetId: 'work' })
  assert.equal(failed.available, false)
  assert.equal(f.service.remoteExecution.hasActive(f.owner), true)
  const count = f.controls.length
  const stillFailed = await f.service.remoteCheck(f.owner, { targetId: 'work' })
  assert.equal(stillFailed.available, false)
  assert.equal(f.controls.length, count)
  f.cleanupFails = false
  assert.equal((await f.service.remoteCheck(f.owner, { targetId: 'work' })).available, true)
  assert.equal(f.service.remoteExecution.hasActive(f.owner), false)
})

test('failed close retains a reclaimable cleanup-error and retry only closes that owned namespace', async t => {
  const f = await fixture(t), first = await open(f), second = await open(f, { requestId: 'open-2' })
  f.closeFails = true
  await assert.rejects(close(f, first))
  assert.equal(f.service.entry(f.owner, first.id).state, 'cleanup-error')
  assert.equal(f.sessions.size, 2)
  f.closeFails = false
  await close(f, first)
  assert.equal(f.sessions.size, 1)
  assert.equal(f.service.entry(f.owner, second.id).state, 'running')
  const closes = f.controls.map(spec => protocol(spec.argv)).filter(item => item.script.includes(': > "$base/closed"'))
  assert.equal(new Set(closes.map(item => item.args[0])).size, 1)
})

test('configuration changes cannot silently redirect reconnect or cleanup, and errors omit raw config paths', async t => {
  const f = await fixture(t), terminal = await open(f)
  f.handles[0].finish(255); await tick()
  await writeFile(f.configPath, 'Host work\n  HostName changed.invalid\n')
  await assert.rejects(f.service.remoteReconnect(f.owner, { terminalId: terminal.id, requestId: 'changed' }), /配置已改变/)
  await assert.rejects(close(f, terminal), /配置已改变/)
  assert.equal(f.handles.length, 1)
  assert.equal(f.sessions.size, 1)
  await writeFile(f.configPath, 'Host work\n  HostName example.invalid\n')
  await close(f, terminal)
})

test('owner isolation and disposal during late SSH allocation drain transport and exact remote task', async t => {
  const f = await fixture(t), gate = Promise.withResolvers()
  f.attachGate = gate.promise
  const pending = open(f)
  while (!f.specs.length) await tick()
  const reject = assert.rejects(pending)
  const disposing = f.service.disposeOwner(f.owner, f.service.owners.get(f.owner))
  gate.resolve()
  await Promise.all([reject, disposing])
  assert.equal(f.handles[0].terminated, true)
  assert.equal(f.sessions.size, 0)
  assert.equal(f.service.owners.has(f.owner), false)
  const other = await fixture(t), terminal = await open(other)
  const foreign = { ...other.owner, id: 'foreign' }; other.agents.set(foreign.id, foreign)
  await assert.rejects(other.service.remoteReconnect(foreign, { terminalId: terminal.id, requestId: 'foreign' }), /没有这个终端/)
  await assert.rejects(other.service.claim(foreign, { terminalId: terminal.id, viewerId: 'foreign' }), /没有这个终端/)
})
