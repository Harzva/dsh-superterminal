const VERSION = 1;
const MAX_BYTES = 32768;
const PRESETS = new Set(['six', 'twelve', 'horizontal', 'vertical', 'main', 'custom']);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SAFE_LAUNCHER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function scope(sessionId, options) {
  try {
    if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId)) return null;
    const origin = options?.origin ?? globalThis.location?.origin;
    const storage = options?.storage ?? globalThis.localStorage;
    if (typeof origin !== 'string' || !origin || origin.length > 256 || !storage) return null;
    return { storage, origin, sessionId,
      key: `dsh-superterminal:workspace:${VERSION}:${encodeURIComponent(origin)}:${encodeURIComponent(sessionId)}` };
  } catch { return null; }
}

function metadata(value) {
  if (!value || typeof value !== 'object' || !PRESETS.has(value.preset) ||
      !Number.isInteger(value.selectedSlot) || value.selectedSlot < 0 || value.selectedSlot > 11 ||
      !Array.isArray(value.slots) || value.slots.length !== 12) return null;
  const ids = new Set();
  const slots = [];
  for (const slot of value.slots) {
    if (slot === null) { slots.push(null); continue; }
    if (!slot || typeof slot !== 'object' || typeof slot.id !== 'string' || !SAFE_ID.test(slot.id) ||
        ids.has(slot.id) || typeof slot.launcher !== 'string' || !SAFE_LAUNCHER.test(slot.launcher) ||
        typeof slot.title !== 'string' || slot.title.length > 48 || /[\u0000-\u001f\u007f]/.test(slot.title)) return null;
    ids.add(slot.id);
    slots.push({ id: slot.id, launcher: slot.launcher, title: slot.title });
  }
  const leaves = new Set();
  const branches = new Set();
  let nodes = 0;
  function layout(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 11 || ++nodes > 23) throw new Error('Invalid layout');
    if ('slot' in node) {
      if (!Number.isInteger(node.slot) || node.slot < 0 || node.slot > 11 || leaves.has(node.slot)) throw new Error('Invalid slot');
      leaves.add(node.slot);
      return { slot: node.slot };
    }
    if (typeof node.id !== 'string' || !SAFE_ID.test(node.id) || branches.has(node.id) ||
        (node.axis !== 'x' && node.axis !== 'y') || !Number.isFinite(node.ratio) || node.ratio < 0.01 || node.ratio > 0.99) {
      throw new Error('Invalid split');
    }
    branches.add(node.id);
    return { id: node.id, axis: node.axis, ratio: node.ratio,
      first: layout(node.first, depth + 1), second: layout(node.second, depth + 1) };
  }
  try {
    return { layout: value.layout === null ? null : layout(value.layout), preset: value.preset,
      selectedSlot: value.selectedSlot, slots };
  } catch { return null; }
}

export function loadWorkspaceMemory(sessionId, options) {
  const target = scope(sessionId, options);
  if (!target) return null;
  try {
    const raw = target.storage.getItem(target.key);
    if (typeof raw !== 'string' || raw.length > MAX_BYTES) return null;
    const saved = JSON.parse(raw);
    if (saved?.version !== VERSION || saved.origin !== target.origin || saved.sessionId !== target.sessionId) return null;
    return metadata(saved.value);
  } catch { return null; }
}

export function saveWorkspaceMemory(sessionId, value, options) {
  const target = scope(sessionId, options);
  if (!target) return false;
  try {
    const clean = metadata(value);
    if (!clean) return false;
    const raw = JSON.stringify({ version: VERSION, origin: target.origin, sessionId: target.sessionId, value: clean });
    if (raw.length > MAX_BYTES) return false;
    target.storage.setItem(target.key, raw);
    return true;
  } catch { return false; }
}
