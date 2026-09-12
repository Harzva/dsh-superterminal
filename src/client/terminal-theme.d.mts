export type TerminalThemePreference = 'light' | 'dark' | 'system';
export type TerminalThemeName = 'light' | 'dark';
export type TerminalAccentId = 'green' | 'blue' | 'violet' | 'amber' | 'rose' | 'slate';
export type TerminalThemeSnapshot = Readonly<{ preference: TerminalThemePreference; resolved: TerminalThemeName; accent: TerminalAccentId }>;
export type TerminalThemeStore = {
  getSnapshot(): TerminalThemeSnapshot;
  subscribe(listener: () => void): () => void;
  setPreference(value: TerminalThemePreference): void;
  setAccent(value: TerminalAccentId): void;
};
export function createTerminalThemeStore(environment?: Window): TerminalThemeStore;
export const THEME_STORAGE_KEY: string;
export const THEME_ACCENT_STORAGE_KEY: string;
export const TERMINAL_ACCENTS: ReadonlyArray<Readonly<{ id: TerminalAccentId; label: string; swatch: string }>>;
export const terminalThemeStore: TerminalThemeStore;
export const TERMINAL_THEMES: Readonly<Record<TerminalThemeName, import('@xterm/xterm').ITheme>>;
export function getTerminalTheme(mode: TerminalThemeName, accent?: TerminalAccentId): Readonly<import('@xterm/xterm').ITheme>;
