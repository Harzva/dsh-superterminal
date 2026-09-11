import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalGroups } from '../src/terminal-groups.mjs'
import { TerminalGroupJournal } from '../src/terminal-group-journal.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture(options = {}) {
  const owner = { id: 'owner', session: {} }, agents = new Map([[owner.id, owner]])
  const entries = new Map(['one', 'two', 'pi', 'kimi'].map(id => [id, { id, launcher: id === 'pi' ? 'pi' : id === 'kimi' ? 'kimi' : 'shell' }]))
  const disk = new Map(), calls = [], cancelled = [], controls = { failSave: null, pending: false, cleanupFails: false }, leases = new Map(), tasks = new Map(), active = new Map()
  const ctx = { agents, get(name) { if (name === 'storageDomain') return { async open(spec) { return { table() { return {
    entries: () => disk.entries(), get: key => disk.get(key), async put(key, value) {
      if (controls.failSave?.(value)) throw Error('PRIVATE_STORAGE_DIAGNOSTIC')
      if (controls.saveGate && value.status === 'running') await controls.saveGate.promise
      disk.set(key, spec.tables.groups.valueSchema.parse(structuredClone(value)))
    }, } }, async close() {} } } } } }
  const terminals = { ctx, current(value) { if (agents.get(value.id) !== value) throw Error('owner expired') },
    owned(value) { this.current(value); return { entries } }, entry(value, id) { this.current(value); const entry = entries.get(id); if (!entry) throw Error('missing terminal'); return entry } }
  const nativeRuns = terminals.nativeRuns = {
    assertRuntime() {}, async state(value, { terminalId }) { terminals.entry(value, terminalId); return { model: 'actual-dsh-model' } },
    async groupTurn(value, input, signal) {
      terminals.entry(value, input.terminalId); signal.throwIfAborted(); calls.push({ ...input, kind: 'native' }); leases.set(input.groupId, input)
      try {
        if (controls.pending) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('cancelled'), { groupSafe: true })), { once: true }))
        return { text: `answer-${input.terminalId}-${calls.length}`, model: 'actual-dsh-model' }
      } finally { if (!controls.cleanupFails) leases.delete(input.groupId) }
    },
    hasGroupLease(value, groupId) { return leases.has(groupId) },
    async stopGroupTurn(value, groupId) { if (controls.cleanupFails && leases.has(groupId)) throw Error('cleanup'); leases.delete(groupId) },
  }
  const handoffs = terminals.handoffs = {
    states: new Map([[owner, { records: tasks, active }]]), async targets() { return [{ id: 'pi', available: true }] },
    async start(value, input) {
      terminals.entry(value, input.sourceTerminalId); calls.push({ ...input, kind: 'cli' })
      const task = { ...input, id: `cli-${calls.length}`, sourceSessionId: owner.id, status: controls.pending ? 'running' : 'succeeded', result: 'Independent Pi reply' }
      tasks.set(task.id, task); if (controls.pending) active.set(task.id, task); return { ...task }
    },
    async list(value) { terminals.current(value); return { tasks: [...tasks.values()] } },
    async cancelOwned(value, { taskId }) { assert.equal(value, owner); const task = tasks.get(taskId); assert.equal(task.sourceSessionId, owner.id); cancelled.push(taskId); active.delete(taskId); if (task.status === 'running') task.status = 'cancelled'; return { ...task } },
  }
  const groups = new TerminalGroups(terminals, { pollMs: 1, timeoutMs: 100, ...options })
  const create = (requestId = 'create', memberIds = ['one', 'two']) => groups.create(owner, { requestId, title: 'Discuss the change', members: memberIds.map(id => ({ terminalId: id, mode: id === 'pi' ? 'cli' : 'dsh-ai', title: id })) })
  const send = (group, extra = {}, signal) => groups.send(owner, { groupId: group.id, requestId: 'send', prompt: 'Review the change', targets: group.members.map(member => member.id), rounds: 1, kind: 'discussion', ...extra }, signal)
  const settle = async group => { for (let i = 0; i < 100; i++) { await tick(); if (!groups.hasActive(owner)) return groups.read(owner, { groupId: group.id }) } throw Error('did not settle') }
  return { owner, agents, entries, disk, calls, cancelled, controls, nativeRuns, handoffs, terminals, groups, create, send, settle, tasks, active }
}

test('persisted groups preserve terminal identity, ownership, bounded records and explicit native/CLI availability', async () => {
  const f = fixture(), group = await f.create()
  assert.equal(f.entries.size, 4); assert.equal(group.members[0].launcher, 'shell')
  const replay = await f.create(); assert.equal(replay.id, group.id)
  await assert.rejects(f.create('create', ['one']), /GROUP_REJECTED.*标识/)
  await assert.rejects(f.groups.create(f.owner, { requestId: 'bad', title: 'bad', members: [{ terminalId: 'kimi', mode: 'cli', title: 'Codex' }] }), /GROUP_REJECTED.*CLI/)
  await assert.rejects(f.groups.create(f.owner, { requestId: 'bad', title: 'bad', members: [{ terminalId: 'foreign', mode: 'dsh-ai', title: 'one' }] }), /GROUP_REJECTED.*终端/)
  const catalog = await f.groups.list(f.owner)
  assert.equal(catalog.candidates.find(row => row.terminalId === 'kimi').modes.find(row => row.mode === 'cli').available, false)
  assert.equal(catalog.candidates.find(row => row.terminalId === 'pi').modes.find(row => row.mode === 'cli').available, true)
  assert.equal(JSON.stringify(catalog).includes('sourceSessionId'), false)
  const foreign = { id: 'foreign', session: {} }; f.agents.set(foreign.id, foreign)
  await assert.rejects(f.groups.read(foreign, { groupId: group.id }), /当前会话没有/)
  const updated = await f.groups.update(f.owner, { groupId: group.id, requestId: 'edit', title: 'Renamed', members: [{ terminalId: 'one', mode: 'dsh-ai', title: 'Reviewer' }] })
  assert.equal(updated.members[0].id, group.members[0].id)
  await f.groups.archive(f.owner, { groupId: group.id }); assert.equal((await f.groups.list(f.owner)).groups.length, 0)
  assert.equal((await f.groups.read(f.owner, { groupId: group.id })).archived, true)
  await f.groups.close()
})

test('two rounds use fixed shared snapshots and native replies have real models without sharing unrelated history', async () => {
  const f = fixture(), group = await f.create()
  await f.send(group, { rounds: 2, excerpt: { terminalId: 'one', text: 'EXPLICIT_MATERIAL' } })
  const result = await f.settle(group)
  assert.equal(result.status, 'completed'); assert.equal(f.calls.length, 4)
  assert.equal(result.messages.filter(row => row.kind === 'reply').length, 4)
  assert.doesNotMatch(f.calls[1].prompt, /answer-one-1/)
  assert.match(f.calls[2].prompt, /answer-one-1/); assert.match(f.calls[3].prompt, /answer-two-2/)
  assert.doesNotMatch(f.calls[3].prompt, /answer-one-3/)
  for (const call of f.calls) { assert.match(call.prompt, /EXPLICIT_MATERIAL/); assert.ok(call.prompt.length <= 8000) }
  for (const message of result.messages.filter(row => row.kind === 'reply')) assert.equal(message.model, 'actual-dsh-model')
  await f.send(group, { rounds: 2, excerpt: { terminalId: 'one', text: 'EXPLICIT_MATERIAL' } }); assert.equal(f.calls.length, 4)
  const observation = JSON.stringify(f.groups.observation(f.owner))
  assert.doesNotMatch(observation, /EXPLICIT_MATERIAL|answer-|Review the change|Discuss the change/)
  await f.send(group, { requestId: 'conclusion', kind: 'conclusion', targets: [group.members[0].id], prompt: 'Summarize disagreements' })
  assert.equal((await f.settle(group)).messages.at(-1).kind, 'conclusion')
  await f.groups.close()
})

test('CLI participation reuses handoff correlation and never invents the terminal model or auto-returns to conversation', async () => {
  const f = fixture(), group = await f.create('create', ['pi'])
  await f.send(group); const result = await f.settle(group), call = f.calls[0], reply = result.messages.at(-1)
  assert.equal(call.kind, 'cli'); assert.equal(call.targetLauncher, 'pi'); assert.equal(call.sourceGroupId, group.id)
  assert.equal(call.returnToConversation, false); assert.equal(call.groupPurpose, 'discussion')
  assert.match(call.prompt, /新独立 CLI 任务/); assert.ok(call.requestId.startsWith('group-'))
  assert.equal(reply.text, 'Independent Pi reply'); assert.equal(reply.taskId, 'cli-1'); assert.equal(reply.model, undefined)
  assert.equal(reply.terminalId, 'pi'); assert.equal(reply.launcher, 'pi')
  await f.groups.update(f.owner, { groupId: group.id, requestId: 'remove-pi', title: 'Changed members', members: [{ terminalId: 'one', mode: 'dsh-ai', title: 'New member' }] })
  const historical = (await f.groups.read(f.owner, { groupId: group.id })).messages.at(-1)
  assert.equal(historical.memberTitle, 'pi'); assert.equal(historical.terminalId, 'pi'); assert.equal(historical.launcher, 'pi')
  await f.send(group); assert.equal(f.calls.length, 1)
  await f.groups.close()
})

test('HTTP cancellation after acceptance does not cancel discussion; explicit stop preserves replies and blocks concurrent edits', async () => {
  const f = fixture(), group = await f.create(); f.controls.pending = true
  const request = new AbortController(); await f.send(group, {}, request.signal); await tick(); request.abort()
  assert.equal(f.groups.hasActive(f.owner), true)
  await assert.rejects(f.groups.update(f.owner, { groupId: group.id, requestId: 'edit', title: 'Another', members: [{ terminalId: 'one', mode: 'dsh-ai', title: 'one' }] }), /GROUP_REJECTED.*等待/)
  const result = await f.groups.stopGroup(f.owner, { groupId: group.id })
  assert.equal(result.status, 'cancelled'); assert.equal(result.messages.length, 1); assert.equal(f.groups.hasActive(f.owner), false)
  await f.send(group); assert.equal(f.calls.length, 1)
  await f.groups.close()
})

test('failed acceptance never runs; failed result persistence retries storage without replaying a member', async () => {
  const f = fixture(), group = await f.create(); f.controls.failSave = row => row.status === 'running'
  await assert.rejects(f.send(group), /保存/); await tick(); assert.equal(f.calls.length, 0)
  f.controls.failSave = null; await f.send(group); assert.equal(f.calls.length, 0)
  f.controls.failSave = row => row.messages.some(message => message.kind === 'reply')
  await f.send(group, { requestId: 'new-send' }); const result = await f.settle(group)
  assert.equal(f.calls.length, 1); assert.equal(result.status, 'failed'); assert.match(result.operation.error, /保存/)
  f.controls.failSave = null; await f.groups.read(f.owner, { groupId: group.id })
  await f.send(group, { requestId: 'new-send' }); assert.equal(f.calls.length, 1)
  await f.groups.close()
})

test('native cleanup failure retains group capacity until retry proves cleanup', async () => {
  const f = fixture(), group = await f.create(); f.controls.pending = true; f.controls.cleanupFails = true
  await f.send(group); await tick()
  await assert.rejects(f.groups.stopGroup(f.owner, { groupId: group.id }), /清理/)
  assert.equal(f.groups.hasActive(f.owner), true)
  f.controls.cleanupFails = false
  const stopped = await f.groups.stopGroup(f.owner, { groupId: group.id })
  assert.equal(stopped.status, 'cancelled'); assert.equal(f.groups.hasActive(f.owner), false)
  await f.groups.close()
})

test('restart marks persisted running groups interrupted without replay and keeps request identity', async () => {
  const f = fixture(), group = await f.create()
  await f.send(group); await f.settle(group)
  const row = [...f.disk.values()][0]; row.status = 'running'; row.operation.status = 'running'
  const recovered = new TerminalGroups(f.terminals, { journal: new TerminalGroupJournal(f.terminals.ctx) })
  const record = await recovered.read(f.owner, { groupId: group.id })
  assert.equal(record.status, 'interrupted'); assert.equal(record.operation.status, 'interrupted')
  await recovered.send(f.owner, { groupId: group.id, requestId: 'send', prompt: 'Review the change', targets: group.members.map(row => row.id), rounds: 1, kind: 'discussion' })
  assert.equal(f.calls.length, 2)
  await recovered.close(); await f.groups.close()
})

test('shutdown cancels only owned group tasks even when the owner no longer exists', async () => {
  const f = fixture(), group = await f.create('create', ['pi']); f.controls.pending = true
  f.tasks.set('unrelated', { id: 'unrelated', sourceSessionId: f.owner.id, status: 'running' }); f.active.set('unrelated', {})
  await f.send(group); await tick(); f.agents.delete(f.owner.id)
  await f.groups.quiesce()
  assert.deepEqual(f.cancelled, ['cli-1']); assert.equal(f.active.has('unrelated'), true); assert.equal(f.groups.hasActive(f.owner), false)
  await f.groups.close()
})

test('concurrent owners reserve group capacity before asynchronous acceptance persistence', async () => {
  const f = fixture(), owners = [f.owner, { id: 'second', session: {} }, { id: 'third', session: {} }]
  for (const owner of owners) f.agents.set(owner.id, owner)
  const groups = []
  for (const owner of owners) groups.push(await f.groups.create(owner, { requestId: 'create', title: 'Group', members: [{ terminalId: 'one', mode: 'dsh-ai', title: 'one' }] }))
  f.controls.pending = true; f.controls.saveGate = Promise.withResolvers()
  const send = index => f.groups.send(owners[index], { groupId: groups[index].id, requestId: 'send', prompt: 'Discuss', targets: [groups[index].members[0].id], rounds: 1, kind: 'discussion' })
  const first = send(0), second = send(1); await tick()
  await assert.rejects(send(2), /GROUP_REJECTED.*两个讨论组/)
  assert.equal(f.groups.admissions, 2)
  f.controls.saveGate.resolve(); await Promise.all([first, second]); await f.groups.quiesce()
  assert.equal(f.groups.admissions, 0); assert.equal(owners.some(owner => f.groups.hasActive(owner)), false)
  await f.groups.close()
})

test('long discussions retain every latest member correction with rounds, goal and explicit material within 8000 characters', async () => {
  const f = fixture(), group = await f.create('create', ['one', 'pi'])
  const [native, pi] = group.members
  const input = { requestId: 'conclude', kind: 'conclusion', prompt: 'CURRENT_GOAL_HEAD' + '目标'.repeat(1900) + 'CURRENT_GOAL_TAIL',
    excerpt: { terminalId: 'one', text: 'EXCERPT_HEAD' + '材料'.repeat(1900) + 'EXCERPT_TAIL' } }
  const snapshot = [
    { kind: 'user', requestId: 'first', text: 'Original shared goal' },
    { kind: 'reply', requestId: 'first', memberId: native.id, memberTitle: native.title, mode: 'dsh-ai', round: 1, text: 'STALE_NATIVE_STANCE' + '旧看法'.repeat(2500) },
    { kind: 'reply', requestId: 'first', memberId: pi.id, memberTitle: pi.title, mode: 'cli', round: 1, text: 'STALE_PI_DISAGREEMENT' + '旧分歧'.repeat(2500) },
    { kind: 'reply', requestId: 'second', memberId: native.id, memberTitle: native.title, mode: 'dsh-ai', model: 'actual-model', round: 2,
      text: 'LATEST_NATIVE_HEAD' + '核验结果'.repeat(2000) + 'LATEST_NATIVE_CORRECTION_TAIL' },
    { kind: 'reply', requestId: 'second', memberId: pi.id, memberTitle: pi.title, mode: 'cli', round: 2,
      text: 'LATEST_PI_HEAD' + '已重新检查'.repeat(1800) + 'LATEST_PI_CORRECTION_TAIL' },
    { kind: 'user', requestId: input.requestId, text: input.prompt },
  ]
  const before = structuredClone(snapshot), prompt = f.groups.prompt(group, input, native, 1, snapshot)
  assert.ok(prompt.length <= 8000, `Prompt uses ${prompt.length} characters`)
  for (const marker of ['CURRENT_GOAL_HEAD', 'CURRENT_GOAL_TAIL', 'EXCERPT_HEAD', 'EXCERPT_TAIL', 'LATEST_NATIVE_HEAD', 'LATEST_NATIVE_CORRECTION_TAIL', 'LATEST_PI_HEAD', 'LATEST_PI_CORRECTION_TAIL']) assert.ok(prompt.includes(marker), marker)
  assert.match(prompt, /one \/ dsh-ai \/ actual-model｜第 2 轮/)
  assert.match(prompt, /pi \/ cli｜第 2 轮/)
  assert.match(prompt, /原文.*省略/); assert.match(prompt, /这不是摘要/); assert.match(prompt, /以其更正后的立场为准/)
  assert.doesNotMatch(prompt, /STALE_PI_DISAGREEMENT|STALE_NATIVE_STANCE/)
  assert.equal(prompt.match(/CURRENT_GOAL_HEAD/g).length, 1)
  assert.deepEqual(snapshot, before, 'Selecting shared context must not mutate the fixed round snapshot')
  await f.groups.close()
})

test('context allocates available space fairly across six latest participants instead of favoring the earliest or most verbose', async () => {
  const f = fixture(), group = await f.create()
  group.title = '会'.repeat(120)
  group.members = Array.from({ length: 6 }, (_, index) => ({ id: `member-${index}`, terminalId: `terminal-${index}`, title: `MEMBER_${index}_` + '称'.repeat(110), launcher: 'codex', mode: 'cli' }))
  const input = { requestId: 'latest', kind: 'conclusion', prompt: 'TARGET_START' + '目'.repeat(3900) + 'TARGET_END',
    excerpt: { terminalId: 'terminal-0', text: 'MATERIAL_START' + '文'.repeat(3900) + 'MATERIAL_END' } }
  const snapshot = group.members.map((member, index) => ({ kind: 'reply', memberId: member.id, memberTitle: member.title, mode: member.mode,
    model: 'model-'.repeat(40), round: 2, text: `LATEST_${index}_START` + '论证'.repeat(7000) + `LATEST_${index}_END` }))
  const prompt = f.groups.prompt(group, input, group.members[0], 1, snapshot)
  assert.ok(prompt.length <= 8000, `Prompt uses ${prompt.length} characters`)
  for (let index = 0; index < 6; index++) { assert.ok(prompt.includes(`LATEST_${index}_START`)); assert.ok(prompt.includes(`LATEST_${index}_END`)) }
  for (const marker of ['TARGET_START', 'TARGET_END', 'MATERIAL_START', 'MATERIAL_END']) assert.ok(prompt.includes(marker))
  assert.equal((prompt.match(/第 2 轮/g) ?? []).length, 6)
  await f.groups.close()
})
