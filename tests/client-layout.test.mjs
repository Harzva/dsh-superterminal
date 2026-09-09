import assert from 'node:assert/strict';
import test from 'node:test';
import { gridLayout, layoutGeometry, leafSlots, minimumSize, neighborSlot, pointerRatio, presetLayout,
  removeSlot, resizeSplit, splitSlot, PANE_MIN_WIDTH, PANE_MIN_HEIGHT } from '../src/client/layout.mjs';

const twelve = Array.from({ length: 12 }, (_, i) => i);

function assertGeometry(tree, width, height) {
  const geometry = layoutGeometry(tree, width, height);
  assert.deepEqual(Object.keys(geometry.panes).map(Number).sort((a, b) => a - b), leafSlots(tree).sort((a, b) => a - b));
  const panes = Object.values(geometry.panes);
  for (const rect of panes) {
    assert.ok(rect.width >= PANE_MIN_WIDTH - 1e-7);
    assert.ok(rect.height >= PANE_MIN_HEIGHT - 1e-7);
    assert.ok(rect.x >= 0 && rect.y >= 0);
    assert.ok(rect.x + rect.width <= geometry.width + 1e-7);
    assert.ok(rect.y + rect.height <= geometry.height + 1e-7);
  }
  for (let a = 0; a < panes.length; a++) for (let b = a + 1; b < panes.length; b++) {
    const left = panes[a]; const right = panes[b];
    assert.ok(left.x + left.width <= right.x + 1e-7 || right.x + right.width <= left.x + 1e-7 ||
      left.y + left.height <= right.y + 1e-7 || right.y + right.height <= left.y + 1e-7, 'pane interiors overlap');
  }
  assert.equal(new Set(geometry.separators.map(item => item.id)).size, geometry.separators.length);
  return geometry;
}

test('presets allocate each requested pane exactly once, including narrow viewports', () => {
  for (const [preset, count] of [['six', 6], ['twelve', 12], ['horizontal', 2], ['vertical', 2], ['main', 3]]) {
    const tree = presetLayout(preset, twelve.slice(0, count));
    assert.equal(new Set(leafSlots(tree)).size, count);
    assertGeometry(tree, 1440, 900);
    const narrow = assertGeometry(tree, 320, 440);
    assert.ok(narrow.width >= minimumSize(tree).width);
  }
});

test('splitting and reclaiming a visible blank preserves all other pane identities', () => {
  const original = gridLayout([0, 1, 2, 3, 4, 5], 3);
  const split = splitSlot(original, 0, 6, 'x');
  assert.deepEqual(new Set(leafSlots(split)), new Set([0, 1, 2, 3, 4, 5, 6]));
  assert.deepEqual(leafSlots(original), [0, 1, 2, 3, 4, 5], 'input tree was mutated');
  const moved = splitSlot(split, 2, 6, 'y');
  assert.equal(leafSlots(moved).filter(slot => slot === 6).length, 1);
  const removed = removeSlot(moved, 3);
  assert.deepEqual(new Set(leafSlots(removed)), new Set([0, 1, 2, 4, 5, 6]));
  assertGeometry(removed, 1400, 1000);
  const restored = splitSlot(removed, 6, 3, 'x');
  assertGeometry(restored, 1400, 1000);
  assert.equal(leafSlots(restored).length, 7);
});

test('separator dragging changes geometry, clamps both subtrees, and does not change leaf identity', () => {
  const tree = presetLayout('main', [2, 7, 9]);
  const initial = assertGeometry(tree, 1500, 700);
  const separator = initial.separators[0];
  const ratio = pointerRatio(separator, 700, 0);
  const resized = resizeSplit(tree, separator.id, ratio);
  assert.deepEqual(leafSlots(resized), [2, 7, 9]);
  const changed = assertGeometry(resized, 1500, 700);
  assert.notEqual(changed.panes[2].width, initial.panes[2].width);
  assert.equal(pointerRatio(separator, -10000, 0), separator.minRatio);
  assert.equal(pointerRatio(separator, 10000, 0), separator.maxRatio);
  assertGeometry(resizeSplit(resized, separator.id, 0.001), 320, 440);
  assertGeometry(resizeSplit(resized, separator.id, 0.999), 1600, 800);
  assert.equal(resizeSplit(tree, separator.id, NaN), tree);
});

test('nested separators remain unique through repeated split/remove operations', () => {
  let tree = gridLayout([0, 1, 2], 3);
  for (let i = 0; i < 30; i++) {
    tree = removeSlot(tree, 2);
    tree = splitSlot(tree, i % 2, 2, i % 2 ? 'x' : 'y');
    assertGeometry(tree, 1100, 700);
  }
});

test('directional focus uses actual geometry and does not wrap across rows', () => {
  const { panes } = layoutGeometry(gridLayout([0, 1, 2, 3, 4, 5], 3), 1200, 700);
  assert.equal(neighborSlot(panes, 0, 'right'), 1);
  assert.equal(neighborSlot(panes, 0, 'down'), 3);
  assert.equal(neighborSlot(panes, 2, 'right'), null);
  assert.equal(neighborSlot(panes, 3, 'left'), null);
  const main = layoutGeometry(presetLayout('main', [0, 1, 2]), 1200, 700).panes;
  assert.equal(neighborSlot(main, 1, 'down'), 2);
  assert.equal(neighborSlot(main, 2, 'left'), 0);
  assert.equal(neighborSlot({ 0: { x: 0, y: 0, width: 300, height: 200 },
    1: { x: 250, y: 250, width: 50, height: 100 } }, 0, 'right'), null, 'diagonal pane must not cause edge wrapping');
});

test('single pane and empty-tree transitions have no orphan separator', () => {
  const tree = removeSlot(presetLayout('horizontal', [0, 1]), 1);
  assert.deepEqual(tree, { slot: 0 });
  assert.equal(layoutGeometry(tree, 360, 480).separators.length, 0);
  assert.deepEqual(layoutGeometry(tree, 360, 480).panes[0], { x: 0, y: 0, width: 360, height: 480 });
  assert.equal(removeSlot(tree, 0), null);
  assert.equal(splitSlot(tree, 0, 0, 'x'), tree);
});
