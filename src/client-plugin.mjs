import * as React from 'react'
import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import { TYPERT_REMOTE, METHODS } from './remote.mjs'
import { TerminalWorkspace } from './client/index.ts'

export const name = 'dsh-terminal-client'
export const inject = ['slots', 'remote', 'sessions']

export function createTerminalViewStore() {
  return defineStore({
    init: () => ({ opened: false, sessionId: null }),
    actions: {
      open: (draft, sessionId) => { draft.sessionId = sessionId; draft.opened = true },
      hide: draft => { draft.opened = false },
    },
  })
}

function TerminalEntry(props) {
  const current = props.useSessions(state => state.current)
  const available = props.isAvailable(current)
  return React.createElement('button', {
    type: 'button', title: available ? '打开当前会话的原生终端 · /terminal' : '请先选择一个工作区的主会话',
    disabled: !available, onClick: () => props.openTerminal(current),
    style: { width: '100%', padding: '9px 12px', textAlign: props.wide ? 'left' : 'center', border: 0,
      borderRadius: 6, color: 'inherit', background: 'transparent', cursor: available ? 'pointer' : 'default' },
  }, props.wide ? '>_ 终端' : '>_')
}

function TerminalComposerEntry(props) {
  if (!props.available) return null
  return React.createElement('button', {
    type: 'button', title: '打开当前会话的原生终端 · /terminal', 'aria-label': '打开终端',
    onClick: props.openTerminal,
    style: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 7px',
      border: 0, borderRadius: 5, font: 'inherit', fontSize: 12, whiteSpace: 'nowrap',
      color: 'inherit', background: 'transparent', cursor: 'pointer' },
  }, React.createElement('span', { 'aria-hidden': true }, '>_'), '终端')
}

function TerminalOverlay(props) {
  const state = props.useStore(value => value)
  const bridge = React.useMemo(() => Object.fromEntries(METHODS.map(method => [method,
    (request = {}) => props.invokeTerminal(state.sessionId, method, request),
  ])), [state.sessionId, props.invokeTerminal])
  if (!state.sessionId) return null
  return React.createElement('section', { role: 'dialog', 'aria-label': 'DSH 原生终端', 'aria-modal': state.opened,
    style: { display: state.opened ? 'flex' : 'none', position: 'fixed', inset: 8, zIndex: 100,
      pointerEvents: 'auto', flexDirection: 'column', borderRadius: 10, overflow: 'hidden',
      background: '#0b1016', border: '1px solid #314252', boxShadow: '0 16px 70px #0008' } },
  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '7px 14px', color: '#a9bacb', flexShrink: 0 } },
    React.createElement('span', { style: { flex: 1, fontSize: 12 } }, '当前 DSH 会话 · 原生终端'),
    React.createElement('button', { type: 'button', onClick: props.actions.hide,
      style: { border: '1px solid #314252', background: 'transparent', color: '#d9e1ea', borderRadius: 5, padding: '4px 12px', cursor: 'pointer' } }, '返回 DSH')),
  React.createElement('div', { style: { flex: 1, minHeight: 0 } },
    React.createElement(TerminalBoundary, { key: state.sessionId }, React.createElement(TerminalWorkspace, { bridge, sessionId: state.sessionId }))))
}

class TerminalBoundary extends React.Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error: String(error?.message ?? error) } }
  render() {
    if (this.state.error) return React.createElement('div', { role: 'alert', style: { padding: 20 } }, '暂时无法显示终端，请关闭后重新打开。')
    return this.props.children
  }
}

export async function apply(ctx) {
  let mountError
  try { await ctx.remote.$mount(TYPERT_REMOTE) }
  catch (error) { mountError = String(error?.message ?? error) }
  const store = createTerminalViewStore()
  // Only the root overlay owns this store. The root entry's inject hook binds
  // its framework-created actions; session seats receive plain callbacks.
  let viewActions
  ctx.effect(() => () => { viewActions = undefined }, 'dsh-terminal: view binding')
  const isAvailable = sessionId => Boolean(sessionId
    && ctx.sessions.list.getSnapshot().byId[sessionId]
    && ctx.sessions.subagentAddress(sessionId) === undefined)
  const openTerminal = sessionId => {
    if (!isAvailable(sessionId)) throw new Error('请先选择一个工作区的主会话')
    if (ctx.sessions.list.getSnapshot().current !== sessionId) throw new Error('会话已切换，请重新打开终端')
    if (!viewActions) throw new Error('终端视图尚未就绪，请稍后重试')
    viewActions.open(sessionId)
  }
  const invokeTerminal = async (sessionId, method, request) => {
      if (mountError) throw new Error(mountError)
      const remote = ctx.get('remote.dshTerminal')
      if (!remote) throw new Error('终端 Host 连接暂不可用')
      const result = await remote[method](sessionId, request)
      if (!result.ok) throw new Error(result.error?.message ?? '终端请求失败')
      return result.value
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'dsh-terminal-entry', order: 120,
    inject: () => ({ openTerminal, isAvailable }),
  }, TerminalEntry))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-terminal-workspace', order: 120, store,
    inject: (actions) => {
      viewActions = actions
      return { invokeTerminal }
    },
  }, TerminalOverlay))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'dsh-terminal-composer-entry', order: 120,
    inject: sessionId => ({ available: isAvailable(sessionId), openTerminal: () => openTerminal(sessionId) }),
  }, TerminalComposerEntry))
  // DSH owns slash matching, keyboard navigation, popup rendering and cleanup.
  // An optional service injection preserves the button on clients without it.
  ctx.inject(['commandUi'], (scope) => {
    const commands = scope.get('commandUi')
    scope.effect(() => commands.register({
      name: 'terminal', description: '打开当前会话的原生终端',
      available: session => isAvailable(session.sessionId),
      ui: {
        kind: 'popupSelect',
        options: async session => isAvailable(session.sessionId)
          ? [{ id: 'open', label: '打开终端', detail: '使用当前 DSH 会话，无需发送消息' }]
          : [],
        onSelect: (option, session) => {
          if (option.id === 'open') openTerminal(session.sessionId)
        },
      },
    }), 'dsh-terminal: /terminal contribution')
  })
}
