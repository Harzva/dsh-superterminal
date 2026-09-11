import { createHash } from 'node:crypto'
import { z } from 'zod'

const id = z.string().min(1).max(128)
const launcher = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
// Retain every accepted identity and result. Independent bounded budgets avoid
// discarding idempotency receipts or allowing meetings to consume execution slots.
export const handoffRetentionLimits = Object.freeze({ execution: 32, discussion: 256 })
export const handoffRetentionKind = task => task.sourceGroupId && task.groupPurpose === 'discussion' && !task.parentTaskId ? 'discussion' : 'execution'
export const handoffRetentionError = kind => kind === 'discussion'
  ? '当前会话的 256 条讨论发言记录已满，请在新会话继续讨论；执行与返工的记录容量独立计算。'
  : '当前会话的 32 条执行与返工记录已满，请在新会话继续执行；讨论发言的记录容量独立计算。'
export const handoffRecordSchema = z.object({
  id, requestId: id, sourceSessionId: id, sourceTerminalId: id,
  sourceGroupId: id.optional(), groupPurpose: z.enum(['discussion', 'execution']).optional(),
  sourceLauncher: launcher, targetLauncher: launcher,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  prompt: z.string().min(1).max(8000), excerpt: z.string().max(8000).optional(),
  criteria: z.string().max(4000).optional(), returnToConversation: z.boolean(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  delivery: z.enum(['none', 'queued', 'failed', 'uncertain']),
  result: z.string().max(16000).optional(), error: z.string().max(1000).optional(),
  resultTruncated: z.boolean().optional(), totalResultLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  createdAt: time, updatedAt: time, exitCode: z.number().int().nullable(),
  executionFinishedAt: time.optional(),
  messageId: id.optional(),
  acceptance: z.enum(['pending', 'accepted', 'rework']).default('pending'),
  reviewedAt: time.optional(), reviewNotes: z.string().max(2000).optional(), reviewRequestId: id.optional(),
  parentTaskId: id.optional(), reworkTaskId: id.optional(),
  reworkIssues: z.string().min(1).max(4000).optional(), previousResult: z.string().max(8000).optional(),
}).strict()

// Native non-session storage: external event names cannot safely round-trip
// through the rc.2 session log's closed known-event catalog.
export const handoffDomainSpec = Object.freeze({
  name: 'dsh_terminal_handoffs', version: 1,
  tables: { tasks: { valueSchema: handoffRecordSchema } },
})
const keyOf = (sessionId, taskId) => createHash('sha256').update(JSON.stringify([sessionId, taskId])).digest('hex')

export function assertHandoffOwner(ctx, owner, signal) {
  signal?.throwIfAborted()
  if (!owner?.id || !owner.session || ctx.agents?.get(owner.id) !== owner) {
    throw new Error('交接所属 DSH 会话已失效，请重新打开原会话')
  }
}

/** Owns one native domain handle, never a second project/session registry. */
export class HandoffJournal {
  constructor(ctx) {
    this.ctx = ctx
    this.domain = null
    this.opening = null
    this.chain = Promise.resolve()
    this.recovered = new WeakSet()
    this.closed = false
    this.closing = null
  }

  async open() {
    if (this.domain) return this.domain
    if (!this.opening) {
      const facility = this.ctx.get?.('storageDomain')
      if (!facility || typeof facility.open !== 'function') {
        throw new Error('当前 DSH 未提供任务存储，请检查工作区服务后重试')
      }
      this.opening = Promise.resolve().then(() => facility.open(handoffDomainSpec))
        .then(domain => { this.domain = domain; return domain })
        .finally(() => { this.opening = null })
    }
    return this.opening
  }

  enqueue(operation) {
    if (this.closed) return Promise.reject(new Error('交接记录服务已关闭'))
    const promise = this.chain.then(operation)
    this.chain = promise.then(() => {}, () => {})
    return promise
  }

  async recover(owner, table, signal) {
    if (this.recovered.has(owner)) return
    // A crash may land after the child record but before its parent link. The
    // durable child is sufficient to restore that relationship, never to run it.
    for (const [, child] of table.entries()) {
      if (child.sourceSessionId !== owner.id || !child.parentTaskId) continue
      const key = keyOf(owner.id, child.parentTaskId), parent = table.get(key)
      if (!parent || parent.sourceSessionId !== owner.id || parent.acceptance === 'accepted' || parent.reworkTaskId) continue
      assertHandoffOwner(this.ctx, owner, signal)
      await table.put(key, handoffRecordSchema.parse({ ...parent, acceptance: 'rework', reworkTaskId: child.id,
        reviewedAt: child.createdAt, reviewRequestId: child.requestId, reviewNotes: (child.reworkIssues ?? '').slice(0, 2000),
        updatedAt: Math.max(parent.updatedAt, child.createdAt) }))
    }
    for (const [key, task] of table.entries()) {
      if (task.sourceSessionId !== owner.id || (task.status !== 'queued' && task.status !== 'running')) continue
      assertHandoffOwner(this.ctx, owner, signal)
      await table.put(key, handoffRecordSchema.parse({ ...task, status: 'interrupted',
        error: '上次运行已中断。任务记录已保留，请确认后新建交接。', updatedAt: Date.now() }))
    }
    assertHandoffOwner(this.ctx, owner, signal)
    this.recovered.add(owner)
  }

  list(owner, signal) {
    return this.enqueue(async () => {
      assertHandoffOwner(this.ctx, owner, signal)
      const table = (await this.open()).table('tasks')
      assertHandoffOwner(this.ctx, owner, signal)
      await this.recover(owner, table, signal)
      return [...table.entries()].filter(([, task]) => task.sourceSessionId === owner.id)
        .map(([, task]) => structuredClone(task)).sort((a, b) => b.createdAt - a.createdAt)
    })
  }

  put(owner, task, signal) {
    return this.enqueue(async () => {
      assertHandoffOwner(this.ctx, owner, signal)
      const clean = handoffRecordSchema.parse(task)
      if (clean.sourceSessionId !== owner.id) throw new Error('交接记录不属于当前会话')
      const table = (await this.open()).table('tasks')
      assertHandoffOwner(this.ctx, owner, signal)
      await this.recover(owner, table, signal)
      const key = keyOf(owner.id, clean.id)
      const previous = table.get(key)
      if (previous && (previous.requestId !== clean.requestId || previous.fingerprint !== clean.fingerprint)) {
        throw new Error('交接记录身份不匹配')
      }
      if (previous && previous.parentTaskId !== clean.parentTaskId) throw new Error('返工来源不可更改')
      if (previous && (previous.sourceGroupId !== clean.sourceGroupId || (previous.groupPurpose ?? 'execution') !== (clean.groupPurpose ?? 'execution'))) {
        throw new Error('已保存的交接来源与用途不可更改')
      }
      if (!previous) {
        const kind = handoffRetentionKind(clean)
        const count = [...table.entries()].filter(([, record]) => record.sourceSessionId === owner.id && handoffRetentionKind(record) === kind).length
        if (count >= handoffRetentionLimits[kind]) throw new Error(handoffRetentionError(kind))
      }
      if (previous?.acceptance === 'accepted' && (clean.acceptance !== 'accepted' ||
        clean.reviewRequestId !== previous.reviewRequestId || clean.reviewedAt !== previous.reviewedAt || clean.reviewNotes !== previous.reviewNotes)) {
        throw new Error('已保存的验收记录不可覆盖')
      }
      if (clean.acceptance !== 'pending' && (clean.reviewedAt === undefined || !clean.reviewRequestId ||
        (clean.acceptance === 'rework' && !clean.reworkTaskId))) throw new Error('验收或返工记录不完整')
      if (clean.parentTaskId) {
        const parent = table.get(keyOf(owner.id, clean.parentTaskId))
        if (clean.parentTaskId === clean.id || !parent || parent.sourceSessionId !== owner.id ||
          parent.sourceTerminalId !== clean.sourceTerminalId || parent.sourceLauncher !== clean.sourceLauncher) {
          throw new Error('返工来源不属于当前会话')
        }
      }
      await table.put(key, clean)
      assertHandoffOwner(this.ctx, owner, signal)
      return structuredClone(clean)
    })
  }

  close() {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = this.chain.then(async () => {
      if (this.opening) await this.opening
      if (this.domain) await this.domain.close()
    })
    return this.closing
  }
}
