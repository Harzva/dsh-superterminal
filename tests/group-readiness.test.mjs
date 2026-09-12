import test from 'node:test'
import assert from 'node:assert/strict'
import { groupReadiness, memberReadiness } from '../src/client/group-readiness.mjs'

const members = [{ id: 'reviewer', terminalId: 'one', title: 'Reviewer', mode: 'dsh-ai' },
  { id: 'builder', terminalId: 'two', title: 'Builder', mode: 'cli' }]
const terminals = [{ id: 'one' }, { id: 'two' }]
const candidates = [{ terminalId: 'one', modes: [{ mode: 'dsh-ai', available: true, detail: '沿用 DSH AI' }] },
  { terminalId: 'two', modes: [{ mode: 'dsh-ai', available: true }, { mode: 'cli', available: true, detail: '独立 CLI' }] }]

test('closing a selected terminal blocks sending and conclusion without changing either identity', () => {
  const targets = ['reviewer', 'builder'], before = structuredClone({ members, terminals, candidates, targets })
  const state = groupReadiness(members, [{ id: 'two' }], candidates, targets, 'reviewer')
  assert.deepEqual(state.targets, targets); assert.equal(state.author, 'reviewer')
  assert.deepEqual(state.invalidTargets, ['reviewer']); assert.equal(state.canSend, false); assert.equal(state.canConclude, false)
  assert.equal(state.byId.get('reviewer').canOpen, false); assert.equal(state.byId.get('reviewer').label, '终端已关闭')
  assert.equal(state.byId.get('builder').available, true)
  assert.deepEqual({ members, terminals, candidates, targets }, before)
})

test('availability is checked for the selected identity instead of silently switching to DSH AI', () => {
  const unavailable = structuredClone(candidates); unavailable[1].modes[1].available = false
  const state = groupReadiness(members, terminals, unavailable, ['builder'], 'builder')
  assert.equal(state.canSend, false); assert.equal(state.canConclude, false)
  assert.equal(state.byId.get('builder').canOpen, true); assert.equal(state.byId.get('builder').label, '暂不可用')
  assert.deepEqual(state.targets, ['builder']); assert.equal(state.author, 'builder')
})

test('pending inventory and removed members are explicit failures rather than implicit replacements', () => {
  const unknown = memberReadiness(members[0], terminals, [])
  assert.equal(unknown.available, false); assert.equal(unknown.canOpen, true); assert.equal(unknown.label, '等待检查')
  const removed = groupReadiness(members.slice(1), terminals, candidates, ['reviewer', 'builder'], 'reviewer')
  assert.deepEqual(removed.targets, ['reviewer', 'builder']); assert.equal(removed.author, 'reviewer')
  assert.deepEqual(removed.invalidTargets, ['reviewer']); assert.equal(removed.canConclude, false)
})

test('only an explicit valid selection or restored availability makes the action available', () => {
  const closed = [{ id: 'two' }]
  const changed = groupReadiness(members, closed, candidates, ['builder'], 'builder')
  assert.equal(changed.canSend, true); assert.equal(changed.canConclude, true)
  const restored = groupReadiness(members, terminals, candidates, ['reviewer', 'builder'], 'reviewer')
  assert.equal(restored.canSend, true); assert.equal(restored.canConclude, true)
  const empty = groupReadiness(members, terminals, candidates, [], '')
  assert.equal(empty.canSend, false); assert.equal(empty.canConclude, false)
})

test('SSH terminals cannot use either local execution identity even when an old candidate list says available', () => {
  const remote = { id: 'two', execution: { kind: 'ssh', label: 'project-host', targetId: 'project-host', cwd: '/srv/project' } }
  const availableTerminals = [{ id: 'one' }, remote]
  for (const mode of ['cli', 'dsh-ai']) {
    const selectedMembers = [members[0], { ...members[1], mode }]
    const before = structuredClone({ selectedMembers, availableTerminals, candidates })
    const state = groupReadiness(selectedMembers, availableTerminals, candidates, ['reviewer', 'builder'], 'builder')
    assert.equal(state.canSend, false); assert.equal(state.canConclude, false)
    assert.deepEqual(state.invalidTargets, ['builder'])
    assert.deepEqual(state.targets, ['reviewer', 'builder']); assert.equal(state.author, 'builder')
    assert.equal(state.byId.get('builder').canOpen, true)
    assert.equal(state.byId.get('builder').available, false)
    assert.match(state.byId.get('builder').detail, /远端 Agent CLI/)
    assert.equal(state.byId.get('reviewer').available, true)
    assert.deepEqual({ selectedMembers, availableTerminals, candidates }, before)
  }
})
