import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalThemeStore, THEME_STORAGE_KEY } from '../src/client/terminal-theme.mjs';

function browser({ value = null, dark = false, storageBlocked = false } = {}) {
  const storage = new Map(value == null ? [] : [[THEME_STORAGE_KEY, value]]);
  const events = new Map();
  const mediaEvents = new Set();
  const localStorage = {
    getItem(key) { if (storageBlocked) throw Error('storage unavailable'); return storage.get(key) ?? null; },
    setItem(key, next) { if (storageBlocked) throw Error('storage unavailable'); storage.set(key, next); },
  };
  const media = {
    matches: dark,
    addEventListener(type, fn) { assert.equal(type, 'change'); mediaEvents.add(fn); },
    removeEventListener(type, fn) { assert.equal(type, 'change'); mediaEvents.delete(fn); },
  };
  const window = {
    localStorage,
    matchMedia(query) { assert.equal(query, '(prefers-color-scheme: dark)'); return media; },
    addEventListener(type, fn) { const set = events.get(type) ?? new Set(); set.add(fn); events.set(type, set); },
    removeEventListener(type, fn) { events.get(type)?.delete(fn); },
  };
  return {
    window, storage,
    changeSystem(dark) { media.matches = dark; for (const fn of mediaEvents) fn({ matches: dark }); },
    changeStorage(value, key = THEME_STORAGE_KEY, storageArea = localStorage) {
      if (value == null) storage.delete(THEME_STORAGE_KEY); else storage.set(THEME_STORAGE_KEY, value);
      for (const fn of events.get('storage') ?? []) fn({ key, storageArea });
    },
    listenerCount() { return { storage: events.get('storage')?.size ?? 0, system: mediaEvents.size }; },
  };
}

test('appearance defaults to light and rejects invalid persisted preferences', () => {
  for (const value of [null, '', 'unexpected', '{"theme":"dark"}']) {
    const store = createTerminalThemeStore(browser({ value, dark: true }).window);
    assert.deepEqual(store.getSnapshot(), { preference: 'light', resolved: 'light' });
    assert.equal(store.getSnapshot(), store.getSnapshot(), 'React snapshots retain identity until an effective change');
    store.setPreference('unknown');
    assert.deepEqual(store.getSnapshot(), { preference: 'light', resolved: 'light' });
  }
});

test('appearance remains usable with blocked storage and media API', () => {
  const fixture = browser({ storageBlocked: true });
  fixture.window.matchMedia = () => { throw Error('media unavailable'); };
  const store = createTerminalThemeStore(fixture.window);
  store.setPreference('dark');
  const unsubscribe = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), { preference: 'dark', resolved: 'dark' });
  unsubscribe();
  const again = store.subscribe(() => {});
  assert.equal(store.getSnapshot().resolved, 'dark', 'a denied write must not lose the in-memory choice on remount');
  again();
});

test('dock and workspaces share one listener pair; final unmount releases both', () => {
  const fixture = browser();
  const store = createTerminalThemeStore(fixture.window);
  let dock = 0, workspace = 0;
  const stopDock = store.subscribe(() => dock++);
  const stopWorkspace = store.subscribe(() => workspace++);
  assert.deepEqual(fixture.listenerCount(), { storage: 1, system: 1 });
  store.setPreference('dark');
  assert.equal(fixture.storage.get(THEME_STORAGE_KEY), 'dark');
  assert.equal(dock, 1); assert.equal(workspace, 1);
  store.setPreference('dark');
  assert.equal(dock, 1, 'duplicate choice does not rerender terminals');
  stopDock();
  assert.deepEqual(fixture.listenerCount(), { storage: 1, system: 1 });
  stopWorkspace(); stopWorkspace();
  assert.deepEqual(fixture.listenerCount(), { storage: 0, system: 0 });
});

test('system changes apply only in system mode and refresh after remount', () => {
  const fixture = browser({ value: 'system' });
  const store = createTerminalThemeStore(fixture.window);
  const stop = store.subscribe(() => {});
  fixture.changeSystem(true);
  assert.deepEqual(store.getSnapshot(), { preference: 'system', resolved: 'dark' });
  store.setPreference('light');
  fixture.changeSystem(false); fixture.changeSystem(true);
  assert.deepEqual(store.getSnapshot(), { preference: 'light', resolved: 'light' });
  store.setPreference('system');
  stop();
  fixture.changeSystem(false);
  const again = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), { preference: 'system', resolved: 'light' });
  again();
});

test('other browser windows synchronize appearance; unrelated storage cannot change it', () => {
  const fixture = browser();
  const store = createTerminalThemeStore(fixture.window);
  const stop = store.subscribe(() => {});
  fixture.changeStorage('dark', 'unrelated-setting');
  assert.equal(store.getSnapshot().resolved, 'light');
  fixture.changeStorage('dark', THEME_STORAGE_KEY, {});
  assert.equal(store.getSnapshot().resolved, 'light');
  fixture.changeStorage('dark');
  assert.equal(store.getSnapshot().resolved, 'dark');
  fixture.changeStorage(null, null);
  assert.deepEqual(store.getSnapshot(), { preference: 'light', resolved: 'light' });
  stop();
});
