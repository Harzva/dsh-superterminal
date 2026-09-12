import type { GroupMember, GroupMemberInput, GroupCandidate } from './group-types';
export interface MemberReadiness { available: boolean; canOpen: boolean; label: string; detail: string }
export function memberReadiness(member: GroupMemberInput, terminals: {id: string; execution?: {kind: string}}[], candidates: GroupCandidate[]): MemberReadiness;
export function groupReadiness(members: GroupMember[], terminals: {id: string; execution?: {kind: string}}[], candidates: GroupCandidate[], targets: string[], author: string): {
  byId: Map<string, MemberReadiness>; targets: string[]; author: string; invalidTargets: string[]; canSend: boolean; canConclude: boolean;
};
