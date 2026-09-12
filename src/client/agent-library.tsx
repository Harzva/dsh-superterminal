import React, { useEffect, useRef, useState } from 'react';
import { AgentIcon } from './agent-icon';
import { UiIcon } from './ui-icon';
import { filterAgents } from './agent-library-query.mjs';
import type { TerminalBridge, AgentRecord, ReadinessPoint } from './types';
import css from './agent-library.css';
import polishCss from './agent-library-polish.css';

const time = (value: number | null | undefined) => value ? new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '尚未检查';
const unknown: ReadinessPoint = { state:'unknown', label:'未知', detail:'尚无可确认的信息。', checkedAt:null };
function Evidence({label, value = unknown}: {label:string;value?:ReadinessPoint}) {
  return <div className="dt-health-row" title={value.detail}><span>{label}</span><strong className={`dt-health-${value.state}`}>{value.label}</strong><time dateTime={value.checkedAt ? new Date(value.checkedAt).toISOString() : undefined} title={value.checkedAt ? new Date(value.checkedAt).toLocaleString() : '没有检查记录'}>{time(value.checkedAt)}</time></div>;
}

export function AgentManager({bridge, onLaunch, onClose, destination, launchDisabledReason}: {destination?:number; launchDisabledReason?:string; bridge:TerminalBridge;onLaunch:(id:string)=>void;onClose:()=>void}) {
  const [agents,setAgents] = useState<AgentRecord[]>([]), [error,setError] = useState(''), [busy,setBusy] = useState(true), [query,setQuery] = useState('');
  const [loaded,setLoaded] = useState(false);
  const [round,setRound] = useState(0), [checkedAt,setCheckedAt] = useState<string>();
  const [checking,setChecking] = useState<string[]>([]), [notices,setNotices] = useState<Record<string,string>>({});
  const [filter,setFilter] = useState<'installed'|'all'>('installed');
  const panelRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { searchRef.current?.focus({preventScroll:true}); }, []);
  const epoch = useRef(0);
  useEffect(()=>{const generation=++epoch.current;setAgents([]);setLoaded(false);setCheckedAt(undefined);setNotices({});setChecking([]);return()=>{if(epoch.current===generation)epoch.current++}},[bridge]);
  useEffect(()=>{
    let active=true;
    setBusy(true);setError('');
    void bridge.inventory().then(result=>{
      if (!active) return;
      setAgents(previous=>result.agents.map(agent=>{
        const old=previous.find(item=>item.id===agent.id);
        return agent.health && old?.health && (old.health.authentication.checkedAt ?? 0) > (agent.health.authentication.checkedAt ?? 0)
          ? {...agent,health:{...agent.health,authentication:old.health.authentication}} : agent;
      }));
      setCheckedAt(result.checkedAt);setLoaded(true);
    }).catch(()=>{if(active)setError('暂时无法检测智能体，请重新检测或检查终端服务连接。')})
      .finally(()=>{if(active)setBusy(false)});
    return()=>{active=false};
  },[bridge,round]);
  async function check(agent: AgentRecord) {
    if (busy || error || checking.includes(agent.id)) return;
    searchRef.current?.focus({preventScroll:true});
    const generation = epoch.current;
    setChecking(list=>[...list,agent.id]);setNotices(prev=>({...prev,[agent.id]:''}));
    try {
      const result = await bridge.agentCheck({launcher:agent.id});
      if (epoch.current!==generation) return;
      if (result.authentication) setAgents(list=>list.map(item=>item.id===agent.id&&item.health ? {...item,health:{...item.health,authentication:result.authentication!}} : item));
      setNotices(prev=>({...prev,[agent.id]:result.authentication?.detail || '暂无独立登录检查方式；模型连接以实际任务结果为准。'}));
    } catch { if(epoch.current===generation)setNotices(prev=>({...prev,[agent.id]:'暂时无法检查登录，请稍后重试。'})); }
    finally {if(epoch.current===generation)setChecking(list=>list.filter(id=>id!==agent.id))}
  }
  const installed=agents.filter(a=>a.available).length;
  const visible=filterAgents(agents,query,filter);
  const blocked=error ? '检测失败，重新检测成功后可启动。' : busy ? '正在检测智能体，请稍候。' : !loaded ? '尚未确认安装状态。' : launchDisabledReason;
  const launchNoticeId=React.useId();
  const retry=()=>{if(busy||checking.length)return;searchRef.current?.focus({preventScroll:true});setRound(value=>value+1)};
  return <section ref={panelRef} tabIndex={-1} className="dt-manager dt-library-polished" role="dialog" aria-label="智能体管理" onClick={event => {
    const target=event.target;
    if (target instanceof Element && !target.closest('button,input,textarea,select,summary,a[href],[contenteditable]:not([contenteditable="false"])')) {
      panelRef.current?.focus({preventScroll:true});
    }
  }} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();onClose();return;}
    if (event.key !== 'Tab') return;
    const controls=Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') ?? []).filter(node=>node.getClientRects().length>0);
    const first=controls[0],last=controls.at(-1);
    if (event.shiftKey && (document.activeElement===first || document.activeElement===panelRef.current) && last) {event.preventDefault();last.focus();}
    else if (!event.shiftKey && (document.activeElement===last || document.activeElement===panelRef.current) && first) {event.preventDefault();first.focus();}
  }}><style>{css}{polishCss}</style>
    <div className="dt-manager-content"><header><div><h2>智能体</h2><p>{destination ? `本机 · 将在终端 ${String(destination).padStart(2,'0')} 中打开` : '本机 · 版本与可用状态'}</p></div><button type="button" className="dt-icon-action" onClick={onClose} aria-label="关闭智能体管理" title="返回终端"><UiIcon name="close" size={18}/></button></header>
      <div className="dt-library-toolbar">
        <div className="dt-library-filters" role="group" aria-label="筛选智能体">
          <button type="button" aria-pressed={filter==='installed'} onClick={()=>setFilter('installed')}>已安装 <span>{loaded?installed:'—'}</span></button>
          <button type="button" aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>全部智能体 <span>{loaded?agents.length:'—'}</span></button>
        </div>
        <div className="dt-library-searchrow"><div className="dt-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg><input ref={searchRef} aria-label="搜索智能体" placeholder="搜索名称或命令" value={query} onChange={e=>setQuery(e.target.value)}/></div><button type="button" className="dt-library-refresh" onClick={retry} disabled={busy||checking.length>0}>{busy?'检测中…':'重新检测'}</button></div>
      </div>
      <div className="dt-library-count" role="status"><span>{busy ? (loaded?'正在重新检测…':'正在检测本机智能体…') : error ? (loaded?'显示上次检测结果':'检测未完成') : `${visible.length} 个启动入口`}</span>{checkedAt && <time dateTime={checkedAt} title={new Date(checkedAt).toLocaleString()}>上次成功检测 {new Date(checkedAt).toLocaleString([], {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</time>}</div>
      {error ? <div className="dt-library-notice is-error" id={launchNoticeId} role="alert"><p>{error}{loaded?' 已保留上次结果，暂不能启动。':''}</p><button type="button" onClick={retry} disabled={checking.length>0}>重试</button></div> : !busy && launchDisabledReason ? <p className="dt-library-notice" id={launchNoticeId} role="status">{launchDisabledReason}</p> : null}
      {!loaded&&busy&&<div className="dt-library-loading"><UiIcon name="terminal" size={24}/><p>正在查找可用的本机 CLI…</p></div>}
      <div className="dt-agent-grid">{visible.map(a=><article key={a.id} className={a.available?'':'is-unavailable'}>
        <div className="dt-agent-card-top"><div className="dt-agent-logo"><AgentIcon launcher={a.id}/></div><div><h3>{a.label}</h3><span className="dt-version">{a.version ? 'v'+a.version : '版本未识别'}</span></div></div>
        <div className="dt-card-config"><span>配置</span><strong>{a.configuration.includes('独立')?'当前工作区':'本机默认'}</strong></div>
        <div className="dt-agent-health" aria-label={`${a.label} 可用状态`}><Evidence label="安装" value={a.health?.installation}/><Evidence label="登录" value={a.health?.authentication}/><Evidence label="模型连接" value={a.health?.connection}/><Evidence label="套餐与额度" value={a.health?.quota}/></div>
        <details><summary>状态依据 <UiIcon name="chevronDown" size={14}/></summary><dl><dt>命令</dt><dd>{a.executable||a.id}</dd><dt>配置</dt><dd>{a.configuration}</dd><dt>登录</dt><dd>{a.health?.authentication.detail || a.account}</dd><dt>连接</dt><dd>{a.health?.connection.detail || a.readiness}</dd><dt>套餐与额度</dt><dd>{a.health?.quota.detail || a.subscription}</dd></dl></details>
        {notices[a.id] && <p className="dt-login-notice" role="status">{notices[a.id]}</p>}
        <div className="dt-agent-actions">{a.health?.canCheckLogin && <button type="button" className="dt-check-login" disabled={checking.includes(a.id)||busy||Boolean(error)} title="检查此工作区登录" onClick={()=>{void check(a)}}>{checking.includes(a.id)?'正在核对…':'检查登录'}</button>}
          <button type="button" className="dt-launch-agent" disabled={!a.available||Boolean(blocked)} title={blocked || (!a.available?'未检测到安装':`在本机打开 ${a.label}`)} aria-describedby={error || (!busy && launchDisabledReason) ? launchNoticeId : undefined} onClick={()=>{if(a.available&&!blocked)onLaunch(a.id)}}><span>{a.available?'在本机打开':'尚未安装'}</span><UiIcon name="arrowUpRight" size={15}/></button>
        </div>
      </article>)}</div>
      {loaded&&!busy&&!error&&!visible.length&&<div className="dt-search-empty"><h3>{query.trim()?'没有匹配的智能体':filter==='installed'?'未检测到已安装的智能体':'暂时没有智能体记录'}</h3><p>{query.trim()?'试试其他名称或命令。':filter==='installed'?'可切换到全部，查看支持的启动入口。':'可以重新检测本机 CLI。'}</p>{(query.trim()||filter==='installed')&&<button type="button" onClick={()=>{setQuery('');setFilter('all')}}>查看全部</button>}</div>}
    </div>
  </section>;
}
