import { createHash } from 'node:crypto'

const EVENT = 'dsh-terminal/independent-scope'
const MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const identity = policy => `session-side-terminal-${createHash('sha256').update(JSON.stringify([policy.workspaceRoot, policy.mode])).digest('hex').slice(0, 32)}`

/** Workspace-scoped, real DSH owners. Never fork or copy a conversation log. */
export class IndependentScopes {
  constructor(terminals) {
    this.terminals = terminals
    this.pending = new Map()
    this.handles = new Map()
    this.controller = new AbortController()
  }

  policy(owner) {
    this.terminals.current(owner)
    const policy = this.terminals.ctx.sandboxPolicy.resolve({ session: owner.session })
    if (!MODES.has(policy.mode) || typeof policy.workspaceRoot !== 'string' || !policy.workspaceRoot) throw new Error('无法确认工作区权限，请重新打开当前对话')
    return { workspaceRoot: policy.workspaceRoot, mode: policy.mode }
  }

  validate(session, policy) {
    const marker = session.events[0]
    const actual = this.terminals.ctx.sandboxPolicy.resolve({ session })
    if (session.id !== identity(policy) || session.header.cwd !== policy.workspaceRoot || marker?.type !== EVENT ||
      marker.data?.version !== 1 || marker.data?.workspaceRoot !== policy.workspaceRoot || marker.data?.mode !== policy.mode ||
      actual.workspaceRoot !== policy.workspaceRoot || actual.mode !== policy.mode) {
      throw new Error('这个独立终端不属于当前工作区或权限已变化，请从原工作区重新连接')
    }
  }

  async resolve(source, request, signal) {
    const policy = this.policy(source)
    const sessionId = identity(policy)
    if (request.sessionId && request.sessionId !== sessionId) throw new Error('请在原工作区的对话中重新连接这个独立终端')
    signal?.throwIfAborted()
    let pending = this.pending.get(sessionId)
    if (!pending) {
      pending = this.connect(source, policy, signal)
      this.pending.set(sessionId, pending)
      void pending.finally(() => { if (this.pending.get(sessionId) === pending) this.pending.delete(sessionId) }).catch(() => {})
    }
    const result = await pending
    signal?.throwIfAborted()
    const current = this.policy(source)
    if (identity(current) !== sessionId) throw new Error('当前工作区权限已变化，请重新连接独立终端')
    return result
  }

  async connect(source, policy, requestSignal) {
    const { ctx } = this.terminals
    const sessionId = identity(policy)
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.controller.signal]) : this.controller.signal
    signal.throwIfAborted()
    const live = ctx.agents.get(sessionId)
    if (live) {
      this.validate(live.session, policy)
      this.terminals.owned(live)
      return { sessionId, cwd: policy.workspaceRoot, mode: policy.mode, restored: true }
    }
    const persistence = ctx.get('sessionPersistence')
    if (!persistence?.list || !ctx.agents.create || !ctx.agents.resume) throw new Error('当前环境暂不支持独立终端，请先使用随对话终端')
    const headers = await persistence.list(signal)
    signal.throwIfAborted()
    const restoring = headers.some(header => header.id === sessionId)
    const check = agent => {
      signal.throwIfAborted()
      if (identity(this.policy(source)) !== sessionId) throw new Error('当前工作区权限已变化，请重试')
      this.validate(agent.session, policy)
    }
    const options = {
      signal,
      // Only route scalars are inherited; no user prompt, inbox, tools, or history.
      agentOptions: Object.fromEntries(['provider', 'model', 'maxTokens'].flatMap(key => source.options?.[key] === undefined ? [] : [[key, source.options[key]]])),
      setup: agentCtx => { check(agentCtx.agent); return { commit: () => check(agentCtx.agent) } },
    }
    const time = Date.now()
    const handle = restoring
      ? await ctx.agents.resume({ ...options, resumeSessionId: sessionId })
      : await ctx.agents.create({ ...options, sessionId, meta: { cwd: policy.workspaceRoot }, seed: [
        // Other plugins may ignore this informational marker; our resolver fails
        // closed if it is absent. The actual policy remains a native DSH event.
        { seq: 0, time, type: EVENT, ignorable: true, data: { version: 1, workspaceRoot: policy.workspaceRoot, mode: policy.mode } },
        { seq: 1, time, type: 'sandbox/mode', data: { mode: policy.mode } },
      ] })
    try {
      signal.throwIfAborted()
      check(handle.agent)
      this.terminals.owned(handle.agent)
      this.handles.set(sessionId, handle)
      if (!restoring) await ctx.get('sessionTitle')?.rename(handle.agent.session, 'Side Terminal')
      check(handle.agent)
      return { sessionId, cwd: policy.workspaceRoot, mode: policy.mode, restored: restoring }
    } catch (error) {
      this.handles.delete(sessionId)
      await handle.dispose()
      throw error
    }
  }

  async quiesce() {
    this.controller.abort()
    await Promise.allSettled([...this.pending.values()])
  }

  async stop() {
    await this.quiesce()
    const results = await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    this.handles.clear()
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, '部分独立终端未完成清理')
  }
}
