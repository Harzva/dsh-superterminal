import { z } from 'zod'

const boundedId = z.string().min(1).max(128)
const groupMember = z.object({ terminalId: boundedId, mode: z.enum(['dsh-ai', 'cli']), title: z.string().trim().min(1).max(120) }).strict()
const groupMembers = z.array(groupMember).min(1).max(6).refine(members => new Set(members.map(member => member.terminalId)).size === members.length, '每个终端只能加入一次')
const dimensions = { rows: z.number().int().min(2).max(500), cols: z.number().int().min(10).max(1000) }
export const requests = {
  groupList: z.object({}).strict(),
  groupRead: z.object({ groupId: boundedId }).strict(),
  groupCreate: z.object({ requestId: boundedId, title: z.string().trim().min(1).max(120), members: groupMembers }).strict(),
  groupUpdate: z.object({ groupId: boundedId, requestId: boundedId, title: z.string().trim().min(1).max(120), members: groupMembers }).strict(),
  groupSend: z.object({ groupId: boundedId, requestId: boundedId, prompt: z.string().trim().min(1).max(4000),
    targets: z.array(boundedId).min(1).max(6).refine(targets => new Set(targets).size === targets.length, '参会者不能重复'),
    rounds: z.number().int().min(1).max(2), kind: z.enum(['discussion', 'conclusion']),
    excerpt: z.object({ terminalId: boundedId, text: z.string().trim().min(1).max(4000) }).strict().optional(),
  }).strict().refine(input => input.kind !== 'conclusion' || (input.targets.length === 1 && input.rounds === 1), '请选择一位成员整理结论'),
  groupStop: z.object({ groupId: boundedId }).strict(),
  groupArchive: z.object({ groupId: boundedId }).strict(),
  list: z.object({}).strict(),
  runState: z.object({ terminalId: boundedId }).strict(),
  runSend: z.object({ terminalId: boundedId, requestId: boundedId, prompt: z.string().trim().min(1).max(8000), excerpt: z.string().trim().max(8000).optional() }).strict(),
  runStop: z.object({ terminalId: boundedId }).strict(),
  handoffStart: z.object({ requestId: boundedId, sourceTerminalId: boundedId,
    sourceGroupId: boundedId.optional(),
    targetLauncher: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), prompt: z.string().trim().min(1).max(4000),
    excerpt: z.string().trim().max(8000).optional(), criteria: z.string().trim().max(2000).optional(),
    returnToConversation: z.boolean().optional() }).strict(),
  handoffList: z.object({}).strict(),
  handoffCancel: z.object({ taskId: boundedId }).strict(),
  handoffReturn: z.object({ taskId: boundedId }).strict(),
  handoffAccept: z.object({ taskId: boundedId, requestId: boundedId, notes: z.string().trim().max(2000).optional() }).strict(),
  handoffRework: z.object({ taskId: boundedId, requestId: boundedId, issues: z.string().trim().min(1).max(4000),
    targetLauncher: z.enum(['pi', 'piagent', 'codex']).optional(), returnToConversation: z.boolean().optional() }).strict(),
  inventory: z.object({}).strict(),
  agentCheck: z.object({ launcher: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/) }).strict(),
  commands: z.object({ terminalId: boundedId, lastN: z.number().int().min(1).max(50).optional() }).strict(),
  independent: z.object({ sessionId: boundedId.optional() }).strict(),
  suggest: z.object({ prompt: z.string().trim().min(1).max(4000), terminalId: boundedId.optional(), excerpt: z.string().trim().max(8000).optional() }).strict()
    .refine(value => !value.excerpt || !!value.terminalId, { message: '分享输出前请先选择终端', path: ['terminalId'] }),
  open: z.object({ launcher: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), requestId: boundedId, ...dimensions }).strict(),
  read: z.object({ terminalId: boundedId, offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  claim: z.object({ terminalId: boundedId, viewerId: boundedId }).strict(),
  write: z.object({ terminalId: boundedId, lease: boundedId, sequence: z.number().int().nonnegative(), data: z.string().min(1).max(65536) }).strict(),
  resize: z.object({ terminalId: boundedId, lease: boundedId, ...dimensions }).strict(),
  close: z.object({ terminalId: boundedId, lease: boundedId }).strict(),
}
export const METHODS = Object.keys(requests)
const strict = (typeSymbol, schema) => ({ mode: 'strict', typeSymbol, schema })
export const DESCRIPTORS = METHODS.map(method => ({
  id: `@harzva/dsh-terminal#dshTerminal/${method}`,
  service: 'dshTerminal', namespace: 'dshTerminal', method,
  invocation: { kind: 'direct' },
  parameters: [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: strict('@deepseek-ai/dsh-session/types#SessionId', boundedId) },
    { name: 'request', wire: 'request', source: 'json', codec: strict(`@harzva/dsh-terminal#${method}Request`, requests[method]) },
  ],
  cancellation: { parameter: 'signal' },
  result: strict('@harzva/dsh-terminal#TerminalResult', z.json()),
}))
export const TYPERT = { package: '@harzva/dsh-terminal', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: DESCRIPTORS }
export const TYPERT_REMOTE = { package: '@harzva/dsh-terminal', descriptors: DESCRIPTORS }

export default TYPERT
