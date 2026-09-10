import React, { useEffect, useState } from 'react';
import { AgentIcon } from './agent-icon';
import type { TerminalBridge, AgentRecord } from './types';
export { AgentManager } from './agent-library';
export type { AssistantTarget } from './assistant-memory';
import { assistantMemory } from './assistant-memory';
import type { AssistantTarget, AssistantSeed } from './assistant-memory';
interface AssistantProps {
  bridge: TerminalBridge; sessionId: string; conversationTitle: string; contextLabel: string;
  onClose: () => void; target?: AssistantTarget; connected?: boolean; seed?: AssistantSeed;
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
const safeAdviceErrors = [
  '模型服务暂时无法完成建议，请稍后重试。', '本次建议已达到模型输出上限，请缩小问题范围后重试。',
  '模型响应超时，请稍后重试或在 DSH 中选择更快的模型。', '建议生成已取消，可以重新生成。',
  '模型未完整返回建议，请重试。', '模型未返回可显示的建议，请缩小问题范围后重试。',
  '建议过长，请缩小问题范围后重试。', 'DSH 的模型登录已失效，请在 DSH 设置中重新连接模型。',
  '模型额度暂不可用，请检查 DSH 中该模型的额度后重试。', '模型请求过于频繁，请稍后重试。',
  '当前模型暂不接受这次建议请求，请缩短问题或检查 DSH 的模型设置。',
  '当前会话正在生成建议，请稍候', '当前 DSH 未配置可用模型', '终端所属 DSH 会话已失效',
];

export function SmartAssistant({ bridge, sessionId, conversationTitle, contextLabel, onClose, target, connected = true, seed, excerpt, onDraft, onClearExcerpt }: AssistantProps) {
  const memory = React.useMemo(() => assistantMemory(sessionId, target?.id ?? '_unselected'), [sessionId, target?.id]);
  const state = React.useSyncExternalStore(memory.subscribe, memory.getSnapshot, memory.getSnapshot);
  const {prompt, result, busy, error, copied, drafted} = state;
  const currentTarget = React.useRef(target?.id); currentTarget.current = target?.id;
  const selectedOutput = state.excerpt;
  const excerptKey = selectedOutput && target ? JSON.stringify([target.id, selectedOutput]) : '';
  const includeOutput = Boolean(selectedOutput && state.share);
  const setPrompt = (value: string) => memory.update({prompt: value});
  const setDrafted = (value: number) => memory.update({drafted: value});
  const setAttachExcerpt = (value?: string) => memory.update({share: Boolean(value)});
  useEffect(() => {
    if (!target || excerpt?.terminalId !== target.id || !excerpt.text) return;
    const text = excerpt.text.slice(0, 4000);
    if (memory.getSnapshot().excerpt !== text) memory.update({excerpt: text, share: false});
  }, [memory, target?.id, excerpt?.terminalId, excerpt?.text]);
  useEffect(() => {
    if (!seed || seed.sessionId !== sessionId || seed.terminalId !== target?.id || memory.getSnapshot().seedId === seed.id) return;
    memory.update({seedId: seed.id, prompt: seed.prompt.slice(0, 4000), excerpt: seed.excerpt.slice(0, 4000), share: true, error: ''});
  }, [memory, seed, sessionId, target?.id]);
  const clearExcerpt = () => { memory.update({excerpt: '', share: false}); onClearExcerpt?.(); };

  const submit = async () => {
    if (!target || !connected || !prompt.trim() || memory.getSnapshot().busy) return;
    const requestTarget = {...target};
    const requestPrompt = prompt.trim();
    const request = memory.getSnapshot().request + 1;
    memory.update({request, busy: true, error: '', copied: {}, drafted: undefined});
    const stillCurrent = () => memory.getSnapshot().request === request;
    try {
      const answer = await bridge.suggest({prompt: requestPrompt, terminalId: requestTarget.id,
        ...(includeOutput ? {excerpt: selectedOutput} : {})});
      if (answer.terminalId && answer.terminalId !== requestTarget.id) throw new Error('目标终端已改变');
      if (stillCurrent()) memory.update({result: {text: answer.text.slice(0, 24000), prompt: requestPrompt, target: requestTarget, createdAt: Date.now()}});
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      const safeError = safeAdviceErrors.find(value => message.endsWith(value));
      if (stillCurrent()) memory.update({error: safeError || '暂时无法生成建议，请检查连接或 DSH 的模型设置后重试。'});
    } finally {
      if (stillCurrent()) memory.update({busy: false});
    }
  };
  const copy = async (key: string, value: string) => {
    const request = memory.getSnapshot().request;
    try {
      await navigator.clipboard.writeText(value);
      if (request === memory.getSnapshot().request) memory.update(value => ({copied: {...value.copied, [key]: 'copied'}}));
    } catch {
      if (request === memory.getSnapshot().request) memory.update(value => ({copied: {...value.copied, [key]: 'failed'}}));
    }
  };
  const copyLabel = (key: string, fallback: string) => copied[key] === 'copied' ? '已复制' : copied[key] === 'failed' ? '复制失败，请手动复制' : fallback;
  const visibleResult = result?.target.id === target?.id ? result : undefined;

  return <section className="dt-smart" aria-label="智能建议">
    <div className="dt-assistant-owner" title={conversationTitle}>{contextLabel} · {conversationTitle}</div>
    <header className="dt-smart-header"><span className="dt-ai-orb">✦</span><div><h3>终端助手</h3><span>由 DSH 驱动</span></div><button aria-label="关闭智能建议" onClick={onClose}>×</button></header>
    {target ? <div className="dt-assistant-target"><AgentIcon launcher={target.launcher}/><div><span>正在帮助</span><strong>{targetName(target)}</strong>{target.title && <small>{agentNames[target.launcher] || target.launcher} · 终端 {String(target.number ?? 1).padStart(2,'0')}</small>}</div></div> : <div className="dt-assistant-empty" role="status"><strong>先选择一个终端</strong><p>点击要处理的终端，助手会围绕它提供建议。</p></div>}
    <div className="dt-smart-intro"><span className="dt-eyebrow">A LITTLE HELP, RIGHT HERE</span><h2>一起，找到下一步。</h2><p>描述任务，或选取一段终端输出。<br/>生成的命令可以先放进草稿，检查后再使用。</p></div>
    {!visibleResult && !busy && <div className="dt-prompt-chips">{['查看端口占用', '解释一段报错', '检查 Git 工作区'].map(label => <button key={label} disabled={!target} onClick={() => setPrompt(label === '查看端口占用' ? '如何只读查看 3000 端口的占用？' : label === '检查 Git 工作区' ? '如何只读查看 Git 工作区的变更状态？' : '请解释这段终端输出，并建议下一步：')}>{label}<span>↗</span></button>)}</div>}
    {selectedOutput && <div className="dt-assistant-excerpt">
      <div><span>选中的终端输出</span>{onClearExcerpt && <button onClick={clearExcerpt} aria-label="移除选中的输出">×</button>}</div>
      <details><summary>预览 · {selectedOutput.length} 字符</summary><pre>{selectedOutput}</pre></details>
      <label><input type="checkbox" checked={includeOutput} onChange={event => setAttachExcerpt(event.target.checked ? excerptKey : undefined)}/>附上这段输出</label>
      <small>{includeOutput ? '这段内容将随你的问题发送给 DSH 模型。' : '尚未附上；勾选后才会发送。'}</small>
    </div>}
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea aria-label="终端任务" placeholder={target ? '例如：怎样找出占用 3000 端口的进程？' : '选择终端后，在这里描述任务'} disabled={!target} maxLength={4000} value={prompt} onChange={event => setPrompt(event.target.value)}/>
      <button disabled={!target || !connected || busy || !prompt.trim()}>{busy ? '正在思考…' : '生成建议 ↑'}</button>
    </form>
    {!connected && <p className="dt-assistant-offline" role="status">终端连接正在恢复，草稿与上次建议已保留。</p>}
    <div className="dt-ai-disclosure">发送本次问题、目标终端状态及你勾选的输出。不会自动附上其他终端或对话内容。</div>
    {error && <p role="alert">{error}</p>}
    {visibleResult && <div className="dt-smart-result">
      <div className="dt-assistant-result-target">建议用于 <strong>{targetName(visibleResult.target)}</strong><p>{visibleResult.prompt}</p><time>{new Date(visibleResult.createdAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · 保留的建议</time></div>
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
