import { z } from 'zod'

const boundedId = z.string().min(1).max(128)
const dimensions = { rows: z.number().int().min(2).max(500), cols: z.number().int().min(10).max(1000) }
export const requests = {
  list: z.object({}).strict(),
  inventory: z.object({}).strict(),
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
