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
  const gate = delayed ? new Promise(resolve => { resolveSpawn = resolve }) : Promise.resolve()
  const ctx = { agents, get: () => undefined, sandboxPolicy: { defaultMode: mode, resolve: () => ({ mode, workspaceRoot: '/tmp' }) }, subprocess: {
    resolveExecutable: async command => `/bin/${command}`,
    async spawnTerminal(spec) {
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
  return { registry: new NativeTerminals(ctx, () => undefined, { assertProvider() {}, adaptHandle: handle => handle }), owner, agents, hooks, disposers, handles, release: () => resolveSpawn?.() }
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
  await new Promise(resolve => setImmediate(resolve))
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
