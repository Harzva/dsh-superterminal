import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { NativeTerminals } from '../src/terminals.mjs'

function fixture({ delayed = false, mode = 'danger-full-access' } = {}) {
  const agents = new Map(), hooks = [], disposers = [], handles = []
  const owner = { id: 'owner', session: { events: [] }, ctx: {
    on(_event, callback) { hooks.push(callback); return () => {} },
    effect(factory) { const dispose = factory(); disposers.push(dispose); return dispose },
  } }
  agents.set(owner.id, owner)
  let resolveSpawn
  const allocation = Promise.withResolvers()
  const gate = delayed ? new Promise(resolve => { resolveSpawn = resolve }) : Promise.resolve()
  const ctx = { agents, get: () => undefined, sandboxPolicy: { defaultMode: mode, resolve: () => ({ mode, workspaceRoot: '/tmp' }) }, subprocess: {
    resolveExecutable: async command => `/bin/${command}`,
    async spawnTerminal(spec) {
      allocation.resolve()
      await gate
      const finished = Promise.withResolvers()
      const output = new PassThrough()
      const handle = { pid: handles.length + 100, output, done: finished.promise, writes: [], resizes: [], terminated: false, spec,
        async write(data) { this.writes.push(data) },
        async resize(rows, cols) { this.resizes.push([rows, cols]) },
        async terminate() { this.terminated = true; output.end(); finished.resolve({ exitCode: 0 }) },
      }
      handles.push(handle)
      return handle
    },
  } }
  return { registry: new NativeTerminals(ctx, () => undefined, { assertProvider() {}, adaptHandle: handle => handle }), owner, agents, hooks, disposers, handles, allocated: allocation.promise, release: () => resolveSpawn?.() }
}
const open = (registry, owner, requestId = 'create-1') => registry.open(owner, { launcher: 'shell', requestId, rows: 24, cols: 80 })

test('same create ID does not duplicate PTYs; raw stream and resize reach the handle', async () => {
  const f = fixture()
  const [a, b] = await Promise.all([open(f.registry, f.owner), open(f.registry, f.owner)])
  assert.equal(a.id, b.id)
  assert.equal(f.handles.length, 1)
  assert.equal(f.handles[0].spec.terminalType, undefined)
  assert.deepEqual(f.handles[0].spec.argv.slice(0, 2), ['/bin/sh', '-c'])
  assert.match(f.handles[0].spec.argv[2], /export TERM=xterm-256color COLORTERM=truecolor/)
  const claim = await f.registry.claim(f.owner, { terminalId: a.id, viewerId: 'one' })
  await f.registry.resize(f.owner, { terminalId: a.id, lease: claim.lease, rows: 37, cols: 101 })
  assert.deepEqual(f.handles[0].resizes, [[37, 101]])
  f.handles[0].output.write('\x1b[31m你好\x1b[0m')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await f.registry.read(f.owner, { terminalId: a.id, offset: 0 })).data, '\x1b[31m你好\x1b[0m')
  await f.registry.stop()
  assert.equal(f.handles[0].terminated, true)
})

test('foreign and replaced owners cannot access a terminal; writer handover fences old and duplicate input', async () => {
  const f = fixture()
  const terminal = await open(f.registry, f.owner)
  const foreign = { ...f.owner, id: 'foreign' }
  f.agents.set(foreign.id, foreign)
  await assert.rejects(f.registry.read(foreign, { terminalId: terminal.id, offset: 0 }), /没有这个终端/)
  const one = await f.registry.claim(f.owner, { terminalId: terminal.id, viewerId: 'one' })
  await f.registry.write(f.owner, { terminalId: terminal.id, lease: one.lease, sequence: 0, data: 'first' })
  await assert.rejects(f.registry.write(f.owner, { terminalId: terminal.id, lease: one.lease, sequence: 0, data: 'duplicate' }), /输入顺序/)
  const two = await f.registry.claim(f.owner, { terminalId: terminal.id, viewerId: 'two' })
  await assert.rejects(f.registry.write(f.owner, { terminalId: terminal.id, lease: one.lease, sequence: 1, data: 'late' }), /控制权/)
  await f.registry.write(f.owner, { terminalId: terminal.id, lease: two.lease, sequence: 0, data: 'second' })
  assert.deepEqual(f.handles[0].writes, ['first', 'second'])
  f.agents.set(f.owner.id, { ...f.owner })
  await assert.rejects(f.registry.read(f.owner, { terminalId: terminal.id, offset: 0 }), /已失效/)
  await f.registry.stop()
})

test('sandbox mode changes are fenced from pending spawn through cleanup', async () => {
  const f = fixture({ delayed: true })
  const pending = open(f.registry, f.owner)
  await new Promise(resolve => setImmediate(resolve))
  const change = () => f.hooks[0]('serial', 'session/event', [f.owner.session, { type: 'sandbox/mode', data: { mode: 'read-only' } }])
  assert.throws(change, /sandbox/)
  f.release()
  const terminal = await pending
  assert.throws(change, /sandbox/)
  const claim = await f.registry.claim(f.owner, { terminalId: terminal.id, viewerId: 'one' })
  await f.registry.close(f.owner, { terminalId: terminal.id, lease: claim.lease })
  assert.doesNotThrow(change)
  await f.registry.stop()
})

test('owner disposal during allocation waits for and terminates the late handle', async () => {
  const f = fixture({ delayed: true })
  const pending = open(f.registry, f.owner)
  const rejected = assert.rejects(pending, /失效|disposed/)
  await f.allocated
  const disposing = f.disposers[0]()
  f.release()
  await Promise.all([rejected, disposing])
  assert.equal(f.handles[0].terminated, true)
  await f.registry.stop()
})

test('missing sandbox provider fails closed and bounded output reports loss instead of fake replay', async () => {
  const restricted = fixture({ mode: 'read-only' })
  await assert.rejects(open(restricted.registry, restricted.owner), /没有 sandbox provider/)
  assert.equal(restricted.handles.length, 0)
  await restricted.registry.stop()
  const f = fixture()
  const terminal = await open(f.registry, f.owner)
  f.handles[0].output.write('字'.repeat(3 * 1024 * 1024))
  await new Promise(resolve => setImmediate(resolve))
  const read = await f.registry.read(f.owner, { terminalId: terminal.id, offset: 0 })
  assert.equal(read.gap, true)
  assert.equal(read.data, '')
  await f.registry.stop()
})

test('a failed process cleanup can be explicitly reclaimed for close and retried', async () => {
  const f = fixture()
  const terminal = await open(f.registry, f.owner)
  const handle = f.handles[0]
  const terminate = handle.terminate.bind(handle)
  let attempts = 0
  handle.terminate = async () => { if (++attempts === 1) throw new Error('temporary cleanup failure'); await terminate() }
  const first = await f.registry.claim(f.owner, { terminalId: terminal.id, viewerId: 'one' })
  await assert.rejects(f.registry.close(f.owner, { terminalId: terminal.id, lease: first.lease }), /temporary cleanup/)
  assert.equal((await f.registry.read(f.owner, { terminalId: terminal.id, offset: 0 })).state, 'cleanup-error')
  const retry = await f.registry.claim(f.owner, { terminalId: terminal.id, viewerId: 'two' })
  await assert.rejects(f.registry.write(f.owner, { terminalId: terminal.id, lease: retry.lease, sequence: 0, data: 'unsafe' }), /未在运行/)
  await f.registry.close(f.owner, { terminalId: terminal.id, lease: retry.lease })
  assert.equal(handle.terminated, true)
  await f.registry.stop()
})

test('provider incompatibility rejects before allocation; handle incompatibility still cleans the original', async () => {
  const provider = fixture()
  provider.registry.ptyCompatibility = { assertProvider() { throw new Error('incompatible provider') } }
  await assert.rejects(open(provider.registry, provider.owner), /incompatible provider/)
  assert.equal(provider.handles.length, 0)
  await provider.registry.stop()

  const handle = fixture()
  handle.registry.ptyCompatibility = { assertProvider() {}, adaptHandle() { throw new Error('incompatible handle') } }
  await assert.rejects(open(handle.registry, handle.owner), /incompatible handle/)
  assert.equal(handle.handles[0].terminated, true)
  await handle.registry.stop()
})

test('supervision snapshot is scoped to the current owner and excludes output and control secrets', async () => {
  const f = fixture()
  try {
    const terminal = await open(f.registry, f.owner)
    f.handles[0].output.write('PRIVATE_OUTPUT_FIXTURE')
    await f.registry.claim(f.owner, { terminalId: terminal.id, viewerId: 'private-viewer' })
    const snapshot = f.registry.supervisionSnapshot({ sessionId: f.owner.id })
    assert.deepEqual(snapshot, { status: 'ready', terminals: [{ id: terminal.id, launcher: 'shell', state: 'running', exitCode: null }] })
    assert.equal(f.registry.supervisionSnapshot({ sessionId: 'foreign' }).status, 'unavailable')
    f.agents.set(f.owner.id, { ...f.owner })
    assert.deepEqual(f.registry.supervisionSnapshot({ sessionId: f.owner.id }), { status: 'empty', terminals: [] })
    assert.equal(f.handles[0].writes.length, 0)
  } finally { await f.registry.stop() }
})

test('discovered agent launchers and custom local CLI preserve argv and sandbox without Claude configuration', async () => {
  const f = fixture()
  try {
    const list = await f.registry.list(f.owner, {})
    assert.ok(list.launchers.some(item => item.id === 'kimi'))
    assert.ok(list.launchers.some(item => item.id === 'pi'))
    for (const launcher of ['kimi', 'pi', 'my-agent']) {
      await f.registry.open(f.owner, { launcher, requestId: launcher, rows: 24, cols: 80 })
      const spec = f.handles.at(-1).spec
      assert.equal(spec.argv.at(-1), '/bin/' + launcher)
      assert.equal(spec.env.CLAUDE_CONFIG_DIR, undefined)
      assert.equal(spec.env.CODEX_HOME, undefined)
      if (launcher === 'kimi') assert.ok(spec.env.KIMI_CODE_HOME.endsWith('/.dsh-terminal/kimi'))
      if (launcher === 'pi') assert.ok(spec.env.PI_CODING_AGENT_DIR.endsWith('/.dsh-terminal/pi'))
    }
    await assert.rejects(f.registry.open(f.owner, { launcher: 'pi;touch attack', requestId: 'bad', rows: 24, cols: 80 }))
    await assert.rejects(f.registry.open(f.owner, { launcher: '../pi', requestId: 'bad2', rows: 24, cols: 80 }))
  } finally { await f.registry.stop() }
})

test('smart advice sends only the chosen terminal and explicit excerpt, never other PTY output or commands', async () => {
  const f = fixture(); let captured
  f.registry.ctx.get = name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'test', model: 'test' }) } : name === 'llm' ? { async *stream(input) { captured = input; yield { type: 'text-delta', text: '建议草稿' }; yield { type: 'finish', reason: { kind: 'stop' } } } } : undefined
  try {
    const selected = await f.registry.open(f.owner, { launcher: 'shell', requestId: 'smart-shell', rows: 24, cols: 80 })
    const other = await f.registry.open(f.owner, { launcher: 'pi', requestId: 'other-pi', rows: 24, cols: 80 })
    f.registry.append([...f.registry.owners.get(f.owner).entries.values()][0], 'PRIVATE_PTY_OUTPUT')
    const result = await f.registry.suggest(f.owner, { prompt: '查看端口', terminalId: selected.id, excerpt: 'EXPLICIT_SHARED_EXCERPT' })
    assert.equal(result.text, '建议草稿')
    assert.equal(result.terminalId, selected.id)
    assert.ok(JSON.stringify(captured.messages).includes('查看端口'))
    assert.ok(JSON.stringify(captured.messages).includes(selected.id))
    assert.ok(JSON.stringify(captured.messages).includes('EXPLICIT_SHARED_EXCERPT'))
    assert.ok(!JSON.stringify(captured.messages).includes(other.id))
    assert.ok(!JSON.stringify(captured.messages).includes('PRIVATE_PTY_OUTPUT'))
    assert.equal(f.handles[0].writes.length, 0)
    await assert.rejects(f.registry.suggest(f.owner, { prompt: '解释', terminalId: 'foreign-terminal', excerpt: 'hello' }), /没有这个终端/)
    await assert.rejects(f.registry.suggest(f.owner, { prompt: '解释', excerpt: 'unbound' }), /先选择终端/)
    const general = await f.registry.suggest(f.owner, { prompt: '通用建议' })
    assert.equal(general.terminalId, null)
    assert.equal(JSON.parse(captured.messages[0].content[0].text).terminal, null)
    f.agents.delete(f.owner.id)
    await assert.rejects(f.registry.suggest(f.owner, { prompt: 'foreign' }))
  } finally { await f.registry.stop() }
})

test('smart advice respects explicit reasoning and uses quick answers only when the exact model supports them', async () => {
  const f = fixture(); let captured, inspected = 0
  let route = { provider: 'test-provider', model: 'test-model' }
  let efforts = [{ id: 'off' }, { id: 'high' }]
  const llm = {
    async resolveModelInfo(provider, model, signal) {
      assert.equal(provider, route.provider); assert.equal(model, route.model); assert.ok(signal)
      inspected++; return { reasoning: { efforts, defaultEffort: 'high' } }
    },
    async *stream(input) { captured = input; yield { type: 'text-delta', text: '建议' }; yield { type: 'finish', reason: { kind: 'stop' } } },
  }
  f.registry.ctx.get = name => name === 'agentDefaultModel' ? { currentSelection: () => route } : name === 'llm' ? llm : undefined
  try {
    await f.registry.suggest(f.owner, { prompt: '解释失败' })
    assert.equal(captured.reasoningEffort, 'off'); assert.equal(captured.maxTokens, 8192)
    route = { ...route, reasoningEffort: 'high' }
    await f.registry.suggest(f.owner, { prompt: '解释失败' })
    assert.equal(captured.reasoningEffort, 'high'); assert.equal(inspected, 1)
    route = { provider: route.provider, model: route.model }; efforts = [{ id: 'high' }]
    await f.registry.suggest(f.owner, { prompt: '解释失败' })
    assert.equal(Object.hasOwn(captured, 'reasoningEffort'), false)
  } finally { await f.registry.stop() }
})

test('smart advice rejects reasoning exhaustion, partial failures and incomplete streams without leaking provider text', async () => {
  const f = fixture()
  let chunks
  f.registry.ctx.get = name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'test', model: 'test' }) } : name === 'llm' ? { async *stream() { yield* chunks } } : undefined
  const failure = { code: 'AUTH', status: 401, message: 'SECRET_PROVIDER_BODY sk-private /private/credentials.json' }
  const cases = [
    [[{ type: 'reasoning-delta', text: 'thinking' }, { type: 'finish', reason: { kind: 'max-tokens' } }], 'SUGGEST_LIMIT'],
    [[{ type: 'text-delta', text: 'partial answer' }, { type: 'finish', reason: { kind: 'max-tokens' } }], 'SUGGEST_LIMIT'],
    [[{ type: 'text-delta', text: 'partial answer' }, { type: 'finish', reason: { kind: 'error', failure } }], 'SUGGEST_AUTH'],
    [[{ type: 'finish', reason: { kind: 'error', failure: { ...failure, code: 'SERVER', status: 503 } } }], 'SUGGEST_PROVIDER'],
    [[{ type: 'text-delta', text: 'partial answer' }], 'SUGGEST_INCOMPLETE'],
    [[{ type: 'finish', reason: { kind: 'tool-calls' } }], 'SUGGEST_INCOMPLETE'],
    [[{ type: 'finish', reason: { kind: 'stop' } }], 'SUGGEST_EMPTY'],
    [[{ type: 'finish', reason: { kind: 'aborted', failure } }], 'SUGGEST_CANCELLED'],
  ]
  try {
    for (const [events, code] of cases) {
      chunks = events
      await assert.rejects(f.registry.suggest(f.owner, { prompt: '解释失败' }), error => {
        assert.equal(error.code, code)
        assert.doesNotMatch(String(error), /SECRET_PROVIDER|sk-private|credentials|partial answer/)
        return true
      })
    }
    chunks = [{ type: 'text-delta', text: '完整建议' }, { type: 'finish', reason: { kind: 'stop' } }]
    assert.equal((await f.registry.suggest(f.owner, { prompt: '重试' })).text, '完整建议')
  } finally { await f.registry.stop() }
})

test('smart advice classifies timeout and cancellation and sanitizes capability lookup failures', async t => {
  const f = fixture(); let entered, mode = 'wait'
  const llm = {
    async resolveModelInfo() {
      if (mode === 'lookup-error') throw Object.assign(new Error('SECRET_PROVIDER_BODY'), { code: 'AUTH' })
      return {}
    },
    async *stream(input) {
      entered.resolve()
      await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }))
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } }
    },
  }
  f.registry.ctx.get = name => name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'test', model: 'test' }) } : name === 'llm' ? llm : undefined
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    entered = Promise.withResolvers()
    const timed = assert.rejects(f.registry.suggest(f.owner, { prompt: '解释' }), { code: 'SUGGEST_TIMEOUT' })
    await entered.promise; t.mock.timers.tick(60000); await timed
    entered = Promise.withResolvers()
    const controller = new AbortController()
    const cancelled = assert.rejects(f.registry.suggest(f.owner, { prompt: '解释' }, controller.signal), { code: 'SUGGEST_CANCELLED' })
    await entered.promise; controller.abort(); await cancelled
    mode = 'lookup-error'
    await assert.rejects(f.registry.suggest(f.owner, { prompt: '解释' }), error => error.code === 'SUGGEST_AUTH' && !error.message.includes('SECRET_PROVIDER'))
  } finally { t.mock.timers.reset(); await f.registry.stop() }
})

function scopedFixture() {
  const f = fixture({ mode: 'workspace-write' })
  const store = new Map(), created = [], resumed = [], handles = []
  f.owner.session = { id: f.owner.id, header: { id: f.owner.id, cwd: '/workspace' }, events: [{ seq: 0, type: 'user/message', data: { private: 'SOURCE_HISTORY' } }] }
  f.owner.options = { provider: 'route', model: 'model', private: 'DO_NOT_COPY' }
  f.registry.ctx.sandboxPolicy.resolve = ({ session }) => ({ mode: session.events.findLast(event => event.type === 'sandbox/mode')?.data.mode ?? 'workspace-write', workspaceRoot: session.header.cwd })
  f.registry.ctx.get = name => name === 'sessionPersistence' ? { async list() { return [...store.values()].map(item => item.session.header) } } : name === 'sandbox' ? { confine: argv => ({ argv }) } : undefined
  const prepare = async (options, restored) => {
    const id = options.sessionId ?? options.resumeSessionId
    const effects = []
    const session = restored ? structuredClone(store.get(id).session) : { id, header: { id, cwd: options.meta.cwd }, events: structuredClone(options.seed) }
    const agent = { id, session, options: options.agentOptions, ctx: { on() { return () => {} }, effect(factory) { const dispose = factory(); effects.push(dispose); return dispose } } }
    agent.ctx.agent = agent
    const commit = await options.setup(agent.ctx)
    options.signal.throwIfAborted()
    commit?.commit()
    f.agents.set(id, agent)
    store.set(id, { session })
    const handle = { agent, disposed: false, async dispose() { this.disposed = true; for (const dispose of effects) await dispose(); f.agents.delete(id) } }
    handles.push(handle)
    return handle
  }
  f.agents.create = async options => { created.push(options); return prepare(options, false) }
  f.agents.resume = async options => { resumed.push(options); return prepare(options, true) }
  return { ...f, store, created, resumed, agentHandles: handles }
}

test('independent terminals use a distinct durable workspace owner without inheriting dialogue or permissions', async () => {
  const f = scopedFixture()
  try {
    const [a, b] = await Promise.all([f.registry.independent(f.owner, {}), f.registry.independent(f.owner, {})])
    assert.equal(a.sessionId, b.sessionId)
    assert.notEqual(a.sessionId, f.owner.id)
    assert.equal(f.created.length, 1)
    const independent = f.agents.get(a.sessionId)
    assert.deepEqual(independent.options, { provider: 'route', model: 'model' })
    assert.equal(JSON.stringify(independent.session.events).includes('SOURCE_HISTORY'), false)
    assert.equal(f.registry.ctx.sandboxPolicy.resolve({ session: independent.session }).mode, 'workspace-write')
    const sourceTerminal = await open(f.registry, f.owner, 'source')
    await assert.rejects(f.registry.read(independent, { terminalId: sourceTerminal.id, offset: 0 }), /没有这个终端/)
    const prior = await f.registry.independent(f.owner, { sessionId: a.sessionId })
    assert.equal(prior.restored, true)
    await f.agentHandles[0].dispose()
    const restored = await f.registry.independent(f.owner, { sessionId: a.sessionId })
    assert.equal(restored.sessionId, a.sessionId)
    assert.equal(restored.restored, true)
    assert.equal(f.resumed.length, 1)
    assert.deepEqual((await f.registry.list(f.agents.get(a.sessionId), {})).terminals, [])
  } finally { await f.registry.stop() }
  assert.ok(f.agentHandles.every(handle => handle.disposed))
})

test('independent restore rejects other workspaces, forged scope records, and changed policy', async () => {
  const f = scopedFixture()
  try {
    const first = await f.registry.independent(f.owner, {})
    await assert.rejects(f.registry.independent(f.owner, { sessionId: f.owner.id }), /原工作区/)
    const foreign = { ...f.owner, id: 'foreign', session: { ...f.owner.session, header: { cwd: '/other-workspace' } } }
    f.agents.set(foreign.id, foreign)
    await assert.rejects(f.registry.independent(foreign, { sessionId: first.sessionId }), /原工作区/)
    const target = f.agents.get(first.sessionId)
    target.session.events[0].data.workspaceRoot = '/forged-workspace'
    await assert.rejects(f.registry.independent(f.owner, { sessionId: first.sessionId }), /不属于当前工作区/)
    target.session.events[0].data.workspaceRoot = '/workspace'
    target.session.events.push({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
    await assert.rejects(f.registry.independent(f.owner, { sessionId: first.sessionId }), /权限已变化/)
  } finally { await f.registry.stop() }
})

test('independent creation rechecks source policy and plugin shutdown cancels pending ownership', async () => {
  for (const shutdown of [false, true]) {
    const f = scopedFixture()
    const gate = Promise.withResolvers()
    const create = f.agents.create
    f.agents.create = async options => { await gate.promise; return create(options) }
    const pending = f.registry.independent(f.owner, {})
    const rejected = assert.rejects(pending)
    await new Promise(resolve => setImmediate(resolve))
    let stopped
    if (shutdown) stopped = f.registry.stop()
    else f.owner.session.events.push({ type: 'sandbox/mode', data: { mode: 'read-only' } })
    gate.resolve()
    await rejected
    assert.equal(f.agentHandles.length, 0)
    assert.equal(f.registry.independentScopes.pending.size, 0)
    await (stopped ?? f.registry.stop())
  }
})

test('plugin shutdown drains PTYs before disposing dedicated owners and is single-shot', async () => {
  const f = scopedFixture()
  const side = await f.registry.independent(f.owner, {})
  const sideOwner = f.agents.get(side.sessionId)
  await open(f.registry, f.owner, 'bound')
  await open(f.registry, sideOwner, 'side')
  const handle = f.agentHandles[0]
  const dispose = handle.dispose.bind(handle)
  let disposals = 0
  handle.dispose = async () => {
    assert.ok(f.handles.every(pty => pty.terminated), 'PTYs drain before owner disposal')
    disposals++
    await dispose()
  }
  const first = f.registry.stop()
  assert.equal(f.registry.stop(), first)
  await first
  assert.equal(disposals, 1)
})

test('a validated existing owner is tracked without taking ownership of its DSH lifecycle', async () => {
  const f = scopedFixture()
  const side = await f.registry.independent(f.owner, {})
  const owner = f.agents.get(side.sessionId)
  // Simulate the same durable owner already resumed by the runtime, not this plugin.
  f.registry.independentScopes.handles.clear()
  f.registry.owners.clear()
  await f.registry.independent(f.owner, { sessionId: side.sessionId })
  assert.ok(f.registry.owners.has(owner))
  await open(f.registry, owner)
  await f.registry.stop()
  assert.ok(f.handles.every(handle => handle.terminated))
  assert.equal(f.agentHandles[0].disposed, false)
  assert.equal(f.agents.get(side.sessionId), owner)
})

test('asynchronous title failure rolls back the new independent owner before reporting failure', async () => {
  const f = scopedFixture()
  const get = f.registry.ctx.get
  f.registry.ctx.get = name => name === 'sessionTitle' ? { async rename() { await Promise.resolve(); throw new Error('title failed') } } : get(name)
  await assert.rejects(f.registry.independent(f.owner, {}), /title failed/)
  assert.equal(f.agentHandles[0].disposed, true)
  assert.equal(f.agents.size, 1)
  assert.equal(f.registry.independentScopes.handles.size, 0)
  await f.registry.stop()
})

test('command snapshots are owner scoped and reconnect without replaying private shell frames into the terminal', async () => {
  const f = fixture()
  const terminal = await open(f.registry, f.owner)
  const entry = f.registry.entry(f.owner, terminal.id)
  const nonce = entry.commands.nonce
  const marker = (type, sequence, payload = '') => `\x1b]777;dsh-command;${nonce};${sequence};${type};${payload}\x07`
  f.handles[0].output.write(marker('R', 0) + 'PROMPT> ' + marker('C', 1, '0;' + Buffer.from('false').toString('base64')) + 'command output\r\n' + marker('D', 1, '1') + 'PROMPT> ')
  await new Promise(resolve => setImmediate(resolve))
  const snapshot = await f.registry.commands(f.owner, { terminalId: terminal.id, lastN: 20 })
  assert.equal(snapshot.records[0].command, 'false'); assert.equal(snapshot.records[0].exitCode, 1)
  assert.equal(snapshot.records[0].output, 'command output\n')
  const reconnected = await f.registry.commands(f.owner, { terminalId: terminal.id })
  assert.deepEqual(reconnected.records, snapshot.records)
  const replay = await f.registry.read(f.owner, { terminalId: terminal.id, offset: 0 })
  assert.equal(replay.data, 'PROMPT> command output\r\nPROMPT> ')
  const foreign = { ...f.owner, id: 'foreign-commands' }; f.agents.set(foreign.id, foreign)
  await assert.rejects(f.registry.commands(foreign, { terminalId: terminal.id }), /没有这个终端/)
  await assert.rejects(f.registry.commands(f.owner, { terminalId: terminal.id, lastN: 51 }))
  const agent = await f.registry.open(f.owner, { launcher: 'pi', requestId: 'native-agent', rows: 24, cols: 80 })
  assert.equal(f.handles[1].spec.env.ZDOTDIR, undefined)
  assert.equal((await f.registry.commands(f.owner, { terminalId: agent.id })).status, 'unavailable')
  await f.registry.stop()
})

test('shell process exit never supplies a missing command exit code', async () => {
  const f = fixture(), terminal = await open(f.registry, f.owner)
  const entry = f.registry.entry(f.owner, terminal.id)
  const marker = (type, sequence, data = '') => `\x1b]777;dsh-command;${entry.commands.nonce};${sequence};${type};${data}\x07`
  f.handles[0].output.write(marker('R', 0) + marker('C', 1, '0;' + Buffer.from('exec a-process').toString('base64')) + 'partial output')
  await f.handles[0].terminate()
  await entry.completion
  const snapshot = await f.registry.commands(f.owner, { terminalId: terminal.id })
  assert.equal(entry.exitCode, 0)
  assert.equal(snapshot.records[0].status, 'interrupted'); assert.equal(snapshot.records[0].exitCode, null)
  assert.equal(snapshot.records[0].output, 'partial output')
  await f.registry.stop()
})
