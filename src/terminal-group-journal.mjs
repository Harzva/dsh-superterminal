import { createHash } from 'node:crypto'
import { z } from 'zod'
import { assertHandoffOwner } from './handoff-journal.mjs'

const id = z.string().min(1).max(128)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const status = z.enum(['idle', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
const mode = z.enum(['dsh-ai', 'cli'])
export const groupMemberSchema = z.object({ id, terminalId: id, mode, title: z.string().min(1).max(120), launcher: z.string().min(1).max(64) }).strict()
export const groupExcerptSchema = z.object({ terminalId: id, text: z.string().trim().min(1).max(4000) }).strict()
export const groupOperationSchema = z.object({ requestId: id, kind: z.enum(['discussion', 'conclusion']),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']), targets: z.array(id).min(1).max(6),
  rounds: z.number().int().min(1).max(2), round: z.number().int().min(0).max(2), activeMemberId: id.optional(), error: z.string().max(1000).optional() }).strict()
export const groupMessageSchema = z.object({ id, kind: z.enum(['user', 'reply', 'conclusion', 'error']), text: z.string().max(16000), createdAt: time,
  requestId: id, memberId: id.optional(), memberTitle: z.string().max(120).optional(), terminalId: id.optional(), launcher: z.string().max(64).optional(), mode: mode.optional(), model: z.string().max(256).optional(),
  round: z.number().int().min(1).max(2).optional(), sharedExcerpt: groupExcerptSchema.optional(), taskId: id.optional() }).strict()
export const groupRecordSchema = z.object({ id, sourceSessionId: id, createRequestId: id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1).max(120), status, members: z.array(groupMemberSchema).min(1).max(6), createdAt: time, updatedAt: time,
  archived: z.boolean().optional(), operation: groupOperationSchema.optional(), messages: z.array(groupMessageSchema).max(160),
  requests: z.array(z.object({ id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['create', 'update', 'send']) }).strict()).max(96),
}).strict()
export const terminalGroupDomainSpec = Object.freeze({ name: 'dsh_terminal_groups', version: 1, tables: { groups: { valueSchema: groupRecordSchema } } })
const keyOf = (ownerId, groupId) => createHash('sha256').update(JSON.stringify([ownerId, groupId])).digest('hex')

/** Same native domain facility and owner checks as handoffs; never a second session registry. */
export class TerminalGroupJournal {
  constructor(ctx) { this.ctx = ctx; this.chain = Promise.resolve(); this.recovered = new WeakSet(); this.closed = false }
  enqueue(operation) {
    if (this.closed) return Promise.reject(new Error('讨论组记录服务已关闭'))
    const pending = this.chain.then(operation); this.chain = pending.catch(() => {}); return pending
  }
  async open() {
    if (this.domain) return this.domain
    if (!this.opening) {
      const facility = this.ctx.get?.('storageDomain')
      if (typeof facility?.open !== 'function') throw new Error('当前 DSH 未提供讨论组存储，请检查工作区服务后重试。')
      this.opening = Promise.resolve().then(() => facility.open(terminalGroupDomainSpec))
        .then(domain => { this.domain = domain; return domain }).finally(() => { this.opening = null })
    }
    return this.opening
  }
  async recover(owner, table, signal) {
    if (this.recovered.has(owner)) return
    for (const [key, group] of table.entries()) {
      if (group.sourceSessionId !== owner.id || group.status !== 'running') continue
      assertHandoffOwner(this.ctx, owner, signal)
      const operation = { ...group.operation, status: 'interrupted', error: '上次讨论已中断，记录已保留；请确认后发起新的讨论。' }
      delete operation.activeMemberId
      await table.put(key, groupRecordSchema.parse({ ...group, status: 'interrupted', operation, updatedAt: Date.now() }))
    }
    assertHandoffOwner(this.ctx, owner, signal); this.recovered.add(owner)
  }
  list(owner, signal) {
    return this.enqueue(async () => {
      assertHandoffOwner(this.ctx, owner, signal)
      const table = (await this.open()).table('groups')
      await this.recover(owner, table, signal); assertHandoffOwner(this.ctx, owner, signal)
      return [...table.entries()].filter(([, row]) => row.sourceSessionId === owner.id).map(([, row]) => structuredClone(row))
    })
  }
  put(owner, value, signal) {
    return this.enqueue(async () => {
      assertHandoffOwner(this.ctx, owner, signal)
      const group = groupRecordSchema.parse(value)
      if (group.sourceSessionId !== owner.id) throw new Error('讨论组不属于当前会话')
      const table = (await this.open()).table('groups')
      await this.recover(owner, table, signal); assertHandoffOwner(this.ctx, owner, signal)
      const key = keyOf(owner.id, group.id), previous = table.get(key)
      if (previous && (previous.createRequestId !== group.createRequestId || previous.fingerprint !== group.fingerprint || previous.createdAt !== group.createdAt)) throw new Error('讨论组记录身份不匹配')
      if (previous?.requests.some(prior => !group.requests.some(next => next.id === prior.id && next.fingerprint === prior.fingerprint && next.kind === prior.kind))) throw new Error('已保存的讨论请求不可覆盖')
      await table.put(key, group); assertHandoffOwner(this.ctx, owner, signal)
      return structuredClone(group)
    })
  }
  close() {
    if (this.closing) return this.closing
    this.closed = true
    return this.closing = this.chain.then(async () => { if (this.opening) await this.opening; if (this.domain) await this.domain.close() })
  }
}
