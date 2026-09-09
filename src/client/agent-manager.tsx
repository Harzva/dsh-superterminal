import React, { useEffect, useState } from 'react';
import { AgentIcon } from './agent-icon';
import type { TerminalBridge, AgentRecord } from './types';
export function AgentManager({bridge, onLaunch, onClose}: {bridge: TerminalBridge; onLaunch:(id:string)=>void; onClose:()=>void}) {
  const [agents,setAgents]=useState<AgentRecord[]>([]), [error,setError]=useState(''), [busy,setBusy]=useState(false), [query,setQuery]=useState('');
  const [round,setRound]=useState(0);
  useEffect(()=>{let active=true; setBusy(true); setError(''); void bridge.inventory().then(result=>{if(active)setAgents(result.agents)}).catch(()=>{if(active)setError('检测暂不可用，请检查终端服务连接')}).finally(()=>{if(active)setBusy(false)}); return()=>{active=false}},[bridge,round]);
  const [filter,setFilter]=useState<'installed'|'all'>('installed');
  const installed=agents.filter(a=>a.available).length;
  const visible=agents.filter(a=>(filter==='all'||a.available)&&(a.label+' '+a.id).toLowerCase().includes(query.toLowerCase()));
  return <section className="dt-manager" aria-label="智能体管理">
    <nav className="dt-manager-nav"><div className="dt-library-mark">◈</div><span className="dt-eyebrow">YOUR TOOLKIT</span><h2>智能体</h2><p>你的工具，各就其位。</p>
      <button aria-pressed={filter==='installed'} onClick={()=>setFilter('installed')}>已安装 <span>{installed}</span></button>
      <button aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>全部智能体 <span>{agents.length}</span></button>
      <div className="dt-manager-note"><span className="dt-status-dot"/> 本地检测<br/><p>配置与当前工作区关联。<br/>账号信息以原生 CLI 为准。</p></div>
      <button className="dt-back" onClick={onClose}>← 返回工作台</button>
    </nav>
    <div className="dt-manager-content"><header><div><span className="dt-eyebrow">AGENT LIBRARY</span><h2>{filter==='installed'?'为下一项任务，选好搭档。':'探索你的智能体工具箱。'}</h2><p>查看安装与配置，在独立终端中开始工作。</p></div><button className="dt-icon-action" onClick={onClose} aria-label="关闭智能体管理">×</button></header>
    <div className="dt-library-toolbar"><div className="dt-search"><span>⌕</span><input aria-label="搜索智能体" placeholder="搜索智能体或命令" value={query} onChange={e=>setQuery(e.target.value)}/><kbd>搜索</kbd></div><button onClick={()=>setRound(v=>v+1)} disabled={busy}>{busy?'检测中…':'↻ 重新检测'}</button></div>
    <div className="dt-library-count" role="status">{error || `${visible.length} 个启动入口`}<span>版本来自本机安装</span></div>
    <div className="dt-agent-grid">{visible.map(a=><article key={a.id} className={a.available?'':'is-unavailable'}><div className="dt-agent-card-top"><div className="dt-agent-logo"><AgentIcon launcher={a.id}/></div><div><h3>{a.label}</h3><span className="dt-version">{a.version ? 'v'+a.version : '版本未识别'}</span></div><span className={'dt-install-badge'+(a.available?'':' is-missing')}>{a.available?'已安装':'未检测到'}</span></div>
      <div className="dt-card-config"><span>配置空间</span><strong>{a.configuration.includes('独立')?'当前工作区':'本机默认'}</strong></div>
      <div className="dt-account-line"><span>账号与订阅</span><span>{a.id==='shell'?'无需账号':'待验证'} <i>○</i></span></div>
      <details><summary>安装与连接详情 <span>＋</span></summary><dl><dt>命令</dt><dd>{a.executable||a.id}</dd><dt>配置</dt><dd>{a.configuration}</dd><dt>账号</dt><dd>{a.account}</dd><dt>订阅</dt><dd>{a.subscription}</dd><dt>连接</dt><dd>{a.readiness}</dd></dl></details>
      <button className="dt-launch-agent" disabled={!a.available} onClick={()=>onLaunch(a.id)}><span>{a.available?'打开终端':'尚未安装'}</span><span>↗</span></button></article>)}</div>
    {!busy&&!visible.length&&<div className="dt-search-empty"><h3>没有找到匹配的智能体</h3><p>试试其他名称，或切换到全部智能体。</p><button onClick={()=>{setQuery('');setFilter('all')}}>查看全部</button></div>}
    </div>
  </section>
}
export function SmartAssistant({bridge, onClose}: {bridge:TerminalBridge; onClose:()=>void}) {
  const [prompt,setPrompt]=useState(''),[text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=React.useRef(0); useEffect(()=>()=>{generation.current++},[]);
  const submit=async()=>{const id=++generation.current;setBusy(true);setError('');setText('');try{const result=await bridge.suggest({prompt});if(id===generation.current)setText(result.text)}catch{if(id===generation.current)setError('本次建议未完成，请检查模型连接后重试。不会自动执行或重复请求。')}finally{if(id===generation.current)setBusy(false)}};
  return <section className="dt-smart" aria-label="智能建议"><header className="dt-smart-header"><span className="dt-ai-orb">✦</span><div><h3>终端助手</h3><span>由 DSH 驱动</span></div><button aria-label="关闭智能建议" onClick={onClose}>×</button></header><div className="dt-smart-intro"><span className="dt-eyebrow">A LITTLE HELP, RIGHT HERE</span><h2>从想法，到下一步。</h2><p>描述你想完成的事，或粘贴一段报错。<br/>一起找到清晰、可核对的命令。</p></div>{!text&&!busy&&<div className="dt-prompt-chips">{['查看端口占用','解释一段报错','检查 Git 工作区'].map(label=><button key={label} onClick={()=>setPrompt(label==='查看端口占用'?'如何只读查看 3000 端口的占用？':label==='检查 Git 工作区'?'如何只读查看 Git 工作区的变更状态？':'请解释以下报错：')}>{label}<span>↗</span></button>)}</div>}<form onSubmit={e=>{e.preventDefault();void submit()}}><textarea aria-label="终端任务" placeholder="例如：怎样找出占用 3000 端口的进程？" maxLength={4000} value={prompt} onChange={e=>setPrompt(e.target.value)}/><button disabled={busy||!prompt.trim()}>{busy?'正在思考…':'生成建议 ↑'}</button></form><div className="dt-ai-disclosure">仅发送本次输入与进程状态 · 命令由你确认</div>{error&&<p role="alert">{error}</p>}{text&&<div className="dt-smart-result">{text.split(/(```[\s\S]*?```)/g).map((part,index)=>part.startsWith('```') ? <div className="dt-command-block" key={index}><div><span>命令草稿 · 未执行</span><button onClick={()=>{void navigator.clipboard.writeText(part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '').trim()).catch(()=>setError('请手动选择命令复制'))}}>复制命令</button></div><pre>{part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '').trim()}</pre></div> : <p className="dt-advice-prose" key={index}>{part.split(/(\*\*[^*]+\*\*)/g).map((segment,i)=>segment.startsWith('**')?<strong key={i}>{segment.slice(2,-2)}</strong>:segment)}</p>)}<button onClick={()=>{void navigator.clipboard.writeText(text).catch(()=>setError('无法复制，请选择文本手动复制'))}}>复制建议</button><small>命令尚未执行。检查后在目标终端中使用。</small></div>}</section>
}
