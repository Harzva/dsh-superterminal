import React, { useEffect, useState } from 'react';
import { AgentIcon } from './agent-icon';
import type { TerminalBridge, AgentRecord } from './types';
export function AgentManager({bridge, onLaunch, onClose, destination}: {destination?:number; bridge: TerminalBridge; onLaunch:(id:string)=>void; onClose:()=>void}) {
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
      <div className="dt-manager-note"><span className="dt-status-dot"/> 本地检测<br/><p>不同工作区可使用不同配置。<br/>登录与套餐请在智能体中查看。</p></div>
      <button className="dt-back" onClick={onClose}>← 返回工作台</button>
    </nav>
    <div className="dt-manager-content"><header><div><span className="dt-eyebrow">AGENT LIBRARY</span><h2>{filter==='installed'?'为下一项任务，选好搭档。':'探索你的智能体工具箱。'}</h2><p>{destination ? `将在终端 ${String(destination).padStart(2,'0')} 中开始工作。` : '查看安装与配置，选择任务的搭档。'}</p></div><button className="dt-icon-action" onClick={onClose} aria-label="关闭智能体管理">×</button></header>
    <div className="dt-library-toolbar"><div className="dt-search"><span>⌕</span><input aria-label="搜索智能体" placeholder="搜索智能体或命令" value={query} onChange={e=>setQuery(e.target.value)}/><kbd>搜索</kbd></div><button onClick={()=>setRound(v=>v+1)} disabled={busy}>{busy?'检测中…':'↻ 重新检测'}</button></div>
    <div className="dt-library-count" role="status">{error || `${visible.length} 个启动入口`}<span>已安装版本</span></div>
    <div className="dt-agent-grid">{visible.map(a=><article key={a.id} className={a.available?'':'is-unavailable'}><div className="dt-agent-card-top"><div className="dt-agent-logo"><AgentIcon launcher={a.id}/></div><div><h3>{a.label}</h3><span className="dt-version">{a.version ? 'v'+a.version : '版本未识别'}</span></div><span className={'dt-install-badge'+(a.available?'':' is-missing')}>{a.available?'已安装':'未安装'}</span></div>
      <div className="dt-card-config"><span>使用配置</span><strong>{a.configuration.includes('独立')?'当前工作区':'本机默认'}</strong></div>
      <div className="dt-account-line"><span>账号与订阅</span><span>{a.id==='shell'?'无需账号':'待验证'} <i>○</i></span></div>
      <details><summary>安装与连接详情 <span>＋</span></summary><dl><dt>命令</dt><dd>{a.executable||a.id}</dd><dt>配置</dt><dd>{a.configuration}</dd><dt>账号</dt><dd>{a.account}</dd><dt>订阅</dt><dd>{a.subscription}</dd><dt>连接</dt><dd>{a.readiness}</dd></dl></details>
      <button className="dt-launch-agent" disabled={!a.available} onClick={()=>onLaunch(a.id)}><span>{a.available?'打开终端':'尚未安装'}</span><span>↗</span></button></article>)}</div>
    {!busy&&!visible.length&&<div className="dt-search-empty"><h3>没有找到匹配的智能体</h3><p>试试其他名称，或切换到全部智能体。</p><button onClick={()=>{setQuery('');setFilter('all')}}>查看全部</button></div>}
    </div>
  </section>
}
export interface AssistantTarget { id: string; launcher: string; title?: string; number?: number }
interface AssistantProps {
  bridge: TerminalBridge;
  onClose: () => void;
  target?: AssistantTarget;
  excerpt?: { terminalId: string; text: string };
  onDraft?: (targetId: string, text: string) => void;
  onClearExcerpt?: () => void;
}
const agentNames: Record<string, string> = {
  shell: 'Shell', codex: 'Codex', claude: 'Claude Code', kimi: 'Kimi Code', kimicode: 'Kimi Code',
  pi: 'Pi Agent', piagent: 'Pi Agent', gemini: 'Gemini CLI', opencode: 'OpenCode',
  qoder: 'Qoder', qodercli: 'Qoder CLI', hermes: 'Hermes', deepseek: 'DeepSeek CLI',
  aider: 'Aider', goose: 'Goose', qwen: 'Qwen Code', amp: 'Amp', copilot: 'GitHub Copilot',
  omp: 'OMP', agy: 'Antigravity', atomcode: 'AtomCode', mimocode: 'MiMoCode', likecode: 'LikeCode', zcode: 'ZCode',
};
const targetName = (target: AssistantTarget) => target.title || `终端 ${String(target.number ?? 1).padStart(2,'0')} · ${agentNames[target.launcher] || target.launcher}`;

export function SmartAssistant({ bridge, onClose, target, excerpt, onDraft, onClearExcerpt }: AssistantProps) {
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<{ text: string; target: AssistantTarget; bridge: TerminalBridge }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attachExcerpt, setAttachExcerpt] = useState<string>();
  const [copied, setCopied] = useState<Record<string, 'copied' | 'failed'>>({});
  const [drafted, setDrafted] = useState<number>();
  const generation = React.useRef(0);
  const currentTarget = React.useRef(target?.id);
  const currentBridge = React.useRef(bridge);
  currentTarget.current = target?.id;
  currentBridge.current = bridge;
  const selectedOutput = target && excerpt?.terminalId === target.id ? excerpt.text.slice(0, 4000) : '';
  const excerptKey = selectedOutput ? JSON.stringify([target!.id, selectedOutput]) : '';
  const includeOutput = Boolean(excerptKey && attachExcerpt === excerptKey);

  useEffect(() => {
    generation.current++;
    setResult(undefined);
    setPrompt('');
    setBusy(false);
    setError('');
    setCopied({});
    setDrafted(undefined);
    setAttachExcerpt(undefined);
    return () => { generation.current++; };
  }, [target?.id, bridge]);
  useEffect(() => { setAttachExcerpt(undefined); }, [excerpt, target?.id]);

  const submit = async () => {
    if (!target || !prompt.trim() || busy) return;
    const requestTarget = { ...target };
    const id = ++generation.current;
    setBusy(true);
    setError('');
    setResult(undefined);
    setCopied({});
    setDrafted(undefined);
    const stillCurrent = () => id === generation.current && currentTarget.current === requestTarget.id && currentBridge.current === bridge;
    try {
      const answer = await bridge.suggest({
        prompt: prompt.trim(), terminalId: requestTarget.id,
        ...(includeOutput ? { excerpt: selectedOutput } : {}),
      });
      if (answer.terminalId && answer.terminalId !== requestTarget.id) throw new Error('目标终端已改变');
      if (stillCurrent()) setResult({ text: answer.text, target: requestTarget, bridge });
    } catch {
      if (stillCurrent()) setError('暂时无法生成建议，请检查 DSH 的模型设置后重试。');
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  };
  const copy = async (key: string, value: string) => {
    const id = generation.current;
    try {
      await navigator.clipboard.writeText(value);
      if (id === generation.current) setCopied(state => ({ ...state, [key]: 'copied' }));
    } catch {
      if (id === generation.current) setCopied(state => ({ ...state, [key]: 'failed' }));
    }
  };
  const copyLabel = (key: string, fallback: string) => copied[key] === 'copied' ? '已复制' : copied[key] === 'failed' ? '复制失败，请手动复制' : fallback;
  const visibleResult = result?.target.id === target?.id && result?.bridge === bridge ? result : undefined;

  return <section className="dt-smart" aria-label="智能建议">
    <header className="dt-smart-header"><span className="dt-ai-orb">✦</span><div><h3>终端助手</h3><span>由 DSH 驱动</span></div><button aria-label="关闭智能建议" onClick={onClose}>×</button></header>
    {target ? <div className="dt-assistant-target"><AgentIcon launcher={target.launcher}/><div><span>正在帮助</span><strong>{targetName(target)}</strong>{target.title && <small>{agentNames[target.launcher] || target.launcher} · 终端 {String(target.number ?? 1).padStart(2,'0')}</small>}</div></div> : <div className="dt-assistant-empty" role="status"><strong>先选择一个终端</strong><p>点击要处理的终端，助手会围绕它提供建议。</p></div>}
    <div className="dt-smart-intro"><span className="dt-eyebrow">A LITTLE HELP, RIGHT HERE</span><h2>一起，找到下一步。</h2><p>描述任务，或选取一段终端输出。<br/>生成的命令可以先放进草稿，检查后再使用。</p></div>
    {!visibleResult && !busy && <div className="dt-prompt-chips">{['查看端口占用', '解释一段报错', '检查 Git 工作区'].map(label => <button key={label} disabled={!target} onClick={() => setPrompt(label === '查看端口占用' ? '如何只读查看 3000 端口的占用？' : label === '检查 Git 工作区' ? '如何只读查看 Git 工作区的变更状态？' : '请解释这段终端输出，并建议下一步：')}>{label}<span>↗</span></button>)}</div>}
    {selectedOutput && <div className="dt-assistant-excerpt">
      <div><span>选中的终端输出</span>{onClearExcerpt && <button onClick={onClearExcerpt} aria-label="移除选中的输出">×</button>}</div>
      <details><summary>预览 · {selectedOutput.length} 字符{excerpt!.text.length > 4000 ? '（已截取前 4000 字符）' : ''}</summary><pre>{selectedOutput}</pre></details>
      <label><input type="checkbox" checked={includeOutput} onChange={event => setAttachExcerpt(event.target.checked ? excerptKey : undefined)}/>附上这段输出</label>
      <small>{includeOutput ? '这段内容将随你的问题发送给 DSH 模型。' : '尚未附上；勾选后才会发送。'}</small>
    </div>}
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea aria-label="终端任务" placeholder={target ? '例如：怎样找出占用 3000 端口的进程？' : '选择终端后，在这里描述任务'} disabled={!target} maxLength={4000} value={prompt} onChange={event => setPrompt(event.target.value)}/>
      <button disabled={!target || busy || !prompt.trim()}>{busy ? '正在思考…' : '生成建议 ↑'}</button>
    </form>
    <div className="dt-ai-disclosure">发送本次问题、目标终端状态及你勾选的输出。不会自动附上其他终端或对话内容。</div>
    {error && <p role="alert">{error}</p>}
    {visibleResult && <div className="dt-smart-result">
      <div className="dt-assistant-result-target">建议用于 <strong>{targetName(visibleResult.target)}</strong></div>
      {visibleResult.text.split(/(```[\s\S]*?```)/g).map((part, index) => {
        if (!part.startsWith('```')) return <p className="dt-advice-prose" key={index}>{part.split(/(\*\*[^*]+\*\*)/g).map((segment, i) => segment.startsWith('**') ? <strong key={i}>{segment.slice(2, -2)}</strong> : segment)}</p>;
        const command = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '').trim();
        return <div className="dt-command-block" key={index}>
          <div><span>命令草稿 · 未执行</span><button onClick={() => { void copy(String(index), command); }}>{copyLabel(String(index), '复制')}</button></div>
          <pre>{command}</pre>
          {onDraft && <div className="dt-command-actions"><span>{drafted === index ? '草稿已就位，等待你检查' : targetName(visibleResult.target)}</span><button disabled={!command} onClick={() => {
            if (currentTarget.current !== visibleResult.target.id) return;
            onDraft(visibleResult.target.id, command);
            setDrafted(index);
          }}>{drafted === index ? '已填入草稿' : '填入草稿'}</button></div>}
        </div>;
      })}
      <button onClick={() => { void copy('all', visibleResult.text); }}>{copyLabel('all', '复制建议')}</button><small>填入草稿不会发送到终端，也不会执行命令。</small>
    </div>}
  </section>;
}
