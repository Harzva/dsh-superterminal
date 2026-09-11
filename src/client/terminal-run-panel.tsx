import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { AgentIcon } from './agent-icon';
import css from './terminal-run-panel.css';

export interface NativeRunTarget { id: string; title?: string; launcher: string; number?: number }
export type NativeRunStatus = 'idle' | 'running' | 'stopping' | 'failed' | 'completed';
export interface NativeRunMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  title?: string;
  status?: 'queued' | 'pending' | 'running' | 'completed' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
}
export interface NativeRunState {
  status: NativeRunStatus;
  groupId?: string;
  messages: NativeRunMessage[];
  canStop?: boolean;
  model?: string;
  permission?: string;
  error?: string;
}
export interface NativeRunExcerpt { terminalId: string; text: string }
export interface NativeRunPanelProps {
  target?: NativeRunTarget;
  state: NativeRunState;
  draft: string;
  onDraftChange(text: string): void;
  /** The parent owns admission, request identity, and clearing an acknowledged draft. */
  onSend(text: string): void | Promise<void>;
  /** Stop only the native run represented by state; never close its terminal. */
  onStop(): void | Promise<void>;
  busy?: boolean;
  connected?: boolean;
  showRecoveryNotice?: boolean;
  pendingSend?: boolean;
  onRetrySend?(): void | Promise<void>;
  sharedExcerpt?: NativeRunExcerpt;
  onClearExcerpt?(): void;
  onOpenTerminal?(terminalId: string): void;
}

const runLabels: Record<NativeRunStatus, string> = {
  idle: '准备就绪', running: '执行中', stopping: '正在停止', failed: '执行遇到问题', completed: '本轮已结束',
};
const stepLabels = {
  queued: '等待执行', pending: '等待执行', running: '执行中', completed: '已完成', succeeded: '已完成',
  failed: '失败', cancelled: '已停止', interrupted: '已中断',
};
const seedPrompts = ['检查当前项目', '修复选中的报错', '运行测试并分析失败'];
const markdownCodeLabels = {copyLabel: '复制代码', copiedLabel: '已复制'};

function RunMessage({message}: {message: NativeRunMessage}) {
  if (message.role === 'tool') return <details className={`dt-native-step is-${message.status ?? 'unknown'}`}>
    <summary><span className="dt-native-step-icon" aria-hidden="true">{message.status === 'failed' ? '!' : '›_'}</span>
      <span className="dt-native-step-title">{message.title || '工具执行'}</span>
      {message.status && <span className="dt-native-step-status">{stepLabels[message.status]}</span>}
      <span className="dt-native-step-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="dt-native-step-detail"><pre>{message.text || '此步骤没有文本输出。'}</pre></div>
  </details>;
  return <article className={`dt-native-message is-${message.role}`}>
    <div className="dt-native-message-label"><span>{message.role === 'user' ? '你' : 'DSH'}</span>{message.title && <strong>{message.title}</strong>}</div>
    <div className={`dt-native-message-text${message.role === 'assistant' ? ' dt-native-message-markdown' : ''}`}>
      {message.role === 'assistant' && message.text ? <MarkdownText text={message.text} streaming={message.status === 'running'} codeLabels={markdownCodeLabels}/>
        : message.text || (message.role === 'assistant' ? '等待返回内容…' : '')}
    </div>
  </article>;
}

/** A controlled surface for the parent's real DSH run; mounting never starts work. */
export function NativeRunPanel({target, state, draft, onDraftChange, onSend, onStop, busy = false, connected = true, showRecoveryNotice = true,
  pendingSend = false, onRetrySend,
  sharedExcerpt, onClearExcerpt, onOpenTerminal}: NativeRunPanelProps) {
  const [action, setAction] = useState<'send' | 'retry' | 'stop' | null>(null);
  const [actionError, setActionError] = useState('');
  const [stopUnconfirmed, setStopUnconfirmed] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const pinned = useRef(true);
  const admission = useRef(false);
  const generation = useRef(0);
  const running = state.status === 'running';
  const stopping = state.status === 'stopping';
  const excerptMatches = !sharedExcerpt || sharedExcerpt.terminalId === target?.id;
  const canSend = Boolean(target && connected && !state.groupId && excerptMatches && draft.trim() && !pendingSend && !busy && !action && !stopping);
  const retryStop = stopping && Boolean(state.error || stopUnconfirmed);
  const showStop = !state.groupId && (running || stopping || Boolean(state.canStop));
  const canStop = Boolean((running || retryStop || state.canStop) && (!stopping || retryStop) && connected && !busy && !action);
  const stopLabel = action === 'stop' || (stopping && !retryStop) ? '正在停止'
    : retryStop || state.status === 'failed' ? '重试停止' : running ? '停止' : '停止会话';
  const canRetrySend = Boolean(target && !state.groupId && pendingSend && onRetrySend && connected && !busy && !action);
  const title = target?.title || (target ? `${target.launcher}${target.number ? ` · 终端 ${String(target.number).padStart(2, '0')}` : ''}` : '选择一个终端');
  const lastMessage = state.messages[state.messages.length - 1];

  useEffect(() => {
    generation.current += 1; admission.current = false; setAction(null); setActionError(''); setStopUnconfirmed(false); pinned.current = true; setUnseen(false);
    return () => { generation.current += 1; };
  }, [target?.id]);
  useEffect(() => { if (!running && !stopping) setStopUnconfirmed(false); }, [running, stopping]);
  useLayoutEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.max(70, Math.min(150, input.scrollHeight))}px`;
  }, [draft]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (pinned.current) scroll.scrollTop = scroll.scrollHeight;
    else if (state.messages.length) setUnseen(true);
  }, [state.messages, lastMessage?.id, lastMessage?.text, lastMessage?.status, state.status]);

  const send = async () => {
    if (!canSend || admission.current) return;
    admission.current = true; setAction('send'); setActionError('');
    const current = generation.current;
    try { await onSend(draft.trim()); }
    catch { if (current === generation.current) setActionError('发送尚未确认，草稿已保留。请查看当前任务状态后重试。'); }
    finally { if (current === generation.current) { admission.current = false; setAction(null); } }
  };
  const stop = async () => {
    if (!canStop || admission.current) return;
    admission.current = true; setAction('stop'); setActionError(''); setStopUnconfirmed(false);
    const current = generation.current;
    try { await onStop(); }
    catch { if (current === generation.current) { setStopUnconfirmed(true); setActionError('停止尚未确认，请查看任务状态后重试。'); } }
    finally { if (current === generation.current) { admission.current = false; setAction(null); } }
  };
  const retrySend = async () => {
    if (!canRetrySend || !onRetrySend || admission.current) return;
    admission.current = true; setAction('retry'); setActionError('');
    const current = generation.current;
    try { await onRetrySend(); }
    catch { if (current === generation.current) setActionError('上次发送仍未确认。原请求和当前草稿均已保留，可稍后再次核对。'); }
    finally { if (current === generation.current) { admission.current = false; setAction(null); } }
  };
  const latest = () => {
    const scroll = scrollRef.current;
    if (scroll) scroll.scrollTo({top: scroll.scrollHeight, behavior: 'auto'});
    pinned.current = true; setUnseen(false);
  };

  return <section className={`dt-native-run is-${state.status}`} aria-label="AI 任务">
    <style>{css}</style>
    <header className="dt-native-run-header">
      <div className="dt-native-run-brand"><span className="dt-native-run-mark" aria-hidden="true">✦</span><span>DSH AI</span>
        <span className={`dt-native-run-status${connected ? '' : ' is-disconnected'}`} role="status"><i/>{connected ? state.groupId ? '正在讨论组发言' : runLabels[state.status] : '连接中断'}</span>
      </div>
      <button className="dt-native-run-target" disabled={!target || !onOpenTerminal} onClick={() => { if (target) onOpenTerminal?.(target.id); }} title={target ? `打开 ${title}` : '请先选择目标终端'}>
        <AgentIcon launcher={target?.launcher || 'shell'}/><span><small>当前任务终端</small><strong>{title}</strong></span>{target && onOpenTerminal && <span className="dt-native-target-arrow" aria-hidden="true">↗</span>}
      </button>
      <div className="dt-native-run-context"><span title={state.model || '模型尚未提供'}><i>模型</i>{state.model || '待确认'}</span><span title={state.permission || '工作区权限尚未提供'}><i>权限</i>{state.permission || '待确认'}</span></div>
    </header>
    <div className="dt-native-run-scroll" ref={scrollRef} role="log" aria-label="任务与执行步骤" aria-live="polite" aria-relevant="additions text"
      onScroll={event => { const node = event.currentTarget; pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64; if (pinned.current) setUnseen(false); }}>
      {!state.messages.length && <div className="dt-native-run-empty"><span aria-hidden="true">›_</span><h3>说说你想完成什么</h3><p>把目标告诉 DSH，执行步骤和结果会留在这里。</p>
        <div className="dt-native-run-prompts">{seedPrompts.map(prompt => <button key={prompt} disabled={!target || busy || stopping || Boolean(action)} onClick={() => { onDraftChange(prompt); composerRef.current?.focus(); }}><span>{prompt}</span><span aria-hidden="true">↗</span></button>)}</div>
      </div>}
      <div className="dt-native-run-timeline">{state.messages.map(message => <RunMessage key={message.id} message={message}/>)}</div>
      {running && <div className="dt-native-run-active" role="status"><i aria-hidden="true"/><span>任务执行中{lastMessage?.role === 'tool' && lastMessage.status === 'running' && lastMessage.title ? ` · ${lastMessage.title}` : ''}</span></div>}
      {stopping && <p className="dt-native-run-stopping" role="status">{retryStop ? '停止尚未确认，可以再次尝试。' : '正在等待当前执行停止。'}</p>}
    </div>
    {unseen && <button className="dt-native-run-latest" onClick={latest}>查看最新进展 <span aria-hidden="true">↓</span></button>}
    <footer className="dt-native-run-footer">
      {state.groupId && <p className="dt-native-run-feedback" role="status">正在参加讨论组。可先写下下一项任务，发言结束后再发送；停止请前往讨论组。</p>}
      {!connected && showRecoveryNotice && <p className="dt-native-run-feedback" role="status">连接恢复后可继续，当前记录与草稿仍保留。</p>}
      {pendingSend && !busy && <div className="dt-native-run-pending">
        <span role="status">上次发送待确认</span>
        {onRetrySend && <button type="button" disabled={!canRetrySend} onClick={() => { void retrySend(); }}>{action === 'retry' ? '正在核对…' : '核对上次发送'}</button>}
      </div>}
      {(state.error || actionError) && <p className="dt-native-run-feedback is-error" role="alert">{state.error || actionError}</p>}
      {sharedExcerpt && <div className={`dt-native-run-attachment${excerptMatches ? '' : ' is-mismatch'}`}>
        <div><span>{excerptMatches ? `已附上选中内容 · ${sharedExcerpt.text.length.toLocaleString()} 字符` : '选中内容来自其他终端，请重新选择'}</span>
          {onClearExcerpt && <button type="button" aria-label="移除附上的终端内容" onClick={onClearExcerpt}>×</button>}</div>
        <details><summary>查看附上的内容</summary><pre>{sharedExcerpt.text}</pre></details>
      </div>}
      <form className="dt-native-run-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <textarea ref={composerRef} rows={3} maxLength={8000} aria-label={running ? '追加任务要求' : '输入任务目标'} value={draft}
          placeholder={!target ? '先选择一个终端' : running ? '补充要求，DSH 会在后续步骤中处理…' : '说说你想完成什么…'}
          disabled={!target} onChange={event => { onDraftChange(event.target.value); if (actionError) setActionError(''); }}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault(); void send();
          }}/>
        <div className="dt-native-run-composer-actions"><span>{running ? '追加到当前任务' : 'Enter 发送 · Shift+Enter 换行'}</span>
          <div>{showStop && <button className="dt-native-run-stop" type="button" disabled={!canStop} aria-label="停止 AI 会话" onClick={() => { void stop(); }}><span aria-hidden="true">■</span>{stopLabel}</button>}
            <button className="dt-native-run-send" type="submit" disabled={!canSend} aria-label={running ? '发送追加要求' : '发送任务'}><span>{action === 'send' ? '发送中' : running ? '追加要求' : '发送'}</span><span aria-hidden="true">↑</span></button></div>
        </div>
      </form>
    </footer>
  </section>;
}
