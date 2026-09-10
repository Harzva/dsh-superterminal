export interface AgentRecord { id: string; label: string; available: boolean; executable: string | null; version: string | null; configuration: string; account: string; subscription: string; readiness: string }
export interface TerminalSummary {
  id: string;
  launcher: string;
  pid?: number | null;
  state: string;
  rows: number;
  cols: number;
  writer?: string | null;
  lease?: string;
  exitCode?: number | null;
}

export interface TerminalLauncher {
  id: string;
  label: string;
  available: boolean;
}

export interface HandoffTarget { id: string; label: string; available: boolean; reason?: string }
export interface HandoffTask {
  id: string;
  requestId: string;
  sourceSessionId: string;
  sourceTerminalId: string;
  sourceLauncher: string;
  targetLauncher: string;
  prompt: string;
  criteria?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  delivery: 'none' | 'queued' | 'failed' | 'uncertain';
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  exitCode?: number | null;
}
export interface HandoffInput {
  requestId: string;
  sourceTerminalId: string;
  targetLauncher: string;
  prompt: string;
  excerpt?: string;
  criteria?: string;
  returnToConversation?: boolean;
}

export interface TerminalBridge {
  handoffList(): Promise<{tasks: HandoffTask[]; targets: HandoffTarget[]}>;
  handoffStart(input: HandoffInput): Promise<HandoffTask | {rejected: true; message: string}>;
  handoffCancel(input: {taskId: string}): Promise<HandoffTask>;
  handoffReturn(input: {taskId: string}): Promise<HandoffTask>;
  inventory(): Promise<{agents: AgentRecord[]; checkedAt:string}>;
  suggest(input:{prompt:string;terminalId?:string;excerpt?:string}): Promise<{text:string;model:string;terminalId?:string|null}>;
  list(): Promise<{ terminals: TerminalSummary[]; launchers: TerminalLauncher[]; cwd: string }>;
  open(input: { launcher: string; rows: number; cols: number; requestId: string }): Promise<TerminalSummary>;
  read(input: { terminalId: string; offset: number }): Promise<{
    data: string;
    nextOffset: number;
    baseOffset: number;
    state: string;
    exitCode?: number | null;
    gap: boolean;
  }>;
  write(input: { terminalId: string; lease: string; sequence: number; data: string }): Promise<unknown>;
  resize(input: { terminalId: string; lease: string; rows: number; cols: number }): Promise<unknown>;
  claim(input: { terminalId: string; viewerId: string }): Promise<{ lease: string; nextSequence: number }>;
  close(input: { terminalId: string; lease: string }): Promise<unknown>;
}
