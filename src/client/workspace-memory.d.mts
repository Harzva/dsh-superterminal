import type { TerminalExecution } from './types';
import type { LayoutTree, LayoutPreset } from './layout.mjs';
export type WorkspaceMemory = {
  layout: LayoutTree | null;
  preset: LayoutPreset | 'custom';
  selectedSlot: number;
  slots: ({ id: string; launcher: string; title: string; execution?: TerminalExecution } | null)[];
};
export type WorkspaceMemoryOptions = {
  origin?: string;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
};
export function loadWorkspaceMemory(sessionId: string, options?: WorkspaceMemoryOptions): WorkspaceMemory | null;
export function saveWorkspaceMemory(sessionId: string, value: WorkspaceMemory, options?: WorkspaceMemoryOptions): boolean;
