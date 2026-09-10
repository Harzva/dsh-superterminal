import * as React from 'react'
import { createPortal } from 'react-dom'
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

function readSidePreference() {
  try {
    const raw = localStorage.getItem('dsh-superterminal:side:v1')
    if (!raw || raw.length > 1200) return null
    const value = JSON.parse(raw)
    const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
    if (!validId(value.sourceSessionId) || !validId(value.sessionId)) return null
    return { sourceSessionId: value.sourceSessionId, sessionId: value.sessionId, mode: value.mode === 'independent' ? 'independent' : 'bound' }
  } catch { return null }
}
function ScopeTerminal({ sessionId, invokeTerminal, active, compact, contextLabel, conversationTitle, onShowConversation, recoverSession }) {
  const recoveryAt = React.useRef(0)
  const bridge = React.useMemo(() => {
    const methods = Object.fromEntries(METHODS.map(method => [method,
      (request = {}) => invokeTerminal(sessionId, method, request),
    ]))
    if(recoverSession) methods.list = async () => {
      try { return await invokeTerminal(sessionId, 'list', {}) }
      catch(error) {
        if(Date.now() < recoveryAt.current) throw error
        recoveryAt.current = Date.now() + 5000
        await recoverSession(sessionId)
        return invokeTerminal(sessionId, 'list', {})
      }
    }
    return methods
  }, [sessionId, invokeTerminal, recoverSession])
  return React.createElement('div', { style: { display: active ? 'block' : 'none', height: '100%' } },
    React.createElement(TerminalBoundary, null, React.createElement(TerminalWorkspace, { bridge, sessionId, active, compact, contextLabel, conversationTitle, onShowConversation })))
}
function DockSeat({ container, onUnavailable }) {
  const seat = React.useRef(null)
  React.useLayoutEffect(() => {
    const node = seat.current
    node.appendChild(container)
    let timer
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      if(node.clientWidth < 100) timer=setTimeout(() => { if(node.clientWidth < 100)onUnavailable() }, 400)
    })
    observer.observe(node)
    return () => { clearTimeout(timer); observer.disconnect(); if (container.parentNode === node) node.removeChild(container) }
  }, [container])
  return React.createElement('div', { ref:seat, style:{height:'100%',width:'100%',minWidth:0,overflow:'hidden'} })
}
function TerminalOverlay(props) {
  const state = props.useStore(value => value)
  const sessions = props.useSessions(value => value)
  const current = sessions.current
  const [saved] = React.useState(readSidePreference)
  const [mode, setMode] = React.useState(saved?.mode ?? 'bound')
  const [independent, setIndependent] = React.useState(null)
  const [source, setSource] = React.useState(saved?.sourceSessionId ?? null)
  const [visited, setVisited] = React.useState([])
  const [expanded, setExpanded] = React.useState(false)
  const [container] = React.useState(() => { const node=document.createElement('div'); node.style.height='100%'; return node })
  const floatingSeat = React.useRef(null)
  const [dockFailed,setDockFailed] = React.useState(false)
  React.useEffect(() => { const retry=()=>setDockFailed(false); window.addEventListener('resize',retry); return()=>window.removeEventListener('resize',retry) }, [])
  const docked = !dockFailed && !expanded && props.canDock() && Boolean(current && sessions.byId[current]?.blank === false)
  React.useEffect(() => {
    if (!state.opened || !docked) return
    try { return props.mountDock(container, () => setDockFailed(true)) } catch { setDockFailed(true) }
  }, [state.opened, docked, container])
  React.useEffect(() => {
    if (state.opened && docked) { try { props.openDetails() } catch { setDockFailed(true) } }
  }, [state.opened, docked, current])
  React.useLayoutEffect(() => {
    if (docked || !floatingSeat.current) return
    const node=floatingSeat.current; node.appendChild(container)
    return () => { if(container.parentNode===node)node.removeChild(container) }
  }, [docked, container])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const requestRef = React.useRef(false)
  const alive = React.useRef(true)
  React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const lastBound = React.useRef(null)
  if (state.opened) lastBound.current = props.isAvailable(current) ? current : null
  const boundId = lastBound.current
  const activeId = state.sessionId ? (mode === 'bound' ? boundId : independent) : null
  const sourcesRef = React.useRef([])
  sourcesRef.current = [...new Set([source,boundId].filter(id=>props.isAvailable(id)))]
  const recoverSession = React.useCallback(async sessionId => {
    for (const sourceId of sourcesRef.current) {
      try {
        const result = await props.invokeTerminal(sourceId, 'independent', {sessionId})
        if(result.sessionId === sessionId) return
      } catch {}
    }
    throw new Error('请在原工作区重新连接独立终端')
  }, [props.invokeTerminal])
  const connectIndependent = async () => {
    if (requestRef.current) return
    const sourceId = props.isAvailable(source) ? source : boundId
    if (!sourceId || !props.isAvailable(sourceId)) {
      setError('请先选择原工作区的对话，再打开独立终端。'); return
    }
    requestRef.current = true; setBusy(true); setError('')
    try {
      const result = await props.invokeTerminal(sourceId, 'independent', saved?.sessionId ? {sessionId:saved.sessionId} : {})
      if (!alive.current) return
      setIndependent(result.sessionId); setSource(sourceId)
      try { localStorage.setItem('dsh-superterminal:side:v1', JSON.stringify({sourceSessionId:sourceId, sessionId:result.sessionId, mode:'independent'})) } catch {}
    } catch { if (alive.current) setError('独立终端暂时无法连接，请稍后重试。') }
    finally { requestRef.current=false; if(alive.current)setBusy(false) }
  }
  React.useEffect(() => {
    if (state.opened && mode === 'independent' && !independent) void connectIndependent()
  }, [state.opened, mode])
  React.useEffect(() => {
    if(activeId) setVisited(previous => previous.includes(activeId) ? previous : [...previous, activeId].slice(-8))
  }, [activeId])
  const chooseMode = value => {
    setError(''); setMode(value)
    try {
      const previous=readSidePreference()
      if(previous)localStorage.setItem('dsh-superterminal:side:v1',JSON.stringify({...previous,mode:value}))
    } catch {}
  }
  const title = mode === 'independent' ? '独立工作台' : (sessions.byId[boundId]?.displayTitle || '当前对话')
  const ids = [...new Set([...visited, ...(activeId ? [activeId] : [])])]
  const panel = React.createElement('section', { role: 'region', 'aria-label': 'Side Terminal',
    style: { display: state.opened ? 'flex' : 'none', height:'100%', width:'100%',
      pointerEvents:'auto', flexDirection:'column', overflow:'hidden', background:'#0d1015',color:'#d9e1ea' } },
    React.createElement('header', {style:{display:'grid',gridTemplateColumns:'1fr auto auto',alignItems:'center',gap:8,padding:'12px 16px',borderBottom:'1px solid #ffffff0a',fontSize:12}},
      React.createElement('strong',{style:{color:'#b6e1d0',marginRight:'auto'}},'Side Terminal'),
      React.createElement('select', {'aria-label':'终端关联方式',value:mode,onChange:event=>chooseMode(event.target.value),disabled:busy,
        style:{background:'#172028',color:'#c7d8d0',border:'1px solid #34463e',padding:'6px 8px',borderRadius:6}},
        React.createElement('option',{value:'bound'},'绑定当前对话'),React.createElement('option',{value:'independent'},'独立工作台')),
      React.createElement('button',{onClick:()=>setExpanded(value=>!value),style:{background:'transparent',border:0,color:'#c5d0d8',cursor:'pointer',gridColumn:'2 / 4',gridRow:2,justifySelf:'end'}},expanded?'回到侧边':'展开工作台'),
      React.createElement('button',{onClick:()=>{props.actions.hide();props.openDetails()},title:'返回原有的命令输出和工具详情',style:{background:'transparent',border:0,color:'#91a39b',cursor:'pointer',gridColumn:1,gridRow:2,justifySelf:'start'}},'工具详情'),
      React.createElement('button',{'aria-label':'收起 Side Terminal',title:'收起后任务继续运行',onClick:()=>{props.actions.hide();props.closeDetails()},style:{background:'transparent',border:0,color:'#c5d0d8',cursor:'pointer',fontSize:18,gridColumn:3,gridRow:1}},'×')),
    React.createElement('div',{style:{padding:'8px 16px',fontSize:10,color:'#82978e',borderBottom:'1px solid #ffffff08',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'},title},
      (mode==='bound'?'关联对话 · ':'不随对话切换 · ')+title),
    error && React.createElement('div',{role:'alert',style:{padding:12,color:'#e5c18c',fontSize:12}},error,
      React.createElement('button',{onClick:connectIndependent,disabled:busy},'重新连接')),
    !activeId && React.createElement('div',{style:{padding:28,color:'#8e9eaa',fontSize:12}},busy?'正在准备独立工作台…':'选择一个对话后，即可在旁边开始工作。'),
    React.createElement('div',{style:{flex:1,minHeight:0}},ids.map(id=>React.createElement(ScopeTerminal,{key:id,sessionId:id,invokeTerminal:props.invokeTerminal,active:state.opened && id===activeId,compact:!expanded,contextLabel:id===independent?'独立工作台':'关联对话',
      conversationTitle:sessions.byId[id]?.displayTitle || (id===independent?'独立工作台':'关联对话'),
      onShowConversation:props.isAvailable(id) ? () => {
        try { props.openConversation(id); props.actions.hide() } catch { setError('原对话暂时无法打开，协作结果已保留。') }
      } : undefined,
      recoverSession:id===independent?recoverSession:undefined}))))
  return React.createElement(React.Fragment, null,
    React.createElement('div', {ref:floatingSeat,style:{display:state.opened && !docked?'block':'none',position:'fixed',top:8,right:8,bottom:8,
      width:expanded?'calc(100vw - 16px)':'min(720px, calc(100vw - 24px))',zIndex:100,pointerEvents:'auto',borderRadius:12,overflow:'hidden',border:'1px solid #34423c',boxShadow:'-16px 0 48px #0005'}}),
    createPortal(panel, container))
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
  let detailsAvailable=false
  ctx.slots.inject('details', () => { detailsAvailable=true; return () => { detailsAvailable=false } })
  const canDock = () => detailsAvailable && Boolean(ctx.get('layout')?.openDetails)
  const openDetails = () => ctx.get('layout')?.openDetails()
  const closeDetails = () => ctx.get('layout')?.closeDetails()
  const mountDock = (container, onUnavailable) => {
    const dispose = ctx.slots.register({ name:'details', priority:-1 }, () => React.createElement(DockSeat, {container, onUnavailable}))
    try { openDetails(); return dispose } catch(error) { dispose(); throw error }
  }
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
      return { invokeTerminal, isAvailable, canDock, mountDock, openDetails, closeDetails, openConversation: id => ctx.sessions.open(id) }
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
