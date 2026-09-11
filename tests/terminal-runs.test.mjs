import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { NativeRuns } from '../src/terminal-runs.mjs'
import { NativeTerminals } from '../src/terminals.mjs'

function fixture() {
  const agents = new Map(), disk = new Map(), handles = [], log = [], hooks = []
  const owner = { id: 'source-owner', options: { provider: 'old-provider', model: 'old-model' },
    session: { id: 'source-owner', header: { cwd: '/workspace' }, events: [] }, ctx: {} }
  agents.set(owner.id, owner)
  const controls = { delay: null, flush: true, failDispose: false, throwsAfterSend: false, preset: 'main' }
  const ctx = { agents, sessions: { async flush(session) {
    log.push(['flush', session.id]); if (!controls.flush) return false
    disk.set(session.id, { header: structuredClone(session.header), events: structuredClone(session.events) }); return true
  } }, sandboxPolicy: { defaultMode: 'workspace-write', resolve({ session }) {
    return { workspaceRoot: session.header.cwd, mode: session.events.findLast(event => event.type === 'sandbox/mode')?.data.mode ?? 'workspace-write' }
  } }, get(name) {
    if (name === 'sessions') return this.sessions
    if (name === 'sessionPersistence') return { async list() { return [...disk].map(([id]) => ({ id })) }, async inspect(id) { if (controls.inspectGate) await controls.inspectGate.promise; const record = disk.get(id); if (!record) throw Error('missing'); return { meta: record.header, events: record.events } } }
    if (name === 'apiProxy') return { sessions: { async models() { return { rpcId: 'query', result: { ok: true, value: { current: { provider: 'current-provider', model: 'current-model', reasoningEffort: 'low' } } } } } } }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'default', model: 'default' }) }
  } }
  owner.ctx = { agents, get(name) { if (name === 'agentPresets') return { composedPreset: () => controls.preset }; if (name === 'approval') return { overrideOf: () => undefined, config: { policy: 'ask' } } },
    on(_event, callback) { hooks.push(callback); return () => {} }, effect(factory) { return factory() } }
  const append = (session, type, data) => session.events.push({ seq: session.events.length, time: Date.now(), type, data })
  async function create(options, restoring = false) {
    const id = options.sessionId ?? options.resumeSessionId
    const stored = disk.get(id)
    const session = { id, header: { id, cwd: options.meta?.cwd ?? stored.header.cwd, agentPreset: options.meta?.agentPreset ?? stored?.header.agentPreset }, events: structuredClone(restoring ? stored.events : options.seed),
      append(type, data) { append(this, type, data) } }
    const child = { id, session, options: options.agentOptions, status: 'idle', pending: [], sends: [],
      hooks: [], ctx: { get: owner.ctx.get }, cancel() { log.push(['cancel', id]); this.pending = []; this.status = 'idle'; append(session, 'agent/inbox/spliced', { inserted: [] }) },
      async whenIdle() { log.push(['idle', id]) },
      followup(message) { this.deliver('followup', message) }, steer(message) { this.deliver('steer', message) },
      deliver(mode, message) { this.sends.push({ mode, message }); this.pending.push(message); this.status = 'running'; append(session, 'agent/inbox/spliced', { inserted: [message] });
        if (controls.throwsAfterSend) throw new Error('PRIVATE_PROVIDER_ERROR') },
    }
    child.ctx.agent = child
    child.ctx.on = (_event, callback) => { child.hooks.push(callback); return () => {} }
    const handle = { agent: child, disposed: false, background: true, async dispose() { log.push(['dispose', id]); if (controls.failDispose) throw new Error('PRIVATE_CLEANUP_ERROR'); this.background = false; this.disposed = true; agents.delete(id) } }
    handles.push(handle)
    try {
      const setup = await options.setup(child.ctx)
      setup?.commit?.()
      if (controls.delay) await controls.delay.promise // Deliberately return a late handle to exercise consumer cleanup.
      agents.set(id, child)
      return handle
    } catch (error) { await handle.dispose(); throw error }
  }
  agents.create = options => create(options)
  agents.resume = options => create(options, true)
  const runtime = {
    captureDelegatedPolicyOverrides: () => ({ sandboxMode: 'workspace-write', approvalPolicy: 'never' }),
    appendDelegatedPolicyOverrides(session, value) { session.append('sandbox/mode', { mode: value.sandboxMode }); session.append('approval/policy', { policy: value.approvalPolicy }) },
    applyChildComposition(childCtx, parent) { assert.equal(parent, owner); childCtx.composed = true },
    installModelSelection(childCtx, selection) { childCtx.selection = selection },
  }
  const terminals = new NativeTerminals(ctx, events => events.findLast(event => event.type === 'sandbox/mode')?.data.mode, {}, runtime)
  const entries = terminals.owned(owner).entries
  for (let i = 1; i <= 16; i++) entries.set(`t${i}`, { id: `t${i}`, launcher: 'shell', settled: true, dismissed: false,
    controller: new AbortController(), data: [], bytes: 0, state: 'exited' })
  const runs = terminals.nativeRuns
  const send = (requestId = 'request-1', terminalId = 't1', prompt = '执行任务') => runs.send(owner, { terminalId, requestId, prompt })
  return { owner, agents, disk, handles, controls, ctx, runtime, terminals, runs, entries, send, append, log, hooks }
}

test('state is read-only and first send captures actual route, composition and a private owner-bound session', async () => {
  const f = fixture()
  const initial = await f.runs.state(f.owner, { terminalId: 't1' })
  assert.equal(initial.status, 'idle'); assert.equal(initial.canStop, false); assert.equal(initial.model, 'current-model'); assert.equal(f.handles.length, 0)
  const state = await f.send()
  assert.equal(state.status, 'running'); assert.equal(state.canStop, true); assert.equal(state.route.reasoningEffort, 'low')
  assert.equal(state.permission, '可修改当前工作区'); assert.deepEqual(state.acceptedRequestIds, ['request-1'])
  assert.equal(f.handles.length, 1); assert.equal(f.handles[0].agent.ctx.composed, true)
  assert.equal(f.handles[0].agent.ctx.selection.current.model, 'current-model')
  assert.equal(f.handles[0].agent.session.events.some(event => event.data?.sourceHistory), false)
  await f.runs.close()
})

test('identified duplicate requests do not run twice and an active helper receives steer', async () => {
  const f = fixture()
  await Promise.all([f.send(), f.send()])
  assert.equal(f.handles.length, 1); assert.equal(f.handles[0].agent.sends.length, 1)
  await f.send('request-2')
  assert.deepEqual(f.handles[0].agent.sends.map(call => call.mode), ['followup', 'steer'])
  await assert.rejects(f.send('request-1', 't1', '不同任务'), /不同内容/)
  assert.equal(f.handles[0].agent.sends.length, 2)
  await f.runs.close()
})

test('projection exposes only own input, assistant text and public tool steps', async () => {
  const f = fixture(); await f.send()
  const session = f.handles[0].agent.session
  f.append(session, 'user/message', { id: 'internal', role: 'user', source: { kind: 'plugin', plugin: 'system' }, content: [{ type: 'text', text: 'PRIVATE_INSTRUCTIONS' }] })
  f.append(session, 'request/header', { header: { system: 'PRIVATE_SYSTEM', config: { key: 'PRIVATE_KEY' } } })
  f.append(session, 'assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', text: 'PRIVATE_REASONING' } })
  f.append(session, 'assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', text: '可见流' } })
  f.append(session, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: '完整回答' }] } })
  f.append(session, 'tool/call', { turn: 1, step: 0, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' })
  f.append(session, 'tool/result', { turn: 1, step: 0, meta: { secret: 'PRIVATE_META' }, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '/workspace' }], isError: true }] } })
  f.append(session, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'PRIVATE_PROVIDER_ERROR' } } })
  f.handles[0].agent.status = 'idle'
  const state = await f.runs.state(f.owner, { terminalId: 't1' })
  assert.equal(state.status, 'failed'); assert.doesNotMatch(JSON.stringify(state), /PRIVATE_|可见流/)
  assert.equal(state.messages.find(message => message.role === 'assistant').text, '完整回答')
  assert.equal(state.messages.find(message => message.role === 'tool').status, 'failed')
  await f.runs.close()
})

test('stop during creation drains a late child handle and never sends input', async () => {
  const f = fixture(); f.controls.delay = Promise.withResolvers()
  const sending = assert.rejects(f.send(), /RUN_REJECTED/)
  while (!f.handles.length) await new Promise(resolve => setImmediate(resolve))
  const stopping = f.runs.stop(f.owner, { terminalId: 't1' })
  f.controls.delay.resolve()
  await Promise.all([sending, stopping])
  assert.equal(f.handles[0].disposed, true); assert.equal(f.handles[0].agent.sends.length, 0)
  assert.equal(f.runs.hasActive(f.owner), false)
  await f.runs.close()
})

test('stopping drains background resources after flush and explicit continuation resumes durable history', async () => {
  const f = fixture(); await f.send()
  const first = f.handles[0], sid = first.agent.id
  first.agent.status = 'idle'
  assert.equal(f.runs.hasActive(f.owner), true); assert.equal(first.background, true)
  const stopped = await f.runs.stop(f.owner, { terminalId: 't1' })
  assert.equal(stopped.status, 'idle'); assert.equal(stopped.canStop, false); assert.equal(first.background, false); assert.equal(f.agents.has(sid), false)
  assert.deepEqual(f.log.slice(-4).map(item => item[0]), ['cancel', 'idle', 'flush', 'dispose'])
  assert.deepEqual(stopped.acceptedRequestIds, ['request-1'])
  await f.send('request-2')
  assert.equal(f.handles.length, 2); assert.equal(f.handles[1].agent.id, sid)
  assert.equal(f.handles[1].agent.sends.length, 1)
  assert.deepEqual((await f.runs.state(f.owner, { terminalId: 't1' })).acceptedRequestIds, ['request-1', 'request-2'])
  await f.runs.close()
})

test('an uncertain delivery and failed checkpoint never resend the same identified message', async () => {
  const f = fixture(); f.controls.throwsAfterSend = true
  await assert.rejects(f.send(), error => !error.message.includes('PRIVATE_'))
  const state = await f.send()
  assert.deepEqual(state.acceptedRequestIds, ['request-1']); assert.equal(f.handles[0].agent.sends.length, 1)
  f.controls.throwsAfterSend = false; f.controls.flush = false
  await assert.rejects(f.send('request-2'), /保存尚未确认/)
  await f.send('request-2')
  assert.equal(f.handles[0].agent.sends.length, 2)
  f.controls.flush = true; await f.runs.close()
})

test('two running helpers enforce admission quota but permit steer and idle handles still fence permissions', async () => {
  const f = fixture()
  await f.send('r1', 't1'); await f.send('r2', 't2')
  await assert.rejects(f.send('r3', 't3'), /RUN_REJECTED.*两个/)
  await f.send('r4', 't1')
  f.handles.forEach(handle => { handle.agent.status = 'idle' })
  const dispatch = type => f.hooks[0]('serial', 'session/event', [f.owner.session, { type, data: type === 'permission/preset' ? { preset: 'readonly' } : type === 'approval/policy' ? { policy: 'never' } : { mode: 'read-only' } }])
  for (const type of ['permission/preset', 'approval/policy', 'sandbox/mode']) assert.throws(() => dispatch(type), /停止|关闭/)
  await f.runs.stop(f.owner, { terminalId: 't1' }); await f.runs.stop(f.owner, { terminalId: 't2' })
  for (const type of ['permission/preset', 'approval/policy', 'sandbox/mode']) assert.doesNotThrow(() => dispatch(type))
  await f.runs.close()
})

test('owner replacement and a forged persisted marker cannot acquire or address another execution session', async () => {
  const f = fixture(); await f.send(); await f.runs.stop(f.owner, { terminalId: 't1' })
  const sid = f.handles[0].agent.id
  f.disk.get(sid).events[0].data.ownerId = 'foreign'
  await assert.rejects(f.send('request-2'), /RUN_REJECTED.*不属于/)
  assert.equal(f.handles.at(-1).agent.sends.length, 0)
  f.agents.set(f.owner.id, { ...f.owner })
  await assert.rejects(f.runs.state(f.owner, { terminalId: 't1' }), /失效/)
  await f.runs.close()
})

test('restored request identities compare content before delivery rather than silently accepting changed input', async () => {
  const f = fixture(); await f.send(); await f.runs.stop(f.owner, { terminalId: 't1' })
  const runs = new NativeRuns(f.terminals, f.runtime)
  await assert.rejects(runs.send(f.owner, { terminalId: 't1', requestId: 'request-1', prompt: '改变内容' }), /不同内容/)
  assert.equal(f.handles.at(-1).agent.sends.length, 0)
  await runs.close(); await f.runs.close()
})

test('failed native cleanup preserves its ownership fence while terminal cleanup is still attempted', async () => {
  const f = fixture(); await f.send(); f.controls.failDispose = true
  let ptyCleaned = false
  Object.assign(f.entries.get('t1'), { settled: false, lease: 'lease', handle: { async terminate() { ptyCleaned = true } } })
  await assert.rejects(f.terminals.close(f.owner, { terminalId: 't1', lease: 'lease' }), /清理/)
  assert.equal(ptyCleaned, true); assert.equal(f.entries.has('t1'), true); assert.equal(f.runs.hasActive(f.owner), true)
  const failed = await f.runs.state(f.owner, { terminalId: 't1' })
  assert.equal(failed.canStop, true); assert.equal(failed.status, 'failed'); assert.match(failed.error, /清理/)
  f.controls.failDispose = false
  await f.terminals.close(f.owner, { terminalId: 't1', lease: 'lease' })
  assert.equal(f.entries.has('t1'), false)
  await f.runs.close()
})

test('owner disposal before the first creation await fences work and no replacement owner receives a late send', async () => {
  const f = fixture(); f.controls.delay = Promise.withResolvers()
  const pending = assert.rejects(f.send(), /RUN_REJECTED/)
  assert.equal(f.runs.hasActive(f.owner), true)
  while (!f.handles.length) await new Promise(resolve => setImmediate(resolve))
  const disposing = f.terminals.disposeOwner(f.owner, f.terminals.owners.get(f.owner))
  f.controls.delay.resolve()
  await Promise.all([pending, disposing])
  assert.equal(f.handles[0].disposed, true); assert.equal(f.handles[0].agent.sends.length, 0)
  assert.equal(f.runs.hasActive(f.owner), false)
})

test('idle helpers have a global bound and stopped handles release capacity without deleting durable histories', async () => {
  const f = fixture()
  for (let index = 1; index <= 12; index++) {
    await f.send(`r${index}`, `t${index}`)
    f.handles.at(-1).agent.status = 'idle'
  }
  await assert.rejects(f.send('r13', 't13'), /RUN_REJECTED.*数量上限/)
  assert.equal(f.handles.length, 12)
  await f.runs.stop(f.owner, { terminalId: 't1' })
  await f.send('r13', 't13')
  assert.equal(f.handles.length, 13); assert.equal(f.disk.size, 13)
  await f.runs.close()
})

test('the persisted request bound is checked again after recovery before admitting a new message', async () => {
  const f = fixture(); await f.send()
  const child = f.handles[0].agent, template = child.sends[0].message
  const prefix = template.id.slice(0, -Buffer.from('request-1').toString('base64url').length)
  for (let index = 2; index <= 256; index++) f.append(child.session, 'user/message', {
    ...template, id: prefix + Buffer.from(`request-${index}`).toString('base64url'), content: [{ type: 'text', text: '历史消息' }],
  })
  await f.runs.stop(f.owner, { terminalId: 't1' })
  const runs = new NativeRuns(f.terminals, f.runtime)
  await assert.rejects(runs.send(f.owner, { terminalId: 't1', requestId: 'new-request', prompt: '新消息' }), /RUN_REJECTED.*消息上限/)
  assert.equal(f.handles.at(-1).agent.sends.length, 0)
  assert.equal((await runs.state(f.owner, { terminalId: 't1' })).acceptedRequestIds.length, 128)
  await runs.close(); await f.runs.close()
})

test('the child session rejects its own permission changes before a preset can partially apply', async () => {
  const f = fixture(); await f.send()
  const child = f.handles[0].agent
  child.ctx.get = name => name === 'permissionPresets' ? { resolve: preset => preset === 'fixed' ? { sandbox: 'workspace-write', approval: 'never' } : { sandbox: 'danger-full-access', approval: 'ask' } } : f.owner.ctx.get(name)
  const dispatch = (type, data, session = child.session) => child.hooks[0]('serial', 'session/event', [session, { type, data }])
  assert.doesNotThrow(() => dispatch('permission/preset', { preset: 'fixed' }))
  assert.doesNotThrow(() => dispatch('sandbox/mode', { mode: 'workspace-write' }))
  assert.doesNotThrow(() => dispatch('approval/policy', { policy: 'never' }))
  assert.throws(() => dispatch('permission/preset', { preset: 'wider' }), /权限已固定/)
  assert.throws(() => dispatch('sandbox/mode', { mode: 'danger-full-access' }), /权限已固定/)
  assert.throws(() => dispatch('approval/policy', { policy: 'ask' }), /权限已固定/)
  assert.doesNotThrow(() => dispatch('approval/policy', { policy: 'ask' }, f.owner.session))
  await f.runs.close()
})

test('recovery rejects changed Agent presets and a widened persisted approval policy', async () => {
  for (const changed of ['preset', 'approval']) {
    const f = fixture(); await f.send(); await f.runs.stop(f.owner, { terminalId: 't1' })
    if (changed === 'preset') f.controls.preset = 'another-agent'
    else f.disk.get(f.handles[0].agent.id).events.push({ seq: 99, time: Date.now(), type: 'approval/policy', data: { policy: 'ask' } })
    await assert.rejects(f.send('request-2'), /RUN_REJECTED.*权限已变化/)
    assert.equal(f.handles.at(-1).agent.sends.length, 0)
    await f.runs.close()
  }
})

test('real Cordis consumer uses the optional sessions getter for creation, delivery and stop checkpoints', async () => {
  const f = fixture(), ctx = new Context(), supplied = Promise.withResolvers(), attached = Promise.withResolvers()
  const provider = ctx.plugin({ name: 'native-run-test-services', apply(providerCtx) {
    for (const [name, value] of Object.entries({ sessions: f.ctx.sessions, agents: f.agents, sandboxPolicy: f.ctx.sandboxPolicy,
      sessionPersistence: f.ctx.get('sessionPersistence'), apiProxy: f.ctx.get('apiProxy') })) providerCtx.provide(name, value)
    supplied.resolve()
  } })
  await supplied.promise
  const consumer = ctx.plugin({ name: 'native-run-test-consumer', inject: ['agents', 'sandboxPolicy'], apply(pluginCtx) {
    assert.throws(() => pluginCtx.sessions, /without inject/)
    f.runs.ctx = pluginCtx
    attached.resolve()
  } })
  await attached.promise
  try {
    assert.deepEqual((await f.send()).acceptedRequestIds, ['request-1'])
    await f.runs.stop(f.owner, { terminalId: 't1' })
    assert.equal(f.handles[0].disposed, true)
    assert.equal(f.log.filter(item => item[0] === 'flush').length, 3)
  } finally { await f.runs.close(); await consumer.dispose(); await provider.dispose() }
})

test('creation checkpoint failure preserves its first private cause while state omits internal rejection markers', async () => {
  const f = fixture(); f.controls.flush = false
  await assert.rejects(f.send(), /RUN_REJECTED.*执行记录尚未保存/)
  const record = f.runs.owners.get(f.owner).get('t1')
  assert.equal(record.diagnostic.phase, 'creation-checkpoint')
  const state = await f.runs.state(f.owner, { terminalId: 't1' })
  assert.doesNotMatch(state.error, /RUN_REJECTED/)
  assert.equal(Object.hasOwn(state, 'diagnostic'), false)
  assert.equal(state.canStop, false); assert.equal(f.handles[0].agent.sends.length, 0)
  f.controls.flush = true; await f.runs.close()
})

test('native originals are paged without trimming final text, hidden fields or new agent work', async () => {
  const f = fixture(); await f.send(); const session = f.handles[0].agent.session
  const original = 'ACTUAL_HEAD\n' + 'x'.repeat(18000) + '\nACTUAL_TAIL'
  f.append(session, 'assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: original } })
  let state = await f.runs.state(f.owner, { terminalId: 't1' }), preview = state.messages.at(-1)
  assert.equal(preview.truncated, true); assert.equal(preview.totalLength, original.length); assert.ok(preview.text.length <= 8000)
  assert.ok(preview.text.endsWith('ACTUAL_TAIL')); assert.equal(preview.resultRef, undefined)
  f.append(session, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: original }] } })
  state = await f.runs.state(f.owner, { terminalId: 't1' }); preview = state.messages.at(-1)
  assert.deepEqual(preview.resultRef, { terminalId: 't1', messageId: 'assistant-1-1' })
  const input = { ...preview.resultRef, offset: 0, limit: 8000 }, pages = []
  do { const page = await f.terminals.runResult(f.owner, input); assert.ok(page.text.length <= 8000); pages.push(page.text); input.offset = page.nextOffset; if (!page.hasMore) break } while (pages.length < 10)
  assert.equal(pages.join(''), original); assert.equal(f.handles.length, 1); assert.equal(f.handles[0].agent.sends.length, 1)
  await assert.rejects(f.terminals.runResult(f.owner, { ...input, messageId: 'assistant-99-99' }), /没有这条回复/)
  await assert.rejects(f.terminals.runResult(f.owner, { ...input, messageId: 'tool-private' }))
  await assert.rejects(f.terminals.runResult(f.owner, { ...input, limit: 16001 }))
  const end = await f.terminals.runResult(f.owner, { ...input, offset: original.length + 10 }); assert.equal(end.text, ''); assert.equal(end.hasMore, false)
  await f.runs.close()
})

test('closed terminal and cold original reads use the owned native history without reviving sessions', async () => {
  const f = fixture(); await f.send(); const handle = f.handles[0], session = handle.agent.session
  f.append(session, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Durable original' }] } })
  const input = { terminalId: 't1', messageId: 'assistant-1-1', offset: 0 }
  await f.runs.disposeTerminal(f.owner, 't1'); f.entries.delete('t1')
  assert.equal((await f.runs.result(f.owner, input)).text, 'Durable original')
  const cold = new NativeRuns(f.terminals, f.runtime), logs = f.log.length
  assert.equal((await cold.result(f.owner, input)).text, 'Durable original'); assert.equal(f.handles.length, 1); assert.equal(f.log.length, logs)
  await assert.rejects(cold.result(f.owner, { ...input, terminalId: 't2' }), /不可读取/)
  const foreign = { ...f.owner, id: 'foreign-owner', session: { ...f.owner.session, id: 'foreign-owner' } }; f.agents.set(foreign.id, foreign)
  await assert.rejects(cold.result(foreign, input), /不可读取/)
  const stored = f.disk.get(session.id), originalMarker = stored.events[0]
  stored.events[0] = { ...originalMarker, data: { ...originalMarker.data, ownerId: foreign.id } }
  await assert.rejects(cold.result(f.owner, input), /不属于/); stored.events[0] = originalMarker
  f.controls.preset = 'changed'; await assert.rejects(cold.result(f.owner, input), /不属于/); f.controls.preset = 'main'
  f.controls.inspectGate = Promise.withResolvers(); const pending = cold.result(f.owner, input), rejected = assert.rejects(pending, /关闭|变化/)
  await new Promise(resolve => setImmediate(resolve)); await cold.disposeOwner(f.owner); f.controls.inspectGate.resolve(); await rejected
  await assert.rejects(cold.result(f.owner, input), /关闭/)
  await cold.close(); await f.runs.close()
})
