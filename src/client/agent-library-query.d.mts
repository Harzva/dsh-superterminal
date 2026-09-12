import type { AgentRecord } from './types';
export function filterAgents(agents: readonly AgentRecord[], query: string, filter?: 'installed' | 'all'): AgentRecord[];
