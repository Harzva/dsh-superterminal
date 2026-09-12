import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTerminalThemeStore, THEME_STORAGE_KEY, THEME_ACCENT_STORAGE_KEY,
  TERMINAL_ACCENTS, TERMINAL_THEMES, getTerminalTheme,
} from '../src/client/terminal-theme.mjs';

function browser({ value = null, accent = null, dark = false, storageBlocked = false } = {}) {
  const storage = new Map([
    ...(value == null ? [] : [[THEME_STORAGE_KEY, value]]),
    ...(accent == null ? [] : [[THEME_ACCENT_STORAGE_KEY, accent]]),
  ]);
  const events = new Map();
  const mediaEvents = new Set();
  const blockedWrites = new Set();
  const localStorage = {
    getItem(key) { if (storageBlocked) throw Error('storage unavailable'); return storage.get(key) ?? null; },
    setItem(key, next) {
      if (storageBlocked || blockedWrites.has(key)) throw Error('storage unavailable');
      storage.set(key, next);
    },
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
    window, storage, blockedWrites,
    changeSystem(dark) { media.matches = dark; for (const fn of mediaEvents) fn({ matches: dark }); },
    changeStorage(value, key = THEME_STORAGE_KEY, storageArea = localStorage) {
      if (storageArea === localStorage) {
        if (key === null) storage.clear();
        else if (value == null) storage.delete(key);
        else storage.set(key, value);
      }
      for (const fn of events.get('storage') ?? []) fn({ key, storageArea });
    },
    listenerCount() { return { storage: events.get('storage')?.size ?? 0, system: mediaEvents.size }; },
  };
}

test('appearance defaults to light green and rejects invalid preferences independently', () => {
  for (const value of [null, '', 'unexpected', '{"theme":"dark"}']) {
    const store = createTerminalThemeStore(browser({ value, accent: value, dark: true }).window);
    const initial = store.getSnapshot();
    assert.deepEqual(initial, { preference: 'light', resolved: 'light', accent: 'green' });
    assert.equal(initial, store.getSnapshot(), 'React snapshots retain identity until an effective change');
    store.setPreference('unknown'); store.setAccent('unknown');
    assert.equal(store.getSnapshot(), initial);
  }
  assert.deepEqual(createTerminalThemeStore(browser({ value: 'dark', accent: 'invalid' }).window).getSnapshot(),
    { preference: 'dark', resolved: 'dark', accent: 'green' });
  assert.deepEqual(createTerminalThemeStore(browser({ value: 'invalid', accent: 'violet' }).window).getSnapshot(),
    { preference: 'light', resolved: 'light', accent: 'violet' });
});

test('appearance remains usable with blocked storage and media API', () => {
  const fixture = browser({ storageBlocked: true });
  fixture.window.matchMedia = () => { throw Error('media unavailable'); };
  const store = createTerminalThemeStore(fixture.window);
  store.setPreference('dark'); store.setAccent('rose');
  const unsubscribe = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), { preference: 'dark', resolved: 'dark', accent: 'rose' });
  unsubscribe();
  const again = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), { preference: 'dark', resolved: 'dark', accent: 'rose' },
    'a denied write must not lose either in-memory choice on remount');
  again();
});

test('appearance without a browser retains in-memory choices on subscribe', () => {
  const store = createTerminalThemeStore({});
  store.setPreference('system'); store.setAccent('amber');
  const stop = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), { preference: 'system', resolved: 'light', accent: 'amber' });
  stop();
});

test('dock and workspaces share one listener pair; final unmount releases both', () => {
  const fixture = browser();
  const store = createTerminalThemeStore(fixture.window);
  let dock = 0, workspace = 0;
  const stopDock = store.subscribe(() => dock++);
  const stopWorkspace = store.subscribe(() => workspace++);
  assert.deepEqual(fixture.listenerCount(), { storage: 1, system: 1 });
  store.setPreference('dark'); store.setAccent('blue');
  assert.equal(fixture.storage.get(THEME_STORAGE_KEY), 'dark');
  assert.equal(fixture.storage.get(THEME_ACCENT_STORAGE_KEY), 'blue');
  assert.equal(dock, 2); assert.equal(workspace, 2);
  const snapshot = store.getSnapshot();
  store.setPreference('dark'); store.setAccent('blue');
  assert.equal(dock, 2, 'duplicate choices do not rerender terminals');
  assert.equal(store.getSnapshot(), snapshot);
  stopDock();
  assert.deepEqual(fixture.listenerCount(), { storage: 1, system: 1 });
  stopWorkspace(); stopWorkspace();
  assert.deepEqual(fixture.listenerCount(), { storage: 0, system: 0 });
  fixture.changeStorage('violet', THEME_ACCENT_STORAGE_KEY);
  assert.equal(store.getSnapshot(), snapshot, 'unmounted subscribers receive no external updates');
  const again = store.subscribe(() => {});
  assert.equal(store.getSnapshot().accent, 'violet', 'remount refreshes the stored accent');
  again();
});

test('mode and accent persist independently across stores', () => {
  const fixture = browser({ value: 'dark', accent: 'blue' });
  const store = createTerminalThemeStore(fixture.window);
  store.setAccent('violet');
  assert.equal(fixture.storage.get(THEME_STORAGE_KEY), 'dark');
  store.setPreference('system');
  assert.equal(fixture.storage.get(THEME_ACCENT_STORAGE_KEY), 'violet');
  assert.deepEqual(createTerminalThemeStore(fixture.window).getSnapshot(),
    { preference: 'system', resolved: 'light', accent: 'violet' });
});

test('system changes apply only in system mode and never replace the accent', () => {
  const fixture = browser({ value: 'system', accent: 'amber' });
  const store = createTerminalThemeStore(fixture.window);
  const stop = store.subscribe(() => {});
  fixture.changeSystem(true);
  assert.deepEqual(store.getSnapshot(), { preference: 'system', resolved: 'dark', accent: 'amber' });
  store.setPreference('light');
  const snapshot = store.getSnapshot();
  fixture.changeSystem(false); fixture.changeSystem(true);
  assert.equal(store.getSnapshot(), snapshot);
  store.setAccent('slate');
  store.setPreference('system');
  stop();
  fixture.changeSystem(false);
  const again = store.subscribe(() => {});
  assert.deepEqual(store.getSnapshot(), { preference: 'system', resolved: 'light', accent: 'slate' });
  again();
});

test('other browser windows synchronize both choices; unrelated storage cannot change them', () => {
  const fixture = browser();
  const store = createTerminalThemeStore(fixture.window);
  const stop = store.subscribe(() => {});
  const initial = store.getSnapshot();
  fixture.changeStorage('dark', 'unrelated-setting');
  fixture.changeStorage('dark', THEME_STORAGE_KEY, {});
  fixture.changeStorage('violet', THEME_ACCENT_STORAGE_KEY, {});
  assert.equal(store.getSnapshot(), initial);
  fixture.changeStorage('dark');
  fixture.changeStorage('violet', THEME_ACCENT_STORAGE_KEY);
  assert.deepEqual(store.getSnapshot(), { preference: 'dark', resolved: 'dark', accent: 'violet' });
  fixture.changeStorage(null, null);
  assert.deepEqual(store.getSnapshot(), { preference: 'light', resolved: 'light', accent: 'green' });
  stop();
});

test('invalid or removed accent from another window falls back without changing mode', () => {
  const fixture = browser({ value: 'dark', accent: 'blue' });
  const store = createTerminalThemeStore(fixture.window);
  const stop = store.subscribe(() => {});
  fixture.changeStorage('invalid', THEME_ACCENT_STORAGE_KEY);
  assert.deepEqual(store.getSnapshot(), { preference: 'dark', resolved: 'dark', accent: 'green' });
  fixture.changeStorage('rose', THEME_ACCENT_STORAGE_KEY);
  fixture.changeStorage(null, THEME_ACCENT_STORAGE_KEY);
  assert.deepEqual(store.getSnapshot(), { preference: 'dark', resolved: 'dark', accent: 'green' });
  stop();
});

test('external mode changes do not discard an accent whose local write was denied, and vice versa', () => {
  for (const blockedKey of [THEME_ACCENT_STORAGE_KEY, THEME_STORAGE_KEY]) {
    const fixture = browser();
    fixture.blockedWrites.add(blockedKey);
    const store = createTerminalThemeStore(fixture.window);
    const stop = store.subscribe(() => {});
    if (blockedKey === THEME_ACCENT_STORAGE_KEY) {
      store.setAccent('rose'); fixture.changeStorage('dark');
    } else {
      store.setPreference('dark'); fixture.changeStorage('rose', THEME_ACCENT_STORAGE_KEY);
    }
    assert.deepEqual(store.getSnapshot(), { preference: 'dark', resolved: 'dark', accent: 'rose' });
    stop();
    const again = store.subscribe(() => {});
    assert.deepEqual(store.getSnapshot(), { preference: 'dark', resolved: 'dark', accent: 'rose' });
    again();
  }
});

test('terminal accents preserve ANSI semantics and reuse immutable theme objects', () => {
  const ansi = ['black','red','green','yellow','blue','magenta','cyan','white',
    'brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
  assert.equal(TERMINAL_ACCENTS.length, 6);
  assert.equal(new Set(TERMINAL_ACCENTS.map(a => a.id)).size, 6);
  assert.ok(Object.isFrozen(TERMINAL_ACCENTS));
  for (const accent of TERMINAL_ACCENTS) {
    assert.ok(Object.isFrozen(accent));
    assert.match(accent.swatch, /^#[\da-f]{6}$/i);
    for (const mode of ['light', 'dark']) {
      const theme = getTerminalTheme(mode, accent.id);
      assert.equal(getTerminalTheme(mode, accent.id), theme);
      assert.ok(Object.isFrozen(theme));
      for (const name of ansi) assert.equal(theme[name], TERMINAL_THEMES[mode][name], `${accent.id} ${mode} ${name}`);
      assert.equal(theme.background, TERMINAL_THEMES[mode].background);
    }
  }
  assert.equal(getTerminalTheme('light'), TERMINAL_THEMES.light);
  assert.equal(getTerminalTheme('dark', 'invalid'), TERMINAL_THEMES.dark);
});

function luminance(hex) {
  const rgb = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  return rgb.map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (values[1] + .05) / (values[0] + .05);
}
test('all terminal accents keep text, selection and cursor contrast readable in both modes', () => {
  for (const { id } of TERMINAL_ACCENTS) {
    for (const mode of ['light', 'dark']) {
      const theme = getTerminalTheme(mode, id);
      for (const [foreground, background] of [
        ['foreground', 'background'], ['cursor', 'background'], ['cursorAccent', 'cursor'],
        ['selectionForeground', 'selectionBackground'], ['foreground', 'selectionInactiveBackground'],
      ]) {
        assert.ok(contrast(theme[foreground], theme[background]) >= 4.5, `${mode} ${id}: ${foreground}/${background}`);
      }
    }
  }
});
