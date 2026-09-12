export type TerminalThemePreference = 'light' | 'dark' | 'system';
export type TerminalThemeName = 'light' | 'dark';
export type TerminalThemeSnapshot = Readonly<{ preference: TerminalThemePreference; resolved: TerminalThemeName }>;
export type TerminalThemeStore = {
  getSnapshot(): TerminalThemeSnapshot;
  subscribe(listener: () => void): () => void;
  setPreference(value: TerminalThemePreference): void;
};
export function createTerminalThemeStore(environment?: Window): TerminalThemeStore;
export const THEME_STORAGE_KEY: string;
export const terminalThemeStore: TerminalThemeStore;
export const TERMINAL_THEMES: Readonly<Record<TerminalThemeName, import('@xterm/xterm').ITheme>>;
