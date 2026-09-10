import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { IndependentScopes } from '../src/independent-scope.mjs'

function fixture({ withPresets = true, joined = true } = {}) {
  const live = new Map(), stored = new Map(), handles = [], generations = new WeakMap()
  const originalGeneration = { id: 'coding', tools: {} }
  const joins = []
  const presets = {
    composedPreset: scope => generations.get(scope)?.id,
    composeFrom(scope, parent) {
      assert.equal(generations.has(scope), false, 'compose once before publication')
      const generation = generations.get(parent)
      if (generation) generations.set(scope, generation)
      joins.push({ scope, parent, generation })
      return generation?.id
    },
  }
  const source = { id: 'source', options: { provider: 'route', model: 'model' }, session: {
    id: 'source', header: { cwd: '/workspace', agentPreset: 'outdated-header' },
    events: [{ seq: 0, type: 'user/message', data: { text: 'SOURCE_TRANSCRIPT' } },
      { seq: 1, type: 'sandbox/mode', data: { mode: 'workspace-write' } }],
  }, ctx: {} }
  if (joined) generations.set(source.ctx, originalGeneration)
  const ctx = {
    get: name => name === 'agentPresets' && withPresets ? presets : name === 'sessionPersistence' ? persistence : undefined,
    sandboxPolicy: { resolve: ({ session }) => ({ workspaceRoot: session.header.cwd,
      mode: session.events.findLast(event => event.type === 'sandbox/mode')?.data.mode ?? 'workspace-write' }) },
    agents: live,
  }
  const persistence = { async list() { await f.beforeList?.(); return [...stored.values()].map(session => session.header) } }
  source.ctx.get = ctx.get
  live.set(source.id, source)
  const terminals = { ctx,
    current(agent) { assert.equal(live.get(agent.id), agent, 'exact current owner') },
    owned(agent) { this.current(agent); f.adopted.add(agent) },
  }
  const f = { source, ctx, live, stored, handles, joins, generations, originalGeneration, adopted: new Set(),
    setPreset(id = 'coding') { const generation = { id, tools: {} }; generations.set(source.ctx, generation); return generation },
  }
  const prepare = async options => {
    const restoring = !!options.resumeSessionId
    const session = restoring ? structuredClone(stored.get(options.resumeSessionId))
      : { id: options.sessionId, header: { id: options.sessionId, ...options.meta }, events: structuredClone(options.seed) }
    const agent = { id: session.id, session, options: options.agentOptions, ctx: { get: ctx.get } }
    agent.ctx.agent = agent
    const commit = options.setup(agent.ctx)
    f.beforeCommit?.(agent)
    commit?.commit()
    assert.equal(live.has(agent.id), false)
    live.set(agent.id, agent)
    stored.set(agent.id, structuredClone(session))
    const handle = { agent, disposed: false, async dispose() {
      this.disposed = true
      stored.set(agent.id, structuredClone(agent.session))
      live.delete(agent.id)
    } }
    handles.push(handle)
    return handle
  }
  live.create = prepare
  live.resume = prepare
  f.scopes = new IndependentScopes(terminals)
  return f
}

test('independent v2 joins the exact source preset before publication without copying dialogue', async () => {
  const f = fixture()
  try {
    const [a, b] = await Promise.all([f.scopes.resolve(f.source, {}), f.scopes.resolve(f.source, {})])
    assert.equal(a.sessionId, b.sessionId)
    assert.equal(f.handles.length, 1)
    const child = f.live.get(a.sessionId)
    assert.equal(f.generations.get(child.ctx), f.originalGeneration)
    assert.equal(child.session.header.agentPreset, 'coding', 'use live composition, not the stale source header')
    assert.equal(child.session.events[0].data.version, 2)
    assert.equal(child.session.events[0].data.presetId, 'coding')
    assert.equal(child.session.header.parentSession, undefined)
    assert.equal(JSON.stringify(child.session.events).includes('SOURCE_TRANSCRIPT'), false)
    assert.deepEqual(child.session.events.map(event => event.type), ['dsh-terminal/independent-scope', 'sandbox/mode'])
  } finally { await f.scopes.stop() }
})

test('independent v2 cold resume re-joins the validated source and preserves the durable owner', async () => {
  const f = fixture()
  try {
    const first = await f.scopes.resolve(f.source, {})
    await f.handles[0].dispose()
    const resumed = await f.scopes.resolve(f.source, { sessionId: first.sessionId })
    assert.equal(resumed.sessionId, first.sessionId)
    assert.equal(resumed.restored, true)
    assert.equal(f.generations.get(f.live.get(first.sessionId).ctx), f.originalGeneration)
    assert.equal(f.joins.length, 2)
    assert.equal(f.live.get(first.sessionId).session.events.length, 2, 'resume adds no prompt or history seed')
  } finally { await f.scopes.stop() }
})

test('live independent owners are not rebound, migrated or disposed when the source preset changes', async () => {
  const f = fixture()
  try {
    const first = await f.scopes.resolve(f.source, {})
    const firstOwner = f.live.get(first.sessionId)
    firstOwner.terminalControl = { held: true }
    f.setPreset('coding')
    await f.scopes.resolve(f.source, { sessionId: first.sessionId })
    assert.equal(f.generations.get(firstOwner.ctx), f.originalGeneration, 'keep an existing generation')
    assert.equal(f.joins.length, 1)
    f.setPreset('review')
    await assert.rejects(f.scopes.resolve(f.source, { sessionId: first.sessionId }), /重新选择独立工作台/)
    const second = await f.scopes.resolve(f.source, {})
    assert.notEqual(second.sessionId, first.sessionId)
    assert.equal(f.live.get(first.sessionId), firstOwner)
    assert.deepEqual(firstOwner.terminalControl, { held: true })
    assert.equal(f.handles[0].disposed, false)
  } finally { await f.scopes.stop() }
})

test('unjoined presets and source changes during provisioning fail without publishing an owner', async () => {
  const unjoined = fixture({ joined: false })
  await assert.rejects(unjoined.scopes.resolve(unjoined.source, {}), /尚未加载智能体配置/)
  assert.equal(unjoined.handles.length, 0)
  await unjoined.scopes.stop()
  for (const boundary of ['beforeList', 'beforeCommit']) {
    const f = fixture()
    f[boundary] = () => f.setPreset('changed')
    await assert.rejects(f.scopes.resolve(f.source, {}), /配置已变化/)
    assert.equal(f.handles.length, 0)
    assert.equal(f.live.size, 1)
    await f.scopes.stop()
  }
})

test('forged preset records and widened resumed policy are rejected before composition', async () => {
  for (const mutate of [session => { session.events[0].data.presetId = 'forged' },
    session => { session.header.agentPreset = 'forged' },
    session => { session.events.push({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }) }]) {
    const f = fixture()
    const first = await f.scopes.resolve(f.source, {})
    await f.handles[0].dispose()
    mutate(f.stored.get(first.sessionId))
    await assert.rejects(f.scopes.resolve(f.source, { sessionId: first.sessionId }), /配置不同|权限已变化/)
    assert.equal(f.joins.length, 1)
    assert.equal(f.live.size, 1)
    await f.scopes.stop()
  }
})

test('legacy v1 remains compatible only without a preset roster; preset scopes require a fresh selection', async () => {
  const oldId = `session-side-terminal-${createHash('sha256').update(JSON.stringify(['/workspace', 'workspace-write'])).digest('hex').slice(0, 32)}`
  const legacy = fixture({ withPresets: false })
  const first = await legacy.scopes.resolve(legacy.source, { sessionId: oldId })
  assert.equal(first.sessionId, oldId)
  assert.equal(legacy.live.get(oldId).session.events[0].data.version, 1)
  await legacy.handles[0].dispose()
  assert.equal((await legacy.scopes.resolve(legacy.source, { sessionId: oldId })).restored, true)
  await legacy.scopes.stop()
  const current = fixture()
  await assert.rejects(current.scopes.resolve(current.source, { sessionId: oldId }), /旧版.*重新选择独立工作台/)
  assert.equal(current.handles.length, 0)
  await current.scopes.stop()
})
