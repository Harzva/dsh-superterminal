import { createHash } from 'node:crypto'
import { z } from 'zod'

const id = z.string().min(1).max(128)
const launcher = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const handoffRecordSchema = z.object({
  id, requestId: id, sourceSessionId: id, sourceTerminalId: id,
  sourceLauncher: launcher, targetLauncher: launcher,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  prompt: z.string().min(1).max(8000), excerpt: z.string().max(8000).optional(),
  criteria: z.string().max(4000).optional(), returnToConversation: z.boolean(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  delivery: z.enum(['none', 'queued', 'failed', 'uncertain']),
  result: z.string().max(16000).optional(), error: z.string().max(1000).optional(),
  createdAt: time, updatedAt: time, exitCode: z.number().int().nullable(),
  messageId: id.optional(),
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
