export const PANE_MIN_WIDTH = 240;
export const PANE_MIN_HEIGHT = 160;
export const SPLIT_GAP = 9;

export function leafSlots(tree) {
  if (!tree) return [];
  return 'slot' in tree ? [tree.slot] : [...leafSlots(tree.first), ...leafSlots(tree.second)];
}

function branch(axis, first, second, ratio = 0.5) {
  return { id: `split-${crypto.randomUUID()}`, axis, first, second, ratio };
}

function sequence(nodes, axis) {
  if (nodes.length === 1) return nodes[0];
  const middle = Math.ceil(nodes.length / 2);
  return branch(axis, sequence(nodes.slice(0, middle), axis), sequence(nodes.slice(middle), axis), middle / nodes.length);
}

export function gridLayout(slots, columns) {
  if (!slots.length) return null;
  const rows = [];
  for (let i = 0; i < slots.length; i += columns) {
    rows.push(sequence(slots.slice(i, i + columns).map(slot => ({ slot })), 'x'));
  }
  return sequence(rows, 'y');
}

export function presetLayout(preset, slots) {
  if (!slots.length) return null;
  if (preset === 'vertical') return sequence(slots.map(slot => ({ slot })), 'y');
  if (preset === 'horizontal') return sequence(slots.map(slot => ({ slot })), 'x');
  if (preset === 'main' && slots.length > 1) {
    return branch('x', { slot: slots[0] }, sequence(slots.slice(1).map(slot => ({ slot })), 'y'), 0.62);
  }
  return gridLayout(slots, preset === 'twelve' ? 4 : 3);
}

export function removeSlot(tree, slot) {
  if (!tree) return null;
  if ('slot' in tree) return tree.slot === slot ? null : tree;
  const first = removeSlot(tree.first, slot);
  const second = removeSlot(tree.second, slot);
  if (!first) return second;
  if (!second) return first;
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}

export function splitSlot(tree, target, added, axis) {
  if (target === added || !leafSlots(tree).includes(target)) return tree;
  const withoutAdded = removeSlot(tree, added);
  const visit = node => {
    if ('slot' in node) return node.slot === target ? branch(axis, node, { slot: added }) : node;
    return { ...node, first: visit(node.first), second: visit(node.second) };
  };
  return visit(withoutAdded);
}

export function resizeSplit(tree, id, ratio) {
  if (!tree || 'slot' in tree || !Number.isFinite(ratio)) return tree;
  if (tree.id === id) return { ...tree, ratio: Math.min(0.99, Math.max(0.01, ratio)) };
  const first = resizeSplit(tree.first, id, ratio);
  const second = resizeSplit(tree.second, id, ratio);
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}

export function minimumSize(tree) {
  if (!tree || 'slot' in tree) return { width: PANE_MIN_WIDTH, height: PANE_MIN_HEIGHT };
  const a = minimumSize(tree.first);
  const b = minimumSize(tree.second);
  return tree.axis === 'x'
    ? { width: a.width + SPLIT_GAP + b.width, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + SPLIT_GAP + b.height };
}

export function layoutGeometry(tree, viewportWidth, viewportHeight) {
  const minimum = minimumSize(tree);
  const width = Math.max(minimum.width, Number.isFinite(viewportWidth) ? viewportWidth : 0);
  const height = Math.max(minimum.height, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const panes = {};
  const separators = [];
  const visit = (node, rect) => {
    if (!node) return;
    if ('slot' in node) { panes[node.slot] = rect; return; }
    const horizontal = node.axis === 'x';
    const dimension = horizontal ? 'width' : 'height';
    const available = rect[dimension] - SPLIT_GAP;
    const minimumA = minimumSize(node.first)[dimension];
    const minimumB = minimumSize(node.second)[dimension];
    const extent = Math.min(available - minimumB, Math.max(minimumA, available * node.ratio));
    const first = { ...rect, [dimension]: extent };
    const second = { ...rect, [horizontal ? 'x' : 'y']: rect[horizontal ? 'x' : 'y'] + extent + SPLIT_GAP, [dimension]: available - extent };
    const handle = horizontal
      ? { x: rect.x + extent, y: rect.y, width: SPLIT_GAP, height: rect.height }
      : { x: rect.x, y: rect.y + extent, width: rect.width, height: SPLIT_GAP };
    separators.push({ id: node.id, axis: node.axis, rect: handle, container: rect, ratio: extent / available,
      minRatio: minimumA / available, maxRatio: (available - minimumB) / available });
    visit(node.first, first);
    visit(node.second, second);
  };
  visit(tree, { x: 0, y: 0, width, height });
  return { width, height, panes, separators };
}

export function pointerRatio(separator, x, y) {
  const horizontal = separator.axis === 'x';
  const start = separator.container[horizontal ? 'x' : 'y'];
  const extent = separator.container[horizontal ? 'width' : 'height'] - SPLIT_GAP;
  const value = ((horizontal ? x : y) - start - SPLIT_GAP / 2) / extent;
  if (!Number.isFinite(value)) return separator.ratio;
  return Math.min(separator.maxRatio, Math.max(separator.minRatio, value));
}

export function neighborSlot(panes, current, direction) {
  const origin = panes[current];
  if (!origin) return Object.keys(panes).length ? Number(Object.keys(panes)[0]) : null;
  const horizontal = direction === 'left' || direction === 'right';
  const forward = direction === 'right' || direction === 'down' ? 1 : -1;
  const primary = horizontal ? 'x' : 'y';
  const secondary = horizontal ? 'y' : 'x';
  const size = horizontal ? 'width' : 'height';
  const crossSize = horizontal ? 'height' : 'width';
  let best = null;
  let bestScore = Infinity;
  for (const [slot, rect] of Object.entries(panes)) {
    if (Number(slot) === current) continue;
    const distance = (rect[primary] + rect[size] / 2 - origin[primary] - origin[size] / 2) * forward;
    if (distance <= 0) continue;
    const cross = Math.abs(rect[secondary] + rect[crossSize] / 2 - origin[secondary] - origin[crossSize] / 2);
    const overlaps = rect[secondary] < origin[secondary] + origin[crossSize] && rect[secondary] + rect[crossSize] > origin[secondary];
    if (!overlaps) continue;
    const score = distance + cross * 2;
    if (score < bestScore) { best = Number(slot); bestScore = score; }
  }
  return best;
}
