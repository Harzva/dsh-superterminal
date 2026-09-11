import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { TerminalHandoffs, HandoffProtocol } from '../src/handoffs.mjs'
import { NativeTerminals } from '../src/terminals.mjs'
import { requests } from '../src/remote.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const owner = { id: 'origin-session', session: { events: [] } }, agents = new Map([[owner.id, owner]])
  const sources = new Map([['source', { id: 'source', launcher: 'codex' }]])
  const handles = [], deliveries = [], records = new Map(), persisted = []
  const policy = { mode: options.mode ?? 'workspace-write', workspaceRoot: '/tmp/handoff-fixture' }
  const journal = { async list(source) { return [...records.values()].filter(task => task.sourceSessionId === source.id) },
    async put(source, task) { if (options.failSave === true || (typeof options.failSave === 'function' && options.failSave(task))) throw new Error('storage unavailable'); assert.equal(source.id, task.sourceSessionId); records.set(task.id, structuredClone(task)); persisted.push(structuredClone(task)) }, async close() {} }
  const ctx = { agents, sandboxPolicy: { resolve: () => ({ ...policy }) }, get: name => name === 'sandbox' && !options.noSandbox ? { confine: argv => ({ argv: ['confined', ...argv] }) } : undefined,
    subprocess: { async resolveExecutable(name) { return `/bin/${name}` }, spawn(spec) {
      const stdout = new PassThrough(), done = Promise.withResolvers()
      const handle = { stdout, done: done.promise, terminated: false, spec, clean: true, stderr: '',
        collected: { stderr: { readFrom: () => ({ text: handle.stderr, nextOffset: handle.stderr.length, lossy: false }) } },
        finish(events, exitCode = 0, stderr = '') { this.stderr = stderr; stdout.end(events.map(value => JSON.stringify(value)).join('\n') + '\n'); done.resolve({ exitCode, signal: null }) },
        terminate() { this.terminated = true; stdout.end(); done.resolve({ exitCode: null, signal: 'SIGTERM' }) },
        async waitForExit() { return this.clean },
      }
      spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
      handles.push(handle)
      if (spec.argv.includes('login') && spec.argv.includes('status')) {
        handle.clean = options.loginClean ?? true
        if (!options.loginWait) queueMicrotask(() => handle.finish([], options.loginExit ?? 0, options.loginStderr ?? 'Logged in using ChatGPT'))
      }
      return handle
    } } }
  const terminals = { ctx, current(source) { if (agents.get(source.id) !== source) throw new Error('owner 已失效') }, owned(source) { this.current(source); return {} },
    entry(source, id) { this.current(source); if (source !== owner || !sources.has(id)) throw new Error('当前会话没有这个终端'); return sources.get(id) },
    launcherCatalog: () => [{ id: 'shell', label: 'Shell' }, { id: 'pi', label: 'Pi' }, { id: 'piagent', label: 'Pi Agent' }, { id: 'codex', label: 'Codex' }, { id: 'kimi', label: 'Kimi' }] }
  const handoffs = new TerminalHandoffs(terminals, { journal, timeoutMs: options.timeoutMs, loginTimeoutMs: options.loginTimeoutMs,
    deliver: async input => { deliveries.push(input); return { status: 'queued', messageId: 'returned-message' } } })
  const start = changes => handoffs.start(owner, requests.handoffStart.parse({ requestId: 'request-1', sourceTerminalId: 'source', targetLauncher: 'pi', prompt: 'Review the change', ...changes }))
  return { owner, agents, sources, policy, handles, deliveries, records, persisted, handoffs, start }
}

const piResult = text => [{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } }, { type: 'agent_end' }]
async function completed(f, changes) {
  const task = await f.start(changes)
  await tick(); f.handles.at(-1).finish(piResult('Returned result for review'))
  return settle(f, task)
}
async function settle(f, task) { const job = f.handoffs.states.get(f.owner).active.get(task.id); if (job) await job.done; return (await f.handoffs.list(f.owner)).tasks.find(row => row.id === task.id) }

test('discussion participation cannot be accepted, reworked or returned as an execution deliverable', async () => {
  const f = fixture()
  const task = await f.handoffs.start(f.owner, { requestId: 'discussion', sourceTerminalId: 'source', targetLauncher: 'pi',
    sourceGroupId: 'group', groupPurpose: 'discussion', prompt: 'Discuss only; do not execute', returnToConversation: false })
  await tick(); f.handles[0].finish(piResult('A discussion opinion'))
  const result = await settle(f, task), saved = f.persisted.length
  assert.equal(result.groupPurpose, 'discussion')
  assert.equal((await f.handoffs.accept(f.owner, { taskId: task.id, requestId: 'accept-discussion' })).rejected, true)
  assert.equal((await f.handoffs.rework(f.owner, { taskId: task.id, requestId: 'rework-discussion', issues: 'Implement this' })).rejected, true)
  await assert.rejects(f.handoffs.returnResult(f.owner, { taskId: task.id }), /讨论组发言/)
  assert.equal(f.records.get(task.id).acceptance, 'pending'); assert.equal(f.records.get(task.id).delivery, 'none')
  assert.equal(f.persisted.length, saved); assert.equal(f.handles.length, 1); assert.equal(f.deliveries.length, 0)
  await f.handoffs.close()
})

test('group execution replays accepted identity before mutable membership gates without admitting changed or foreign requests', async () => {
  const f = fixture()
  let group = { id: 'group', members: [{ terminalId: 'source' }], archived: false }, reads = 0, unavailable = false
  const facade = { handoffs: f.handoffs, current: owner => f.handoffs.terminals.current(owner), groups: { async read(owner) {
    reads++
    if (owner !== f.owner || unavailable) throw new Error('group unavailable')
    return group
  } } }
  const input = { requestId: 'execute-group', sourceTerminalId: 'source', sourceGroupId: 'group', targetLauncher: 'pi', prompt: 'Execute the agreed conclusion' }
  const start = (changes = {}, owner = f.owner) => NativeTerminals.prototype.handoffStart.call(facade, owner, { ...input, ...changes })
  const original = await start(); await tick(); f.handles[0].finish(piResult('Executed conclusion'))
  await settle(f, original)
  assert.equal(reads, 1); assert.equal(f.records.get(original.id).groupPurpose, 'execution')
  group = { ...group, archived: true }
  assert.equal((await start()).id, original.id)
  assert.equal((await start({ requestId: 'new-archived' })).rejected, true)
  group = { ...group, archived: false, members: [{ terminalId: 'another-source' }] }
  assert.equal((await start()).id, original.id)
  assert.equal((await start({ requestId: 'new-removed' })).rejected, true)
  const checked = reads
  assert.equal((await start({ prompt: 'Different content' })).rejected, true)
  assert.equal((await start({ sourceGroupId: 'different-group' })).rejected, true)
  assert.equal(reads, checked)
  unavailable = true
  assert.equal((await start()).id, original.id)
  assert.equal((await start({ requestId: 'new-unavailable' })).rejected, true)
  const foreign = { id: 'foreign', session: { events: [] } }; f.agents.set(foreign.id, foreign)
  assert.equal((await start({}, foreign)).rejected, true)
  f.sources.delete('source')
  assert.equal((await start()).id, original.id)
  assert.equal(f.handles.length, 1); assert.equal(f.records.size, 1)
  f.agents.set(f.owner.id, { ...f.owner })
  await assert.rejects(start(), /已失效/)
  f.agents.set(f.owner.id, f.owner)
  await f.handoffs.close()
})

test('group execution retains its purpose through rework and supports explicit deliverable acceptance', async () => {
  const f = fixture()
  const original = await f.handoffs.start(f.owner, { requestId: 'execute', sourceTerminalId: 'source', targetLauncher: 'pi',
    sourceGroupId: 'group', groupPurpose: 'execution', prompt: 'Execute the agreed conclusion', returnToConversation: false })
  await tick(); f.handles[0].finish(piResult('Initial implementation')); await settle(f, original)
  const child = await f.handoffs.rework(f.owner, { taskId: original.id, requestId: 'fix-execution', issues: 'Fix the missing boundary' })
  assert.equal(child.sourceGroupId, 'group'); assert.equal(child.groupPurpose, 'execution')
  await tick(); f.handles[1].finish(piResult('Corrected implementation')); await settle(f, child)
  assert.equal((await f.handoffs.accept(f.owner, { taskId: child.id, requestId: 'accept-execution' })).acceptance, 'accepted')
  assert.equal((await f.handoffs.returnResult(f.owner, { taskId: child.id })).delivery, 'queued')
  assert.equal(f.deliveries.length, 1)
  await f.handoffs.close()
})

test('explicit acceptance is durable and idempotent without changing execution completion or accepting future work', async () => {
  const f = fixture(), original = await completed(f)
  assert.equal(original.acceptance, 'pending'); assert.equal(typeof original.executionFinishedAt, 'number')
  const input = {taskId: original.id, requestId: 'accept-1', notes: 'Checked the stated criteria'}
  const first = await f.handoffs.accept(f.owner, input)
  const replay = await f.handoffs.accept(f.owner, input)
  assert.equal(first.acceptance, 'accepted'); assert.equal(replay.reviewedAt, first.reviewedAt)
  assert.equal(first.executionFinishedAt, original.executionFinishedAt)
  assert.equal(f.records.get(original.id).reviewNotes, input.notes)
  assert.equal((await f.handoffs.accept(f.owner, {...input, notes:'changed'})).rejected, true)
  assert.equal((await f.handoffs.rework(f.owner, {taskId: original.id, requestId:'rework-accepted', issues:'Change it'})).rejected, true)
  await f.handoffs.returnResult(f.owner, {taskId:original.id})
  assert.equal(f.records.get(original.id).acceptance, 'accepted')
  assert.equal(f.records.get(original.id).executionFinishedAt, original.executionFinishedAt)
  const foreign = {id:'other',session:{events:[]}}; f.agents.set(foreign.id,foreign)
  await assert.rejects(f.handoffs.accept(foreign, input), /没有这项/)
  assert.equal(f.handles.length, 1)
  await f.handoffs.close()
})

test('failed acceptance persistence remains pending in the UI and reuses its original review timestamp', async () => {
  let fail = false
  const f = fixture({failSave: task => fail && task.acceptance === 'accepted'})
  const task = await completed(f)
  fail = true
  const input = {taskId:task.id, requestId:'accept-delayed',notes:'Verified'}
  await assert.rejects(f.handoffs.accept(f.owner,input), /storage unavailable/)
  const pending = (await f.handoffs.list(f.owner)).tasks[0]
  assert.equal(pending.acceptance,'pending'); assert.equal(pending.savePending,true)
  assert.equal(f.handoffs.observation(f.owner)[0].acceptance,'pending')
  assert.equal(f.records.get(task.id).acceptance,'pending')
  const stamp = f.handoffs.states.get(f.owner).reviewCandidates.get(task.id).reviewedAt
  assert.equal((await f.handoffs.rework(f.owner,{taskId:task.id,requestId:'wrong-race',issues:'retry'})).rejected,true)
  assert.equal((await f.handoffs.accept(f.owner,{...input,requestId:'another'})).rejected,true)
  fail = false
  const saved = await f.handoffs.accept(f.owner,input)
  assert.equal(saved.acceptance,'accepted'); assert.equal(saved.reviewedAt,stamp)
  assert.equal(saved.savePending,undefined); assert.equal(f.handles.length,1)
  await f.handoffs.close()
})

test('closed-source rework carries bounded untrusted prior results and makes one linked task per request', async () => {
  const f=fixture(), original=await f.start({prompt:'Original goal',criteria:'Original criteria',excerpt:'DO_NOT_RESHARE',returnToConversation:true})
  await tick(); f.handles[0].finish(piResult('UNTRUSTED_RESULT_START'+ 'x'.repeat(14000)+'UNTRUSTED_RESULT_END'))
  const parent=await settle(f,original); f.sources.delete('source')
  const input={taskId:parent.id,requestId:'rework-1',issues:'Fix the missing boundary check',targetLauncher:'pi'}
  const [child,replay]=await Promise.all([f.handoffs.rework(f.owner,input),f.handoffs.rework(f.owner,input)])
  assert.equal(child.id,replay.id); assert.equal(child.parentTaskId,parent.id); assert.equal(child.acceptance,'pending')
  assert.equal(child.prompt,'Original goal'); assert.equal(child.criteria,'Original criteria')
  assert.ok(child.previousResult.length<=8000); assert.match(child.previousResult,/中间部分已省略/)
  assert.equal(f.records.get(parent.id).reworkTaskId,child.id); assert.equal(f.records.get(parent.id).acceptance,'rework')
  await tick(); assert.equal(f.handles.length,2)
  const prompt=f.handles[1].spec.stdio.stdin.data
  assert.match(prompt,/不可信资料/); assert.match(prompt,/Fix the missing boundary check/)
  assert.match(prompt,/UNTRUSTED_RESULT_START/); assert.match(prompt,/UNTRUSTED_RESULT_END/)
  assert.doesNotMatch(prompt,/DO_NOT_RESHARE/)
  assert.equal((await f.handoffs.rework(f.owner,{...input,issues:'Different request content'})).rejected,true)
  assert.equal((await f.handoffs.rework(f.owner,{...input,requestId:'duplicate-child'})).rejected,true)
  const foreign={id:'other',session:{events:[]}}; f.agents.set(foreign.id,foreign)
  await assert.rejects(f.handoffs.rework(foreign,input),/没有这项/)
  f.handles[1].finish(piResult('Fixed result')); const returned=await settle(f,child)
  assert.equal(returned.acceptance,'pending'); assert.equal(returned.delivery,'queued')
  await f.handoffs.accept(f.owner,{taskId:child.id,requestId:'accept-child',notes:'Checked fixed boundary'})
  const observation=f.handoffs.observation(f.owner)
  assert.equal(observation.find(row=>row.id===child.id).parentTaskId,parent.id)
  assert.equal(observation.find(row=>row.id===child.id).acceptance,'accepted')
  assert.doesNotMatch(JSON.stringify(observation),/UNTRUSTED_RESULT|Fixed result|DO_NOT_RESHARE/)
  assert.equal(f.deliveries.length,2)
  await f.handoffs.close()
})

test('rework validates explicit issues and settled state before allocating another execution', async () => {
  const f=fixture(), task=await f.start()
  const input={taskId:task.id,requestId:'review-1',issues:'Specific issue'}
  assert.equal((await f.handoffs.rework(f.owner,input)).rejected,true)
  assert.equal((await f.handoffs.accept(f.owner,{taskId:task.id,requestId:'accept-running'})).rejected,true)
  await tick(); f.handles[0].finish(piResult('Result')); await settle(f,task)
  for(const issues of ['', '   ', 'x'.repeat(4001)]) assert.equal((await f.handoffs.rework(f.owner,{...input,issues})).rejected,true)
  f.policy.mode='unknown'
  assert.equal((await f.handoffs.rework(f.owner,input)).rejected,true)
  assert.equal(f.handles.length,1)
  await f.handoffs.close()
})

test('partial rework persistence cannot spawn twice across retries or a restored owner state', async () => {
  let fail=false
  const f=fixture({failSave:task=>fail && task.acceptance==='rework'})
  const parent=await completed(f); fail=true
  const input={taskId:parent.id,requestId:'rework-save',issues:'Correct the issue'}
  await assert.rejects(f.handoffs.rework(f.owner,input),/storage unavailable/)
  await tick(); assert.equal(f.handles.length,1)
  fail=false
  const rows=(await f.handoffs.list(f.owner)).tasks
  const child=rows.find(row=>row.parentTaskId===parent.id)
  assert.equal(child.status,'failed')
  assert.equal((await f.handoffs.rework(f.owner,input)).id,child.id)
  await f.handoffs.disposeOwner(f.owner)
  assert.equal((await f.handoffs.rework(f.owner,input)).id,child.id)
  assert.equal(f.handles.length,1)
  await f.handoffs.close()
})

test('cancelling a rework keeps its lineage and retry identity without accepting its parent', async () => {
  const f=fixture(),parent=await completed(f)
  const input={taskId:parent.id,requestId:'rework-cancel',issues:'Recheck'}
  const child=await f.handoffs.rework(f.owner,input); await tick()
  await f.handoffs.cancel(f.owner,{taskId:child.id})
  assert.equal((await f.handoffs.rework(f.owner,input)).status,'cancelled')
  assert.equal(f.records.get(parent.id).acceptance,'rework')
  assert.equal(f.records.get(child.id).parentTaskId,parent.id)
  assert.equal(f.handles.length,2)
  await f.handoffs.close()
})

test('acceptance and result return cannot overwrite each other while their durability writes are pending', async () => {
  const f=fixture(), task=await completed(f), gate=Promise.withResolvers()
  f.handoffs.deliver=async()=>{await gate.promise;return {status:'queued',messageId:'one'}}
  const returning=f.handoffs.returnResult(f.owner,{taskId:task.id}); await tick()
  assert.equal((await f.handoffs.accept(f.owner,{taskId:task.id,requestId:'accept-after-return'})).rejected,true)
  gate.resolve(); await returning
  const saved=await f.handoffs.accept(f.owner,{taskId:task.id,requestId:'accept-after-return'})
  assert.equal(saved.delivery,'queued'); assert.equal(f.records.get(task.id).acceptance,'accepted')
  await f.handoffs.close()
  const g=fixture(), second=await completed(g), writeGate=Promise.withResolvers(), put=g.handoffs.journal.put
  g.handoffs.journal.put=async(owner,row)=>{if(row.acceptance==='accepted') await writeGate.promise;return put(owner,row)}
  const accepting=g.handoffs.accept(g.owner,{taskId:second.id,requestId:'accept-first'}); await tick()
  await assert.rejects(g.handoffs.returnResult(g.owner,{taskId:second.id}),/验收记录正在确认/)
  writeGate.resolve(); await accepting
  await g.handoffs.returnResult(g.owner,{taskId:second.id})
  assert.equal(g.records.get(second.id).delivery,'queued'); assert.equal(g.records.get(second.id).acceptance,'accepted')
  await g.handoffs.close()
})

test('real background handoff preserves source, uses confined stdin, returns final result to the captured owner once', async () => {
  const f = fixture()
  const task = await f.start({ excerpt: 'EXPLICIT_EXCERPT', criteria: 'Explain the check', returnToConversation: true })
  await tick()
  assert.equal(f.handles.length, 1)
  const spec = f.handles[0].spec
  assert.equal(spec.argv[0], 'confined')
  assert.deepEqual(spec.argv.slice(-5), ['/bin/pi', '--print', '--mode', 'json', '--no-session'])
  assert.equal(spec.argv.some(value => value.includes('EXPLICIT_EXCERPT')), false)
  assert.ok(spec.stdio.stdin.data.includes('EXPLICIT_EXCERPT'))
  assert.equal(spec.env.DSH_SESSION_ID, f.owner.id)
  assert.ok(spec.env.PI_CODING_AGENT_DIR.endsWith('/.dsh-terminal/pi'))
  f.handles[0].finish([{ type: 'tool_execution_end', result: { content: [{ type: 'text', text: 'PRIVATE_TOOL_OUTPUT' }] } }, ...piResult('Review returned')])
  const result = await settle(f, task)
  assert.equal(result.status, 'succeeded'); assert.equal(result.result, 'Review returned')
  assert.equal(result.delivery, 'queued'); assert.equal(result.messageId, 'returned-message')
  assert.equal(result.sourceLauncher, 'codex'); assert.equal(result.targetLauncher, 'pi')
  assert.equal(f.deliveries[0].owner, f.owner)
  assert.ok(f.persisted.some(row => row.status === 'succeeded' && row.delivery === 'none'))
  assert.equal(JSON.stringify(f.persisted).includes('PRIVATE_TOOL_OUTPUT'), false)
  const observation = f.handoffs.observation(f.owner)
  assert.deepEqual(observation, [{ id: task.id, sourceTerminalId: 'source', sourceLauncher: 'codex', targetLauncher: 'pi',
    status: 'succeeded', delivery: 'queued', goal: 'Review the change', criteria: 'Explain the check', acceptance: 'pending' }])
  assert.equal(JSON.stringify(observation).includes('EXPLICIT_EXCERPT'), false)
  assert.equal(JSON.stringify(observation).includes('Review returned'), false)
  await f.handoffs.returnResult(f.owner, { taskId: task.id })
  assert.equal(f.deliveries.length, 1)
  f.sources.delete('source')
  const replay = await f.start({ excerpt: 'EXPLICIT_EXCERPT', criteria: 'Explain the check', returnToConversation: true })
  assert.equal(replay.id, task.id); assert.equal(f.handles.length, 1)
  await f.handoffs.close()
})

test('identity and quota checks reject forged sources, replay collisions, foreign owners and a third concurrent task', async () => {
  const f = fixture()
  assert.deepEqual(await f.start({ sourceTerminalId: 'foreign' }), { rejected: true, message: '来源终端已不可用，请重新选择当前会话中的终端' })
  assert.deepEqual(await f.start({ targetLauncher: 'kimi' }), { rejected: true, message: '这个智能体暂不支持后台交接' })
  assert.equal(f.records.size, 0)
  const one = await f.start(), two = await f.start({ requestId: 'request-2', targetLauncher: 'codex' })
  assert.equal((await f.start({ prompt: 'another task' })).rejected, true)
  assert.match((await f.start({ requestId: 'third' })).message, /2 项/)
  const foreign = { id: 'other', session: { events: [] } }; f.agents.set(foreign.id, foreign)
  await assert.rejects(f.handoffs.cancel(foreign, { taskId: one.id }), /没有这项/)
  await f.handoffs.cancel(f.owner, { taskId: one.id }); await f.handoffs.cancel(f.owner, { taskId: two.id })
  assert.equal(f.handoffs.activeCount, 0)
  f.agents.set(f.owner.id, { ...f.owner })
  await assert.rejects(f.handoffs.list(f.owner), /已失效/)
  await f.handoffs.close()
})

test('request cancellation after acceptance does not cancel the background task; explicit cancellation does', async () => {
  const f = fixture(), request = new AbortController()
  const task = await f.handoffs.start(f.owner, requests.handoffStart.parse({ requestId: 'one', sourceTerminalId: 'source', targetLauncher: 'pi', prompt: 'work' }), request.signal)
  await tick(); request.abort(); await tick()
  assert.equal(f.handles[0].terminated, false)
  const result = await f.handoffs.cancel(f.owner, { taskId: task.id })
  assert.equal(result.status, 'cancelled'); assert.equal(f.handles[0].terminated, true)
  assert.equal(f.records.get(task.id).status, 'cancelled'); assert.equal(f.records.get(task.id).prompt, 'work')
  assert.equal(f.deliveries.length, 0)
  await f.handoffs.close()
})

test('Pi JSON errors and missing completion markers are failures even when the process exits zero', async () => {
  for (const events of [
    [{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'not done' }], stopReason: 'error' } }, { type: 'agent_end' }],
    [{ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'not done' }], stopReason: 'stop' } }],
    [{ type: 'agent_end' }],
  ]) {
    const f = fixture(), task = await f.start(); await tick(); f.handles[0].finish(events)
    const result = await settle(f, task)
    assert.equal(result.status, 'failed'); assert.equal(result.result, undefined)
    assert.equal(f.deliveries.length, 0)
    await f.handoffs.close()
  }
  const protocol = new HandoffProtocol('codex')
  protocol.accept({ type: 'item.completed', item: { type: 'agent_message', text: 'Final reply' } })
  assert.throws(() => protocol.finish(0), /完整/)
  protocol.accept({ type: 'turn.completed' }); assert.equal(protocol.finish(0), 'Final reply')
  protocol.accept({ type: 'turn.failed' }); assert.throws(() => protocol.finish(0), /正常返回/)
})

test('Pi automatic retry accepts the final successful reply without treating the retrying agent_end as completion', async () => {
  // Pi 0.84.4 emits the failed run before auto_retry_start, then starts a new
  // agent run. auto_retry_end precedes its final agent_end / agent_settled.
  const retrying = [
    { type: 'agent_start' },
    { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Temporary provider error' } },
    { type: 'agent_end', willRetry: true },
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'Temporary provider error' },
  ]
  const recovered = [
    { type: 'agent_start' },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Review returned after retry' }], stopReason: 'stop' } },
    { type: 'auto_retry_end', success: true, attempt: 1 },
    { type: 'agent_end', willRetry: false },
    { type: 'agent_settled' },
  ]
  const protocol = new HandoffProtocol('pi')
  for (const event of retrying) protocol.accept(event)
  assert.equal(protocol.complete, false)
  assert.throws(() => protocol.finish(0), /正常返回|完整/)
  for (const event of recovered.slice(0, 3)) protocol.accept(event)
  assert.throws(() => protocol.finish(0), /完整/)
  const f = fixture(), task = await f.start({ returnToConversation: true })
  await tick(); f.handles[0].finish([...retrying, ...recovered])
  const result = await settle(f, task)
  assert.equal(result.status, 'succeeded')
  assert.equal(result.result, 'Review returned after retry')
  assert.equal(result.delivery, 'queued'); assert.equal(f.deliveries.length, 1)
  await f.handoffs.close()
})

test('missing sandbox and failed persistence prevent process allocation; a timeout terminates the managed tree', async () => {
  const missing = fixture({ noSandbox: true }), blocked = await missing.start()
  assert.equal((await settle(missing, blocked)).status, 'failed'); assert.equal(missing.handles.length, 0)
  await missing.handoffs.close()
  const storage = fixture({ failSave: true })
  await assert.rejects(storage.start(), /storage unavailable/)
  await tick(); assert.equal(storage.handles.length, 0); await storage.handoffs.close()
  const timed = fixture({ timeoutMs: 15 }), task = await timed.start()
  const result = await settle(timed, task)
  assert.equal(result.status, 'failed'); assert.match(result.error, /超过/); assert.equal(timed.handles[0].terminated, true)
  assert.equal(timed.records.get(task.id).status, 'failed'); assert.equal(timed.records.get(task.id).sourceTerminalId, 'source')
  await timed.handoffs.close()
})

test('owner shutdown drains running tasks and task API schemas reject undeclared fields', async () => {
  const f = fixture(), task = await f.start(); await tick()
  await f.handoffs.disposeOwner(f.owner)
  assert.equal(f.handles[0].terminated, true); assert.equal(f.handoffs.activeCount, 0)
  assert.equal(f.records.get(task.id).status, 'cancelled')
  assert.throws(() => requests.handoffStart.parse({ requestId: 'one', sourceTerminalId: 'source', targetLauncher: 'pi', prompt: 'work', sourceSessionId: 'forged' }))
  assert.throws(() => requests.handoffStart.parse({ requestId: 'one', sourceTerminalId: 'source', targetLauncher: '../bash', prompt: 'work' }))
  await f.handoffs.close()
})

test('owner disposal aborts a pending result return before the original conversation is woken', async () => {
  const f = fixture(), task = await f.start(); await tick(); f.handles[0].finish(piResult('Done'))
  await settle(f, task)
  const gate = Promise.withResolvers()
  let queued = false
  f.handoffs.deliver = async ({ signal }) => { await gate.promise; signal.throwIfAborted(); queued = true; return { messageId: 'late', status: 'queued' } }
  const returning = f.handoffs.returnResult(f.owner, { taskId: task.id })
  const rejected = assert.rejects(returning, /暂未送回|暂未确认/)
  await tick()
  const disposing = f.handoffs.disposeOwner(f.owner)
  gate.resolve()
  await Promise.all([rejected, disposing])
  assert.equal(queued, false)
  await f.handoffs.close()
})

test('unproven process cleanup retains the running action and blocks capacity until an explicit retry succeeds', async () => {
  const f = fixture(), task = await f.start(); await tick()
  f.handles[0].clean = false
  f.handles[0].finish(piResult('Returned'))
  const result = await settle(f, task)
  assert.equal(result.status, 'running'); assert.match(result.error, /清理/)
  assert.equal(f.handoffs.hasActive(f.owner), true)
  f.handles[0].clean = true
  const closed = await f.handoffs.cancel(f.owner, { taskId: task.id })
  assert.equal(closed.status, 'cancelled'); assert.equal(f.handoffs.hasActive(f.owner), false)
  assert.equal(f.handoffs.activeCount, 0)
  await f.handoffs.close()
})

test('installation remains unverified and real CLI failures preserve actionable context without raw diagnostics', async () => {
  const cases = [
    { targetLauncher: 'pi', events: [], exit: 1, stderr: 'No models available. Use /login to log into a provider. /private/PRIVATE_PATH', expected: /模型配置/ },
    { targetLauncher: 'pi', events: [{ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 Unauthorized. Authorization: Bearer PRIVATE_TOKEN' } }, { type: 'agent_end' }], exit: 0, expected: /登录或凭据/ },
    { targetLauncher: 'codex', events: [{ type: 'turn.failed', error: { message: 'insufficient_quota: PRIVATE_ACCOUNT' } }], exit: 1, expected: /额度或订阅/ },
    { targetLauncher: 'codex', events: [], exit: 2, stderr: "error: unexpected argument '--ephemeral' found; PRIVATE_PATH", expected: /当前版本/ },
  ]
  for (const scenario of cases) {
    const f = fixture(), targets = await f.handoffs.targets()
    assert.equal(targets.find(row => row.id === scenario.targetLauncher).available, true)
    assert.match(targets.find(row => row.id === scenario.targetLauncher).reason, /已检测到安装.*仍待实际任务确认/)
    const task = await f.start({ targetLauncher: scenario.targetLauncher, criteria: 'Explain the cause', excerpt: 'Shared context' })
    await tick(); f.handles.at(-1).finish(scenario.events, scenario.exit, scenario.stderr)
    const result = await settle(f, task)
    assert.equal(result.status, 'failed'); assert.match(result.error, scenario.expected)
    assert.equal(result.exitCode, scenario.exit); assert.equal(result.result, undefined)
    assert.equal(result.prompt, 'Review the change'); assert.equal(result.criteria, 'Explain the cause')
    assert.equal(f.records.get(task.id).excerpt, 'Shared context')
    assert.equal(JSON.stringify(f.persisted).includes('PRIVATE_'), false)
    await f.handoffs.close()
  }
})

test('failed final persistence keeps the original failure and retries the record without rerunning the task', async () => {
  let offline = true
  const f = fixture({ failSave: task => offline && task.status === 'failed' })
  const input = { criteria: 'Explain the cause', excerpt: 'Shared context' }
  const task = await f.start(input); await tick()
  f.handles[0].finish([{ type: 'turn.failed', error: { message: 'Unauthorized' } }], 1, 'No API key found')
  const unsaved = await settle(f, task)
  assert.match(unsaved.error, /登录或凭据/); assert.match(unsaved.error, /暂未保存/)
  assert.equal(unsaved.delivery, 'none'); assert.equal(f.handoffs.activeCount, 0)
  assert.equal(f.records.get(task.id).status, 'running')
  offline = false
  const recovered = (await f.handoffs.list(f.owner)).tasks.find(row => row.id === task.id)
  assert.match(recovered.error, /登录或凭据/); assert.doesNotMatch(recovered.error, /暂未保存/)
  assert.equal(f.records.get(task.id).status, 'failed'); assert.equal(f.records.get(task.id).criteria, input.criteria)
  const replay = await f.start(input)
  assert.equal(replay.id, task.id); assert.equal(f.handles.length, 1)
  await f.handoffs.close()
})

test('concurrent cleanup retries release capacity only once even when cancellation persistence initially fails', async () => {
  let offline = true
  const f = fixture({ failSave: task => offline && task.status === 'cancelled' })
  const task = await f.start(); await tick()
  f.handles[0].clean = false; f.handles[0].finish([], 1, 'No API key found')
  const stopping = await settle(f, task)
  assert.match(stopping.error, /登录或凭据/); assert.match(stopping.error, /清理/)
  const cleanup = Promise.withResolvers()
  f.handles[0].waitForExit = () => cleanup.promise
  const one = f.handoffs.cancel(f.owner, { taskId: task.id })
  const two = f.handoffs.cancel(f.owner, { taskId: task.id })
  const outcomes = Promise.allSettled([one, two])
  await tick(); cleanup.resolve(true)
  assert.ok((await outcomes).every(result => result.status === 'rejected'))
  assert.equal(f.handoffs.activeCount, 0); assert.equal(f.handoffs.hasActive(f.owner), false)
  const unsaved = (await f.handoffs.list(f.owner)).tasks.find(row => row.id === task.id)
  assert.equal(unsaved.status, 'cancelled'); assert.match(unsaved.error, /交接已停止/); assert.match(unsaved.error, /暂未保存/)
  assert.match(unsaved.error, /登录或凭据/); assert.doesNotMatch(unsaved.error, /清理/)
  offline = false
  await f.handoffs.list(f.owner)
  assert.equal(f.records.get(task.id).status, 'cancelled')
  const next = await f.start({ requestId: 'next' }); await tick()
  assert.equal(f.handoffs.activeCount, 1)
  await f.handoffs.cancel(f.owner, { taskId: next.id })
  assert.equal(f.handoffs.activeCount, 0)
  await f.handoffs.close()
})

test('Codex login preflight uses isolated file credentials and rejects missing login before sending the task', async () => {
  const f = fixture({ loginExit: 1, loginStderr: 'Not logged in' })
  const task = await f.start({ targetLauncher: 'codex', excerpt: 'Shared task details' })
  const result = await settle(f, task)
  assert.equal(f.handles.length, 1)
  const login = f.handles[0]
  assert.equal(login.spec.argv[0], 'confined')
  assert.deepEqual(login.spec.argv.slice(-5), ['/bin/codex', 'login', 'status', '-c', 'cli_auth_credentials_store="file"'])
  assert.equal(login.spec.stdio.stdin, 'ignore')
  assert.equal(login.spec.env.CODEX_HOME, '/tmp/handoff-fixture/.dsh-terminal/codex')
  assert.equal(login.spec.env.CODEX_SQLITE_HOME, login.spec.env.CODEX_HOME)
  assert.equal(login.spec.cwd, '/tmp/handoff-fixture')
  assert.equal(JSON.stringify(login.spec).includes('Shared task details'), false)
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 1); assert.match(result.error, /登录或凭据/)
  assert.equal(f.records.get(task.id).excerpt, 'Shared task details')
  assert.equal(login.terminated, true); assert.equal(f.handoffs.activeCount, 0)
  await f.handoffs.close()
})

test('Codex executes only after the logged-in preflight tree exits and does not retain login output', async () => {
  const f = fixture({ loginStderr: 'Logged in using an API key - PRIVATE_KEY_FRAGMENT' })
  const task = await f.start({ targetLauncher: 'codex' }); await tick()
  assert.equal(f.handles.length, 2)
  const [login, execution] = f.handles
  assert.equal(login.terminated, true)
  assert.deepEqual(execution.spec.env, login.spec.env)
  assert.equal(execution.spec.cwd, login.spec.cwd)
  assert.equal(execution.spec.argv[0], 'confined')
  assert.ok(execution.spec.argv.includes('exec')); assert.ok(execution.spec.stdio.stdin.data.includes('Review the change'))
  execution.finish([{ type: 'item.completed', item: { type: 'agent_message', text: 'Review returned' } }, { type: 'turn.completed' }])
  const result = await settle(f, task)
  assert.equal(result.status, 'succeeded'); assert.equal(result.result, 'Review returned')
  assert.equal(JSON.stringify(f.persisted).includes('PRIVATE_KEY_FRAGMENT'), false)
  assert.equal(f.handoffs.activeCount, 0)
  await f.handoffs.close()
})

test('Codex preflight timeout, cancellation and unproven cleanup never start exec or bypass capacity', async () => {
  const timed = fixture({ loginWait: true, loginTimeoutMs: 15 })
  const task = await timed.start({ targetLauncher: 'codex' })
  const result = await settle(timed, task)
  assert.equal(result.status, 'failed'); assert.match(result.error, /登录检查超时/)
  assert.equal(timed.handles.length, 1); assert.equal(timed.handles[0].terminated, true)
  assert.equal(timed.handoffs.activeCount, 0); await timed.handoffs.close()

  const cancelled = fixture({ loginWait: true })
  const one = await cancelled.start({ targetLauncher: 'codex' })
  const two = await cancelled.start({ requestId: 'two', targetLauncher: 'codex' }); await tick()
  assert.equal((await cancelled.start({ requestId: 'three', targetLauncher: 'codex' })).rejected, true)
  await Promise.all([cancelled.handoffs.cancel(cancelled.owner, { taskId: one.id }), cancelled.handoffs.cancel(cancelled.owner, { taskId: two.id })])
  assert.equal(cancelled.handles.length, 2); assert.ok(cancelled.handles.every(handle => handle.terminated))
  assert.equal(cancelled.records.get(one.id).status, 'cancelled'); assert.equal(cancelled.handoffs.activeCount, 0)
  await cancelled.handoffs.close()

  const blocked = fixture({ loginClean: false })
  const blockedTask = await blocked.start({ targetLauncher: 'codex' })
  const pending = await settle(blocked, blockedTask)
  assert.equal(pending.status, 'running'); assert.match(pending.error, /登录检查进程.*清理/)
  assert.equal(blocked.handles.length, 1); assert.equal(blocked.handoffs.activeCount, 1)
  blocked.handles[0].clean = true
  await blocked.handoffs.cancel(blocked.owner, { taskId: blockedTask.id })
  assert.equal(blocked.handoffs.activeCount, 0); assert.equal(blocked.handles.length, 1)
  await blocked.handoffs.close()
})
