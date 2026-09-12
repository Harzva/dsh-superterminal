export const THEME_STORAGE_KEY = 'dsh-superterminal:appearance:v1';
const validPreference = value => value === 'light' || value === 'dark' || value === 'system';

// A shared store keeps the dock, expanded view and visited sessions in sync.
// No terminal or execution state belongs in appearance preferences.
export function createTerminalThemeStore(environment = typeof window === 'undefined' ? undefined : window) {
  let preference = 'light';
  let systemDark = false;
  let media;
  let listening = false;
  let volatile = false;
  const listeners = new Set();
  const read = () => {
    try {
      const value = environment?.localStorage?.getItem(THEME_STORAGE_KEY);
      if (!volatile) preference = validPreference(value) ? value : 'light';
    } catch {}
  };
  try { media = environment?.matchMedia?.('(prefers-color-scheme: dark)'); systemDark = Boolean(media?.matches); } catch {}
  read();
  let snapshot = Object.freeze({ preference, resolved: preference === 'system' ? (systemDark ? 'dark' : 'light') : preference });
  const publish = () => {
    const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
    if (snapshot.preference === preference && snapshot.resolved === resolved) return;
    snapshot = Object.freeze({ preference, resolved });
    for (const listener of listeners) listener();
  };
  const storageChanged = event => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== environment?.localStorage) return; } catch { return; }
    volatile = false; read(); publish();
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
      try { environment?.localStorage?.setItem(THEME_STORAGE_KEY, value); volatile = false; }
      catch { volatile = true; }
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
