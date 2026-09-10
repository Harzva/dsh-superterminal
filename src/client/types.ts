export interface ReadinessPoint { state: string; label: string; detail: string; checkedAt: number | null }
export interface AgentHealth { installation: ReadinessPoint; authentication: ReadinessPoint; connection: ReadinessPoint; quota: ReadinessPoint; canCheckLogin: boolean }
export interface AgentRecord { id: string; label: string; available: boolean; executable: string | null; version: string | null; configuration: string; account: string; subscription: string; readiness: string; health?: AgentHealth }
export interface CommandRecord { id: string; command: string; commandTruncated: boolean; output: string; outputTruncated: boolean; startedAt: number; finishedAt: number | null; durationMs: number | null; exitCode: number | null; status: 'running' | 'succeeded' | 'failed' | 'interrupted' }
export interface CommandSnapshot { terminalId: string; status: 'starting' | 'ready' | 'unavailable' | 'ended'; reason?: string; records: CommandRecord[]; truncated: boolean }
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
  acceptance?: 'pending' | 'accepted' | 'rework';
  reviewedAt?: number;
  executionFinishedAt?: number;
  reviewNotes?: string;
  reviewRequestId?: string;
  parentTaskId?: string;
  reworkTaskId?: string;
  reworkIssues?: string;
  previousResult?: string;
  savePending?: boolean;
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
export interface HandoffAcceptInput { taskId: string; requestId: string; notes?: string }
export interface HandoffReworkInput { taskId: string; requestId: string; issues: string; targetLauncher?: string; returnToConversation?: boolean }

export interface NativeTaskState {
  terminalId: string; sessionId?: string;
  status: 'idle' | 'running' | 'stopping' | 'failed' | 'completed';
  canStop?: boolean;
  messages: {id: string; role: 'user' | 'assistant' | 'tool'; text: string; title?: string; status?: 'queued' | 'pending' | 'running' | 'completed' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'}[];
  model?: string; permission?: string; error?: string; acceptedRequestIds?: string[];
}
export interface NativeTaskInput { terminalId: string; requestId: string; prompt: string; excerpt?: string }
export interface TerminalBridge {
  runState(input: {terminalId: string}): Promise<NativeTaskState>;
  runSend(input: NativeTaskInput): Promise<NativeTaskState>;
  runStop(input: {terminalId: string}): Promise<NativeTaskState>;
  handoffList(): Promise<{tasks: HandoffTask[]; targets: HandoffTarget[]}>;
  handoffStart(input: HandoffInput): Promise<HandoffTask | {rejected: true; message: string}>;
  handoffCancel(input: {taskId: string}): Promise<HandoffTask>;
  handoffReturn(input: {taskId: string}): Promise<HandoffTask>;
  handoffAccept(input: HandoffAcceptInput): Promise<HandoffTask | {rejected: true; message: string}>;
  handoffRework(input: HandoffReworkInput): Promise<HandoffTask | {rejected: true; message: string}>;
  inventory(): Promise<{agents: AgentRecord[]; checkedAt:string}>;
  agentCheck(input: {launcher: string}): Promise<{supported: boolean; authentication?: ReadinessPoint}>;
  commands(input: {terminalId: string; lastN?: number}): Promise<CommandSnapshot>;
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
