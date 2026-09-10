import React, { useEffect, useRef, useState } from 'react';
import { AgentIcon } from './agent-icon';
import type { TerminalBridge, AgentRecord, ReadinessPoint } from './types';
import css from './agent-library.css';

const time = (value: number | null | undefined) => value ? new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '尚未检查';
const unknown: ReadinessPoint = { state:'unknown', label:'未知', detail:'尚无可确认的信息。', checkedAt:null };
function Evidence({label, value = unknown}: {label:string;value?:ReadinessPoint}) {
  return <div className="dt-health-row" title={value.detail}><span>{label}</span><strong className={`dt-health-${value.state}`}>{value.label}</strong><time dateTime={value.checkedAt ? new Date(value.checkedAt).toISOString() : undefined} title={value.checkedAt ? new Date(value.checkedAt).toLocaleString() : '没有检查记录'}>{time(value.checkedAt)}</time></div>;
}

export function AgentManager({bridge, onLaunch, onClose, destination}: {destination?:number; bridge:TerminalBridge;onLaunch:(id:string)=>void;onClose:()=>void}) {
  const [agents,setAgents] = useState<AgentRecord[]>([]), [error,setError] = useState(''), [busy,setBusy] = useState(false), [query,setQuery] = useState('');
  const [round,setRound] = useState(0), [checkedAt,setCheckedAt] = useState<string>();
  const [checking,setChecking] = useState<string[]>([]), [notices,setNotices] = useState<Record<string,string>>({});
  const [filter,setFilter] = useState<'installed'|'all'>('installed');
  const epoch = useRef(0);
  useEffect(()=>{const generation=++epoch.current;setAgents([]);setNotices({});setChecking([]);return()=>{if(epoch.current===generation)epoch.current++}},[bridge]);
  useEffect(()=>{let active=true;setBusy(true);setError('');void bridge.inventory().then(result=>{if(active){setAgents(previous=>result.agents.map(agent=>{const old=previous.find(item=>item.id===agent.id);return agent.health && old?.health && (old.health.authentication.checkedAt ?? 0) > (agent.health.authentication.checkedAt ?? 0) ? {...agent,health:{...agent.health,authentication:old.health.authentication}} : agent}));setCheckedAt(result.checkedAt)}}).catch(()=>{if(active)setError('检测暂不可用，请检查终端服务连接。')}).finally(()=>{if(active)setBusy(false)});return()=>{active=false}},[bridge,round]);
  async function check(agent: AgentRecord) {
    if (checking.includes(agent.id)) return;
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
  const visible=agents.filter(a=>(filter==='all'||a.available)&&(a.label+' '+a.id).toLowerCase().includes(query.toLowerCase()));
  return <section className="dt-manager" aria-label="智能体管理"><style>{css}</style>
    <nav className="dt-manager-nav"><div className="dt-library-mark">◈</div><span className="dt-eyebrow">我的工具箱</span><h2>智能体</h2><p>为下一步，选好搭档。</p>
      <button aria-pressed={filter==='installed'} onClick={()=>setFilter('installed')}>已安装 <span>{installed}</span></button>
      <button aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>全部智能体 <span>{agents.length}</span></button>
      <div className="dt-manager-note"><span className="dt-status-dot"/> 当前工作区<br/><p>每项状态都有自己的检查时间。<br/>未知表示尚无可靠结果。</p></div>
      <button className="dt-back" onClick={onClose}>← 返回终端</button>
    </nav>
    <div className="dt-manager-content"><header><div><span className="dt-eyebrow">智能体目录</span><h2>找到可以一起工作的搭档。</h2><p>{destination ? `将在终端 ${String(destination).padStart(2,'0')} 中开始工作。` : '查看版本、登录与最近连接状态。'}</p></div><button className="dt-icon-action" onClick={onClose} aria-label="关闭智能体管理">×</button></header>
      <div className="dt-library-toolbar"><div className="dt-search"><span>⌕</span><input aria-label="搜索智能体" placeholder="搜索智能体或命令" value={query} onChange={e=>setQuery(e.target.value)}/></div><button onClick={()=>setRound(v=>v+1)} disabled={busy||checking.length>0}>{busy?'检测中…':'↻ 重新检测'}</button></div>
      <div className="dt-library-count" role="status">{error || `${visible.length} 个启动入口`}<span>{checkedAt ? `安装检测 ${time(Date.parse(checkedAt))}` : '正在检测安装'}</span></div>
      <div className="dt-agent-grid">{visible.map(a=><article key={a.id} className={a.available?'':'is-unavailable'}>
        <div className="dt-agent-card-top"><div className="dt-agent-logo"><AgentIcon launcher={a.id}/></div><div><h3>{a.label}</h3><span className="dt-version">{a.version ? 'v'+a.version : '版本未识别'}</span></div><span className={'dt-install-badge'+(a.available?'':' is-missing')}>{a.available?'已安装':'未安装'}</span></div>
        <div className="dt-card-config"><span>使用配置</span><strong>{a.configuration.includes('独立')?'当前工作区':'本机默认'}</strong></div>
        <div className="dt-agent-health" aria-label={`${a.label} 可用状态`}><Evidence label="安装" value={a.health?.installation}/><Evidence label="登录" value={a.health?.authentication}/><Evidence label="模型连接" value={a.health?.connection}/><Evidence label="套餐与额度" value={a.health?.quota}/></div>
        <details><summary>查看状态依据 <span>＋</span></summary><dl><dt>命令</dt><dd>{a.executable||a.id}</dd><dt>配置</dt><dd>{a.configuration}</dd><dt>登录</dt><dd>{a.health?.authentication.detail || a.account}</dd><dt>连接</dt><dd>{a.health?.connection.detail || a.readiness}</dd><dt>套餐与额度</dt><dd>{a.health?.quota.detail || a.subscription}</dd></dl></details>
        {a.health?.canCheckLogin && <button className="dt-check-login" disabled={checking.includes(a.id)||busy} onClick={()=>{void check(a)}}>{checking.includes(a.id)?'正在核对…':'检查此工作区登录'}</button>}
        {notices[a.id] && <p className="dt-login-notice" role="status">{notices[a.id]}</p>}
        <button className="dt-launch-agent" disabled={!a.available} onClick={()=>onLaunch(a.id)}><span>{a.available?'打开终端':'尚未安装'}</span><span>↗</span></button>
      </article>)}</div>
      {!busy&&!visible.length&&<div className="dt-search-empty"><h3>没有找到匹配的智能体</h3><p>试试其他名称，或切换到全部智能体。</p><button onClick={()=>{setQuery('');setFilter('all')}}>查看全部</button></div>}
    </div>
  </section>;
}
