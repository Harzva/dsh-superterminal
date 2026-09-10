import type {NativeTaskState, NativeTaskInput} from './types';
export interface AssistantTarget { id: string; launcher: string; title?: string; number?: number }
export interface AssistantSeed { id: string; sessionId: string; terminalId: string; prompt: string; excerpt: string }
export interface AssistantSnapshot {
  prompt: string; excerpt: string; share: boolean; busy: boolean; error: string; request: number;
  copied: Record<string, 'copied' | 'failed'>; drafted?: number; seedId?: string;
  result?: {text: string; prompt: string; target: AssistantTarget; createdAt: number};
  terminalDraft?: {id: string; text: string};
  runDraft?: string; runExcerpt?: string; runState?: NativeTaskState; runPending?: NativeTaskInput;
  runBusy?: boolean; runError?: string; runErrorKind?: 'send' | 'stop'; runRevision?: number;
}
type Patch = Partial<AssistantSnapshot> | ((value: AssistantSnapshot) => Partial<AssistantSnapshot>);
function createMemory() {
  let snapshot: AssistantSnapshot = {prompt: '', excerpt: '', share: false, busy: false, error: '', request: 0, copied: {}};
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(patch: Patch) {
      snapshot = {...snapshot, ...(typeof patch === 'function' ? patch(snapshot) : patch)};
      for (const listener of listeners) listener();
    },
  };
}
type Memory = ReturnType<typeof createMemory>;
const owners = new Map<string, Map<string, Memory>>();
// Deliberately process memory only: transcripts and explicit excerpts never enter localStorage.
export function assistantMemory(sessionId: string, terminalId: string): Memory {
  let terminals = owners.get(sessionId);
  if (!terminals) terminals = new Map();
  owners.delete(sessionId); owners.set(sessionId, terminals);
  while (owners.size > 16) owners.delete(owners.keys().next().value!);
  const memory = terminals.get(terminalId) ?? createMemory();
  terminals.delete(terminalId); terminals.set(terminalId, memory);
  while (terminals.size > 24) terminals.delete(terminals.keys().next().value!);
  return memory;
}
export function rememberedTerminalDrafts(sessionId: string): Record<string, {id: string; text: string}> {
  return Object.fromEntries([...(owners.get(sessionId) ?? [])].flatMap(([id, memory]) => {
    const draft = memory.getSnapshot().terminalDraft;
    return draft ? [[id, draft]] : [];
  }));
}
