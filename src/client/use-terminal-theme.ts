import { useSyncExternalStore } from 'react';
import { terminalThemeStore } from './terminal-theme.mjs';

export function useTerminalTheme() {
  return useSyncExternalStore(terminalThemeStore.subscribe, terminalThemeStore.getSnapshot, terminalThemeStore.getSnapshot);
}
