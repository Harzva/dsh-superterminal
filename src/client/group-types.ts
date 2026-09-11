export type GroupMemberMode = 'dsh-ai' | 'cli';
export type GroupStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface GroupMemberInput { terminalId: string; mode: GroupMemberMode; title: string }
export interface GroupMember extends GroupMemberInput { id: string; launcher: string }
export interface GroupCandidate {
  terminalId: string;
  launcher: string;
  model?: string;
  modes: {mode: GroupMemberMode; label: string; available: boolean; detail: string}[];
}
export interface GroupOperation {
  requestId: string;
  kind: 'discussion' | 'conclusion';
  status: Exclude<GroupStatus, 'idle'>;
  targets: string[];
  rounds: number;
  round: number;
  activeMemberId?: string;
  error?: string;
}
export interface GroupMessage {
  id: string;
  kind: 'user' | 'reply' | 'conclusion' | 'error';
  text: string;
  createdAt: number;
  requestId: string;
  memberId?: string;
  memberTitle?: string;
  terminalId?: string;
  launcher?: string;
  mode?: GroupMemberMode;
  model?: string;
  round?: number;
  sharedExcerpt?: {terminalId: string; text: string};
  taskId?: string;
}
export interface GroupSummary {
  id: string;
  title: string;
  status: GroupStatus;
  members: GroupMember[];
  updatedAt: number;
  archived?: boolean;
  operation?: GroupOperation;
}
export interface TerminalGroup extends GroupSummary { createdAt: number; messages: GroupMessage[] }
export interface GroupCreateInput { requestId: string; title: string; members: GroupMemberInput[] }
export interface GroupUpdateInput extends GroupCreateInput { groupId: string }
export interface GroupSendInput {
  groupId: string;
  requestId: string;
  prompt: string;
  targets: string[];
  rounds: 1 | 2;
  kind: 'discussion' | 'conclusion';
  excerpt?: {terminalId: string; text: string};
}
