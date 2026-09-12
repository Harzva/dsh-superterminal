export const THEME_STORAGE_KEY = 'dsh-superterminal:appearance:v1';
export const THEME_ACCENT_STORAGE_KEY = 'dsh-superterminal:accent:v1';
export const TERMINAL_ACCENTS = Object.freeze([
  { id: 'green', label: '薄荷绿', swatch: '#176f5b' },
  { id: 'blue', label: '雾蓝', swatch: '#35639a' },
  { id: 'violet', label: '鸢尾紫', swatch: '#7254a0' },
  { id: 'amber', label: '琥珀', swatch: '#82601e' },
  { id: 'rose', label: '玫瑰', swatch: '#9a5269' },
  { id: 'slate', label: '石墨', swatch: '#586576' },
].map(Object.freeze));
const validAccent = value => TERMINAL_ACCENTS.some(accent => accent.id === value);
const validPreference = value => value === 'light' || value === 'dark' || value === 'system';

// A shared store keeps the dock, expanded view and visited sessions in sync.
// No terminal or execution state belongs in appearance preferences.
export function createTerminalThemeStore(environment = typeof window === 'undefined' ? undefined : window) {
  let preference = 'light';
  let accent = 'green';
  let systemDark = false;
  let media;
  let listening = false;
  let volatilePreference = false;
  let volatileAccent = false;
  const listeners = new Set();
  const read = () => {
    try {
      const value = environment?.localStorage?.getItem(THEME_STORAGE_KEY);
      if (!volatilePreference) preference = validPreference(value) ? value : 'light';
    } catch {}
    try {
      const value = environment?.localStorage?.getItem(THEME_ACCENT_STORAGE_KEY);
      if (!volatileAccent) accent = validAccent(value) ? value : 'green';
    } catch {}
  };
  try { media = environment?.matchMedia?.('(prefers-color-scheme: dark)'); systemDark = Boolean(media?.matches); } catch {}
  read();
  let snapshot = Object.freeze({ preference, accent, resolved: preference === 'system' ? (systemDark ? 'dark' : 'light') : preference });
  const publish = () => {
    const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
    if (snapshot.preference === preference && snapshot.resolved === resolved && snapshot.accent === accent) return;
    snapshot = Object.freeze({ preference, accent, resolved });
    for (const listener of listeners) listener();
  };
  const storageChanged = event => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== THEME_ACCENT_STORAGE_KEY && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== environment?.localStorage) return; } catch { return; }
    if (event.key === THEME_STORAGE_KEY || event.key === null) volatilePreference = false;
    if (event.key === THEME_ACCENT_STORAGE_KEY || event.key === null) volatileAccent = false;
    read(); publish();
  };
  const systemChanged = () => { systemDark = Boolean(media?.matches); publish(); };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (!listening) {
        listening = true;
        environment?.addEventListener?.('storage', storageChanged);
        media?.addEventListener?.('change', systemChanged);
        read(); systemDark = Boolean(media?.matches); publish();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size || !listening) return;
        listening = false;
        environment?.removeEventListener?.('storage', storageChanged);
        media?.removeEventListener?.('change', systemChanged);
      };
    },
    setPreference(value) {
      if (!validPreference(value)) return;
      preference = value;
      try {
        const storage = environment?.localStorage;
        if (!storage) throw Error('Storage unavailable');
        storage.setItem(THEME_STORAGE_KEY, value); volatilePreference = false;
      } catch { volatilePreference = true; }
      publish();
    },
    setAccent(value) {
      if (!validAccent(value)) return;
      accent = value;
      try {
        const storage = environment?.localStorage;
        if (!storage) throw Error('Storage unavailable');
        storage.setItem(THEME_ACCENT_STORAGE_KEY, value); volatileAccent = false;
      } catch { volatileAccent = true; }
      publish();
    },
  };
}

export const terminalThemeStore = createTerminalThemeStore();

export const TERMINAL_THEMES = Object.freeze({
  light: Object.freeze({
    background: '#fdfcf9', foreground: '#263731', cursor: '#16705d', cursorAccent: '#fdfcf9',
    selectionBackground: '#bbded3', selectionInactiveBackground: '#dee9e3', selectionForeground: '#18392e',
    black: '#263731', red: '#b43d49', green: '#307746', yellow: '#906b15',
    blue: '#316bb1', magenta: '#8e4b9b', cyan: '#137b80', white: '#e9ebe4',
    brightBlack: '#687970', brightRed: '#b33241', brightGreen: '#24753c', brightYellow: '#936215',
    brightBlue: '#2c61a5', brightMagenta: '#934198', brightCyan: '#0b7478', brightWhite: '#ffffff',
  }),
  dark: Object.freeze({
    background: '#10171b', foreground: '#dce6e1', cursor: '#94d7c3', cursorAccent: '#10171b',
    selectionBackground: '#345c50', selectionInactiveBackground: '#2c3c37', selectionForeground: '#f5faf7',
    black: '#283b34', red: '#f08b91', green: '#9cd7ac', yellow: '#e7c78b',
    blue: '#89b9ed', magenta: '#c2a2e8', cyan: '#7bd1cf', white: '#dce6e1',
    brightBlack: '#80968c', brightRed: '#ffa1a7', brightGreen: '#b4ebc2', brightYellow: '#f4d8a4',
    brightBlue: '#a3cdff', brightMagenta: '#d9bcfb', brightCyan: '#a0e7e5', brightWhite: '#f4f7fb',
  }),
});

// ANSI hues keep their command/status meaning; the selection and cursor follow
// the accent, with neutral body text. Frozen themes avoid allocating on renders.
const terminalAccentColors = {
  blue: { light: ['#35639a', '#c9daee', '#e3e9ef'], dark: ['#a4c5eb', '#354c69', '#2b3645'] },
  violet: { light: ['#7254a0', '#ddcfec', '#e9e4ef'], dark: ['#c7b2e6', '#524363', '#37303f'] },
  amber: { light: ['#82601e', '#ead9b8', '#eee8dd'], dark: ['#dfc18b', '#615139', '#39342b'] },
  rose: { light: ['#9a5269', '#ebcdd8', '#efe3e8'], dark: ['#e4b2c4', '#634654', '#3e3037'] },
  slate: { light: ['#586576', '#d4dde7', '#e5e9ee'], dark: ['#c0cbd9', '#465469', '#303945'] },
};
function createAccentedTerminalThemes(id) {
  if (id === 'green') return TERMINAL_THEMES;
  return Object.freeze(Object.fromEntries(['light', 'dark'].map(mode => {
    const [cursor, selectionBackground, selectionInactiveBackground] = terminalAccentColors[id][mode];
    return [mode, Object.freeze({
      ...TERMINAL_THEMES[mode], cursor, selectionBackground, selectionInactiveBackground,
      foreground: mode === 'light' ? '#28313b' : '#e1e5eb',
      selectionForeground: mode === 'light' ? '#28313b' : '#f4f6fa',
    })];
  })));
}
const accentedTerminalThemes = Object.freeze(Object.fromEntries(
  TERMINAL_ACCENTS.map(({ id }) => [id, createAccentedTerminalThemes(id)]),
));
export function getTerminalTheme(mode, accent = 'green') {
  return accentedTerminalThemes[validAccent(accent) ? accent : 'green'][mode === 'dark' ? 'dark' : 'light'];
}
