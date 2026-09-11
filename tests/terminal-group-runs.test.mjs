import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeRuns } from '../src/terminal-runs.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const owner = { id: 'owner', session: { header: { cwd: '/workspace' }, events: [] }, ctx: { get: () => undefined } }
  const controls = { failDispose: false }, sends = [], entries = new Map([['one', { id: 'one' }]])
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/workspace' }) },
    agents: { create() {}, resume() {} }, get: key => key === 'sessions' ? { flush: async () => { if (controls.flushGate) { controls.flushing = true; await controls.flushGate.promise }; return true } } : undefined }
  const terminals = { ctx, current(value) { assert.equal(value, owner) }, owned(value) { this.current(value) }, entry(value, id) { this.current(value); if (!entries.has(id)) throw Error('missing'); return entries.get(id) } }
  const runtime = Object.fromEntries(['captureDelegatedPolicyOverrides', 'appendDelegatedPolicyOverrides', 'applyChildComposition', 'installModelSelection'].map(key => [key, () => {}]))
  const runs = new NativeRuns(terminals, runtime), record = runs.record(owner, 'one', true)
  record.sourcePolicy = runs.policy(owner); record.ownerId = owner.id; record.route = { provider: 'local', model: 'actual-model' }
  const session = { id: record.sessionId, events: [] }, append = (type, data) => session.events.push({ type, data })
  let idle = Promise.withResolvers()
  const agent = { session, status: 'idle', followup(message) { sends.push(message); this.status = 'running'; idle = Promise.withResolvers(); append('agent/inbox/spliced', { inserted: [message] }) },
    steer() { throw Error('group must never steer') }, whenIdle() { return this.status === 'idle' ? Promise.resolve() : idle.promise },
    cancel() { this.status = 'idle'; idle.resolve() } }
  record.handle = { agent, async dispose() { if (controls.failDispose) throw Error('private cleanup error') } }
  const finish = (text = 'Own result', options = {}) => {
    append('turn/start', { turn: 2 })
    for (const message of options.contextBefore ?? []) append('user/message', message)
    if (options.foreignBefore) append('user/message', { id: 'another-input', role: 'user' })
    if (!options.missingInput) append('user/message', options.forgedSource ? { ...sends.at(-1), source: { kind: 'user' } } : sends.at(-1))
    if (options.queuedContext) append('agent/inbox/spliced', { target: options.queuedTarget, inserted: [options.queuedContext] })
    for (const message of options.contextAfter ?? []) append('user/message', message)
    if (options.foreignAfter) append('user/message', { id: 'another-input', role: 'user' })
    append('assistant/message', { turn: options.wrongTurn ? 3 : 2, step: 1, interrupted: options.interrupted ?? false, message: { content: [{ type: 'text', text }] } })
    append('turn/end', { turn: 2, reason: { kind: options.reason ?? 'completed' } }); agent.status = 'idle'; idle.resolve()
  }
  const groupTurn = (signal, requestId = 'request', prompt = 'Discuss') => runs.groupTurn(owner, { terminalId: 'one', groupId: 'g1', requestId, prompt }, signal)
  return { runs, record, owner, agent, sends, append, finish, groupTurn, controls }
}

test('group exclusively uses the existing native session and shares only its correlated final reply', async () => {
  const f = fixture(), handle = f.record.handle
  f.append('turn/start', { turn: 1 }); f.append('assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'PRIVATE_PREVIOUS_RESULT' }] } })
  f.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const pending = f.groupTurn(); await tick()
  await assert.rejects(f.runs.send(f.owner, { terminalId: 'one', requestId: 'user-next', prompt: 'Unrelated task' }), /RUN_REJECTED.*讨论组/)
  await assert.rejects(f.runs.stop(f.owner, { terminalId: 'one' }), /讨论组/)
  await assert.rejects(f.groupTurn(undefined, 'another-group-turn'), /其他任务/)
  f.finish('Only this answer')
  const result = await pending
  assert.deepEqual(result, { text: 'Only this answer', truncated: false, totalLength: 16, resultRef: { terminalId: 'one', messageId: 'assistant-2-1' }, model: 'actual-model', sessionId: f.record.sessionId })
  assert.equal(f.record.handle, handle); assert.equal(f.runs.hasGroupLease(f.owner, 'g1'), false); assert.equal(f.sends.length, 1)
  await f.runs.send(f.owner, { terminalId: 'one', requestId: 'user-next', prompt: 'New individual task' })
  await f.runs.close()
})

test('busy native work is never steered or cancelled to make room for discussion', async () => {
  const f = fixture()
  await f.runs.send(f.owner, { terminalId: 'one', requestId: 'individual', prompt: 'Keep working' })
  await assert.rejects(f.groupTurn(), /其他任务/)
  assert.equal(f.agent.status, 'running'); assert.equal(f.sends.length, 1); assert.equal(f.runs.hasGroupLease(f.owner, 'g1'), false)
  await f.runs.close()
})

test('an uncorrelated, mixed-input, interrupted or failed turn cannot become a group reply', async () => {
  for (const options of [{ missingInput: true }, { forgedSource: true }, { foreignBefore: true }, { foreignAfter: true }, { wrongTurn: true }, { interrupted: true }, { reason: 'error' }]) {
    const f = fixture(), pending = f.groupTurn(), failure = assert.rejects(pending, /对应的完整结果/)
    await tick(); f.finish('Unproven result', options); await failure
    assert.equal(f.runs.hasGroupLease(f.owner, 'g1'), false); assert.equal(f.record.handle, null)
    await f.runs.close()
  }
})

const nativeContext = () => [
  { id: 'runtime-snapshot', role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [] },
    content: [{ type: 'text', text: 'PRIVATE_RUNTIME_CONTEXT' }] },
  { id: 'skill-catalog', role: 'user', source: { kind: 'skill-catalog', form: 'catalog', entries: [] },
    content: [{ type: 'text', text: 'PRIVATE_SKILL_CATALOG' }] },
]

test('first-turn runtime snapshot and skill catalog do not contaminate the exact group input', async () => {
  const cleared = { id: 'runtime-cleared', role: 'user', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    content: [{ type: 'text', text: 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.' }] }
  for (const options of [{ contextAfter: nativeContext() }, { contextBefore: nativeContext(), contextAfter: [cleared] }]) {
    const f = fixture(), pending = f.groupTurn()
    await tick(); f.finish('Only the correlated answer', options)
    assert.equal((await pending).text, 'Only the correlated answer')
    assert.equal(f.sends.length, 1); assert.equal(f.runs.hasGroupLease(f.owner, 'g1'), false)
    assert.doesNotMatch(JSON.stringify(f.runs.view(f.record)), /PRIVATE_RUNTIME_CONTEXT|PRIVATE_SKILL_CATALOG/)
    await f.runs.close()
  }
})

test('other plugin messages and context-shaped inbox work still contaminate a group turn', async () => {
  const [snapshot, catalog] = nativeContext()
  const other = { ...snapshot, source: { kind: 'plugin', plugin: 'another-task-plugin', form: 'snapshot', sections: [] } }
  const malformed = { ...catalog, source: { kind: 'skill-catalog', form: 'instructions' } }
  for (const options of [{ contextAfter: [other] }, { contextAfter: [malformed] },
    { queuedContext: snapshot, contextAfter: [snapshot] }, { queuedContext: catalog, contextAfter: [catalog] }]) {
    const f = fixture(), pending = f.groupTurn(), failed = assert.rejects(pending, /对应的完整结果/)
    await tick(); f.finish('Must not be shared', options); await failed
    assert.equal(f.record.handle, null)
    await f.runs.close()
  }
})

test('group orchestration input stays private in live and restored projections without changing delivery identity', async () => {
  const f = fixture(), requestId = `group-${'a'.repeat(64)}`, prompt = 'PRIVATE_GROUP_ORCHESTRATION_INSTRUCTIONS'
  const pending = f.groupTurn(undefined, requestId, prompt)
  await tick()
  const live = f.runs.view(f.record), input = live.messages.find(row => row.role === 'user')
  assert.equal(live.groupId, 'g1'); assert.equal(input.title, '讨论组发言')
  assert.match(input.text, /讨论组查看/); assert.doesNotMatch(JSON.stringify(live), /PRIVATE_GROUP_ORCHESTRATION/)
  assert.equal(f.sends[0].content[0].text, prompt)
  f.finish('Shared reply'); await pending
  assert.equal(f.runs.view(f.record).groupId, undefined)
  const restored = { ...f.record, handle: null, projectedSession: null, cursor: 0,
    messages: new Map(), requests: new Map(), accepted: new Set(), conflicts: new Set() }
  f.runs.project(restored, structuredClone(f.agent.session))
  const recovered = f.runs.view(restored)
  assert.equal(recovered.messages.find(row => row.role === 'user').title, '讨论组发言')
  assert.deepEqual(recovered.acceptedRequestIds, [requestId]); assert.doesNotMatch(JSON.stringify(recovered), /PRIVATE_GROUP_ORCHESTRATION/)
  await assert.rejects(f.runs.send(f.owner, { terminalId: 'one', requestId, prompt: 'Changed prompt' }), /不同内容/)
  await f.runs.close()
})

test('cancellation retains the exclusive lease until native cleanup is proven and can be retried', async () => {
  const f = fixture(), controller = new AbortController(); f.controls.failDispose = true
  const failure = assert.rejects(f.groupTurn(controller.signal), /清理/)
  await tick(); controller.abort(); await failure
  assert.equal(f.runs.hasGroupLease(f.owner, 'g1'), true)
  await assert.rejects(f.runs.send(f.owner, { terminalId: 'one', requestId: 'next', prompt: 'Next' }), /讨论组/)
  f.controls.failDispose = false
  await f.runs.stopGroupTurn(f.owner, 'g1')
  assert.equal(f.runs.hasGroupLease(f.owner, 'g1'), false); assert.equal(f.record.handle, null)
  await f.runs.close()
})

test('stop during the result checkpoint cannot return a late completed reply', async () => {
  const f = fixture(), controller = new AbortController(), pending = f.groupTurn(controller.signal)
  const stopped = assert.rejects(pending)
  await tick(); f.controls.flushGate = Promise.withResolvers(); f.finish('Late answer')
  while (!f.controls.flushing) await tick()
  controller.abort(); f.controls.flushGate.resolve(); await stopped
  assert.equal(f.runs.hasGroupLease(f.owner, 'g1'), false); assert.equal(f.record.handle, null)
  await f.runs.close()
})

test('an external task arriving during connection is neither steered nor cancelled by group admission', async () => {
  const f = fixture(), gate = Promise.withResolvers(), connect = f.runs.connect.bind(f.runs)
  f.runs.connect = async (...args) => { await gate.promise; return connect(...args) }
  const pending = f.groupTurn(), blocked = assert.rejects(pending, /其他任务/)
  await tick(); f.agent.status = 'running'; gate.resolve(); await blocked
  assert.equal(f.sends.length, 0); assert.equal(f.agent.status, 'running'); assert.equal(f.runs.hasGroupLease(f.owner, 'g1'), false)
  await f.runs.close()
})

const agentsContext = { id: 'native-agents', role: 'user', source: { kind: 'agent-instructions', form: 'instructions', baseline: true,
  changes: [{ action: 'set', scope: 'workspace', path: '/workspace/AGENTS.md', digest: 'content-digest' }] }, content: [{ type: 'text', text: 'PRIVATE_AGENTS_INSTRUCTIONS' }] }
const invokedSkill = { id: 'native-invocation', role: 'user', source: { kind: 'skill-invocation', name: 'review', form: 'instructions' }, content: [{ type: 'text', text: 'PRIVATE_INVOKED_SKILL' }] }

test('native AGENTS and invoked skill projections remain context, including next-step AGENTS refresh', async () => {
  for (const options of [{ contextAfter: [agentsContext, invokedSkill] }, { contextBefore: [agentsContext, invokedSkill] },
    { queuedContext: agentsContext, queuedTarget: 'next-step', contextAfter: [agentsContext] }]) {
    const f = fixture(), pending = f.groupTurn(); await tick(); f.finish('Attributed final reply', options)
    assert.equal((await pending).text, 'Attributed final reply')
    assert.doesNotMatch(JSON.stringify(f.runs.view(f.record)), /PRIVATE_AGENTS|PRIVATE_INVOKED/)
    await f.runs.close()
  }
})

test('real inbox work and malformed AGENTS or skill sources still refuse attribution', async () => {
  const malformedAgents = { ...agentsContext, source: { ...agentsContext.source, changes: [{ action: 'write', scope: 'workspace' }] } }
  const malformedSkill = { ...invokedSkill, source: { ...invokedSkill.source, form: 'catalog' } }
  const plain = { id: 'extra-user', role: 'user', content: [{ type: 'text', text: 'Another task' }] }
  for (const options of [{ contextAfter: [malformedAgents] }, { contextAfter: [malformedSkill] },
    { queuedContext: agentsContext, queuedTarget: 'next-turn', contextAfter: [agentsContext] },
    { queuedContext: invokedSkill, queuedTarget: 'next-step', contextAfter: [invokedSkill] },
    { queuedContext: plain, queuedTarget: 'next-step', contextAfter: [plain] },
    { contextAfter: [agentsContext, invokedSkill], foreignAfter: true }]) {
    const f = fixture(), pending = f.groupTurn(), rejected = assert.rejects(pending, /对应的完整结果/)
    await tick(); f.finish('Must never be shared', options); await rejected; await f.runs.close()
  }
})

test('long native group results preserve the real tail and explicit source reference', async () => {
  const f = fixture(), pending = f.groupTurn(), original = 'ACTUAL_START\n' + 'x'.repeat(24000) + '\nACTUAL_FINAL_CORRECTION'
  await tick(); f.finish(original); const reply = await pending
  assert.equal(reply.truncated, true); assert.equal(reply.totalLength, original.length); assert.ok(reply.text.length <= 8000)
  assert.ok(reply.text.startsWith('ACTUAL_START')); assert.ok(reply.text.endsWith('ACTUAL_FINAL_CORRECTION')); assert.match(reply.text, /省略/)
  assert.deepEqual(reply.resultRef, { terminalId: 'one', messageId: 'assistant-2-1' }); await f.runs.close()
})
