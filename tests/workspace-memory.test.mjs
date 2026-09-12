import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkspaceMemory, saveWorkspaceMemory } from '../src/client/workspace-memory.mjs';
import { presetLayout } from '../src/client/layout.mjs';

function fixture() {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  const options = { storage, origin: 'http://localhost:43179' };
  const slots = Array.from({ length: 12 }, () => null);
  slots[1] = { id: 'terminal-1', launcher: 'pi', title: '修复登录问题' };
  return { entries, storage, options, value: { layout: presetLayout('main', [0, 1, 2]), preset: 'main', selectedSlot: 1, slots } };
}

test('workspace memory restores layout and metadata while excluding output and control credentials', () => {
  const { options, entries, value } = fixture();
  const input = { ...value, output: 'terminal-output', prompt: 'private-prompt', writerLease: 'private-lease',
    slots: value.slots.map(slot => slot && { ...slot, output: 'private-output', writer: 'private-writer', env: { TOKEN: 'private-token' } }) };
  assert.equal(saveWorkspaceMemory('session-a', input, options), true);
  assert.deepEqual(loadWorkspaceMemory('session-a', options), value);
  const raw = [...entries.values()][0];
  for (const forbidden of ['terminal-output', 'private-', 'writer', 'env', 'TOKEN']) assert.equal(raw.includes(forbidden), false);
});

test('SSH execution metadata round-trips without storing connection credentials', () => {
  const { options, entries, value } = fixture();
  const execution = { kind: 'ssh', label: 'project-host', targetId: 'project-host', cwd: '/srv/project' };
  const remote = { ...value.slots[1], execution };
  const expected = { ...value, slots: value.slots.map((slot, index) => index === 1 ? remote : slot) };
  const input = { ...expected, slots: expected.slots.map(slot => slot && { ...slot,
    execution: { ...execution, password: 'private-password', identityFile: 'private-key', hostName: 'private-address' },
  }) };
  assert.equal(saveWorkspaceMemory('session-remote', input, options), true);
  assert.deepEqual(loadWorkspaceMemory('session-remote', options), expected);
  const raw = [...entries.values()][0];
  for (const forbidden of ['private-', 'password', 'identityFile', 'hostName']) assert.equal(raw.includes(forbidden), false);
});

test('a saved SSH task stays remote without live process state and incomplete remote identity is never downgraded to local', () => {
  const { options, entries, value } = fixture();
  const execution = { kind: 'ssh', label: 'project-host', targetId: 'project-host', cwd: '/srv/project' };
  const record = { ...value.slots[1], execution };
  const saved = { ...value, slots: value.slots.map((slot, index) => index === 1 ? {
    ...record, state: 'disconnected', pid: 1234, lease: 'private-lease', writer: 'private-writer',
  } : slot) };
  assert.equal(saveWorkspaceMemory('session-remote', saved, options), true);
  const restored = loadWorkspaceMemory('session-remote', options);
  assert.deepEqual(restored.slots[1], record, 'the remembered task carries its remote destination, not a synthetic live terminal');
  assert.equal(saveWorkspaceMemory('session-remote', { ...restored, layout: null }, options), true);
  assert.deepEqual(loadWorkspaceMemory('session-remote', options).slots[1], record,
    'hiding the remaining record must preserve the explicit remote restore choice');
  const [key, raw] = [...entries.entries()][0];
  for (const invalid of [{ ...execution, targetId: undefined }, { ...execution, kind: 'unknown' }]) {
    const corrupt = JSON.parse(raw);
    corrupt.value.slots[1].execution = invalid;
    entries.set(key, JSON.stringify(corrupt));
    assert.equal(loadWorkspaceMemory('session-remote', options), null,
      'an incomplete SSH record must be rejected instead of restored with local defaults');
  }
});

test('workspace memories do not cross session or origin scopes even if stored envelope is copied', () => {
  const { options, entries, value } = fixture();
  saveWorkspaceMemory('session-a', value, options);
  assert.equal(loadWorkspaceMemory('session-b', options), null);
  assert.equal(loadWorkspaceMemory('session-a', { ...options, origin: 'http://localhost:43180' }), null);
  const savedA = [...entries.values()][0];
  saveWorkspaceMemory('session-b', { ...value, selectedSlot: 2 }, options);
  const keyB = [...entries.keys()].find(key => key.endsWith(':session-b'));
  entries.set(keyB, savedA);
  assert.equal(loadWorkspaceMemory('session-b', options), null);
  assert.deepEqual(loadWorkspaceMemory('session-a', options), value);
});

test('unavailable, corrupt, oversized, or unsupported storage safely falls back', () => {
  const { options, entries, value } = fixture();
  assert.equal(loadWorkspaceMemory('session-a', { ...options, storage: { getItem() { throw new Error('denied'); } } }), null);
  assert.equal(saveWorkspaceMemory('session-a', value, { ...options, storage: { setItem() { throw new Error('quota'); } } }), false);
  assert.equal(loadWorkspaceMemory('../session-a', options), null);
  saveWorkspaceMemory('session-a', value, options);
  const key = [...entries.keys()][0];
  for (const raw of ['{', 'null', 'x'.repeat(32769), JSON.stringify({ version: 999 })]) {
    entries.set(key, raw);
    assert.equal(loadWorkspaceMemory('session-a', options), null);
  }
});

test('invalid pane metadata and malformed split trees are rejected without replacing the saved workspace', () => {
  const { options, value } = fixture();
  assert.equal(saveWorkspaceMemory('session-a', value, options), true);
  const branch = (first, second) => ({ id: 'split-a', axis: 'x', ratio: 0.5, first, second });
  const invalid = [
    { ...value, layout: branch({ slot: 1 }, { slot: 1 }) },
    { ...value, layout: branch({ slot: 1 }, { slot: 12 }) },
    { ...value, layout: { ...branch({ slot: 0 }, { slot: 1 }), ratio: NaN } },
    { ...value, layout: { ...branch({ slot: 0 }, { slot: 1 }), ratio: 0 } },
    { ...value, layout: branch(branch({ slot: 0 }, { slot: 1 }), { slot: 2 }) },
    { ...value, selectedSlot: 12 },
    { ...value, slots: value.slots.slice(1) },
    { ...value, slots: value.slots.map((slot, index) => index === 2 ? value.slots[1] : slot) },
    { ...value, slots: value.slots.map(slot => slot && { ...slot, launcher: 'pi;echo' }) },
    { ...value, slots: value.slots.map(slot => slot && { ...slot, title: 'x'.repeat(49) }) },
  ];
  const cyclic = branch({ slot: 0 }, { slot: 1 }); cyclic.second = cyclic;
  invalid.push({ ...value, layout: cyclic });
  for (const record of invalid) {
    assert.equal(saveWorkspaceMemory('session-a', record, options), false);
    assert.deepEqual(loadWorkspaceMemory('session-a', options), value);
  }
  assert.equal(saveWorkspaceMemory('session-a', { ...value, layout: null }, options), true, 'all panes may be hidden');
  assert.equal(saveWorkspaceMemory('session-a', { ...value, preset: 'custom' }, options), true);
  assert.equal(loadWorkspaceMemory('session-a', options).preset, 'custom');
});
