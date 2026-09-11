import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { AgentIcon } from './agent-icon';
import type { TerminalBridge } from './types';
import type { GroupCandidate, GroupCreateInput, GroupMember, GroupMemberInput, GroupMessage, GroupSendInput, GroupSummary, GroupUpdateInput, TerminalGroup } from './group-types';
import './terminal-group-panel.css';

export const terminalGroupStatus = (group: GroupSummary) => ({idle: '等待讨论', running: '讨论中', completed: '已完成', failed: '部分讨论未完成', cancelled: '已停止', interrupted: '讨论已中断'}[group.status]);
const modeName = (mode: string) => mode === 'cli' ? '独立 CLI 任务' : '终端 DSH AI';
const names: Record<string, string> = {codex: 'Codex', pi: 'Pi Agent', piagent: 'Pi Agent', shell: 'Shell', claude: 'Claude Code', kimi: 'Kimi Code', kimicode: 'Kimi Code'};
const agentName = (launcher: string) => names[launcher] || launcher;
const timeLabel = (value: number) => new Date(value).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});

export function useTerminalGroups(bridge: TerminalBridge, active: boolean) {
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [candidates, setCandidates] = useState<GroupCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectionRequest, setSelectionRequest] = useState(0);
  const [createRequest, setCreateRequest] = useState(0);
  const [records, setRecords] = useState<Record<string, TerminalGroup>>({});
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [reading, setReading] = useState(false);
  const alive = useRef(true), generation = useRef(0);
  const owner = useRef(bridge), selection = useRef(selectedId);
  owner.current = bridge; selection.current = selectedId;
  const adopt = useCallback((group: TerminalGroup) => {
    ++generation.current;
    setRecords(previous => ({...previous, [group.id]: group}));
    setGroups(previous => (group.archived ? previous.filter(item => item.id !== group.id)
      : [group, ...previous.filter(item => item.id !== group.id)]).sort((a,b) => b.updatedAt - a.updatedAt));
    setReading(false);
  }, []);
  const select = useCallback((id?: string) => {
    selection.current = id; setSelectedId(id); setSelectionRequest(value => value + 1);
    if (!id) setCreateRequest(value => value + 1);
  }, []);
  const overview = useCallback(() => {selection.current = undefined; setSelectedId(undefined); setSelectionRequest(value => value + 1);}, []);
  const refresh = useCallback(async () => {
    const request = ++generation.current, current = owner.current, id = selection.current;
    const valid = () => alive.current && current === owner.current && request === generation.current;
    try {
      const result = await current.groupList();
      if (!valid()) return;
      setGroups(result.groups); setCandidates(result.candidates); setLoaded(true);
      if (id && result.groups.some(item => item.id === id)) {
        const group = await current.groupRead({groupId: id});
        if (!valid()) return;
        setRecords(previous => ({...previous, [id]: group}));
      }
      if (valid()) { setError(''); setReading(false); }
    } catch {
      if (valid()) { setError('讨论组暂时无法连接，正在恢复。记录与草稿已保留。'); setLoaded(true); setReading(false); }
    }
  }, []);
  useEffect(() => {
    setGroups([]); setCandidates([]); setRecords({}); setSelectedId(undefined); selection.current = undefined;
    setError(''); setLoaded(false); ++generation.current;
  }, [bridge]);
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped && active) timer = setTimeout(() => { void poll(); }, 2500);
    };
    if (active) { setReading(!!selection.current); void poll(); }
    return () => { stopped = true; alive.current = false; ++generation.current; clearTimeout(timer); };
  }, [active, bridge, selectedId, refresh]);
  return {groups, candidates, selectedId, group: selectedId ? records[selectedId] : undefined, loaded, reading, error, select, overview, selectionRequest, createRequest, refresh, adopt};
}

type GroupState = ReturnType<typeof useTerminalGroups>;
type Terminal = {id: string; launcher: string; title?: string; number?: number};
export type TerminalGroupSeed = {request: number; terminalId: string; groupId?: string};
export type TerminalGroupHandoff = {groupId: string; sourceTerminalId: string; prompt: string; excerpt: string};
export interface TerminalGroupPanelProps {
  bridge: TerminalBridge;
  state: GroupState;
  opened: boolean;
  terminals: Terminal[];
  onClose(): void;
  onShowTerminal(id: string): void | boolean;
  onHandoff(input: TerminalGroupHandoff): void;
  seed?: TerminalGroupSeed;
  excerpt?: {terminalId: string; text: string};
}
type Draft = {prompt: string; targets?: string[]; rounds: 1 | 2; excerpt?: {terminalId: string; text: string}; author?: string};
type Editor = {groupId?: string; title: string; members: GroupMemberInput[]};
type Pending = {kind: 'create'; input: GroupCreateInput} | {kind: 'update'; input: GroupUpdateInput}
  | {kind: 'send'; input: GroupSendInput} | {kind: 'stop' | 'archive'; input: {groupId: string}};
const blankDraft = (): Draft => ({prompt: '', rounds: 1});
const terminalTitle = (terminal: Terminal | undefined, candidate?: GroupCandidate) => terminal?.title || agentName(terminal?.launcher || candidate?.launcher || 'shell');
const memberInput = (candidate: GroupCandidate, terminal?: Terminal): GroupMemberInput | undefined => {
  const mode = candidate.modes.find(item => item.mode === 'dsh-ai' && item.available) || candidate.modes.find(item => item.available);
  return mode ? {terminalId: candidate.terminalId, mode: mode.mode, title: terminalTitle(terminal, candidate)} : undefined;
};

function GroupGlyph() {
  return <svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><rect x="2.5" y="5.5" width="23" height="17" rx="5"/><path d="m8 11 3 3-3 3m7 0h4"/><rect x="14.5" y="17.5" width="23" height="17" rx="5"/><path d="m20 23 3 3-3 3m7 0h4"/></svg>;
}

function GroupReply({message, member, terminalIds, onShowTerminal}: {message: GroupMessage; member?: GroupMember; terminalIds: string[]; onShowTerminal(id: string): void}) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const isReply = message.kind === 'reply' || message.kind === 'conclusion';
  const attributed = isReply || message.kind === 'error' && !!message.memberId;
  const sourceId = message.terminalId || member?.terminalId;
  const mode = message.mode || member?.mode || 'dsh-ai';
  const launcher = message.launcher || member?.launcher || 'shell';
  return <article className={`dt-group-message is-${message.kind}`}>
    <header>
      <span className="dt-group-message-identity">{attributed && <AgentIcon launcher={mode === 'dsh-ai' ? 'deepseek' : launcher}/>}
        <strong>{message.kind === 'user' ? '你' : message.kind === 'error' ? `${message.memberTitle || member?.title || '参会成员'} · 未完成` : message.memberTitle || member?.title || '参会成员'}</strong>
        {message.kind === 'conclusion' && <b>结论</b>}
      </span>
      <time dateTime={new Date(message.createdAt).toISOString()}>{timeLabel(message.createdAt)}</time>
    </header>
    {attributed && <div className="dt-group-message-meta"><span>{modeName(mode)}</span>
      {message.model && <span>{message.model}</span>}{message.round && <span>第 {message.round} 轮</span>}
      {sourceId && (terminalIds.includes(sourceId) ? <button type="button" onClick={() => onShowTerminal(sourceId)}>来源终端 ↗</button> : <span>来源终端已关闭</span>)}
    </div>}
    <div className={`dt-group-message-text${isReply ? ' dt-group-markdown' : ''}`}>
      {isReply ? <MarkdownText text={message.text} streaming={false}/> : message.text}
    </div>
    {message.sharedExcerpt && <details className="dt-group-shared-record"><summary>本次共享的终端选段</summary><pre>{message.sharedExcerpt.text}</pre></details>}
    {isReply && <div className="dt-group-message-actions"><button type="button" onClick={() => {
      void (async () => {try {await navigator.clipboard.writeText(message.text);setCopied('copied');} catch {setCopied('failed');}})();
    }}>{copied === 'copied' ? '已复制' : '复制发言'}</button>{copied === 'failed' && <span role="status">复制未成功，可选中文字手动复制。</span>}</div>}
  </article>;
}

export function TerminalGroupPanel(props: TerminalGroupPanelProps) {
  const {state} = props, group = state.group;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editor, setEditor] = useState<Editor>();
  const [pending, setPending] = useState<Pending>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [archiveConfirmation, setArchiveConfirmation] = useState<string>();
  const seenSeed = useRef<number>();
  const navigation = useRef({request: 0, create: 0});
  const alive = useRef(true), flight = useRef(false);
  const current = useRef(props); current.current = props;
  const scroll = useRef<HTMLDivElement>(null), nearEnd = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const draft = drafts[group?.id || ''] || blankDraft();
  const running = group?.status === 'running';
  const blocked = busy || !!pending || !!state.error;
  const targets = (draft.targets ?? group?.members.map(item => item.id) ?? []).filter(id => group?.members.some(item => item.id === id));
  const author = draft.author && group?.members.some(item => item.id === draft.author) ? draft.author : group?.members[0]?.id || '';
  const latestConclusion = group?.messages.slice().reverse().find(message => message.kind === 'conclusion');
  const hasReplies = group?.messages.some(message => message.kind === 'reply');
  const activeMember = group?.members.find(member => member.id === group.operation?.activeMemberId);
  const sourceForHandoff = props.terminals.find(terminal => terminal.id === latestConclusion?.terminalId)
    || props.terminals.find(terminal => terminal.id === group?.members.find(member => member.id === latestConclusion?.memberId)?.terminalId)
    || props.terminals.find(terminal => group?.members.some(member => member.terminalId === terminal.id));
  const changeDraft = (patch: Partial<Draft>) => {
    if (!group || pending?.kind === 'send' && pending.input.groupId === group.id) return;
    setDrafts(previous => ({...previous, [group.id]: {...(previous[group.id] || blankDraft()), ...patch}}));
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setDrafts({}); setEditor(undefined); setPending(undefined); setBusy(false); setNotice('');
    setArchiveConfirmation(undefined); seenSeed.current = undefined; flight.current = false;
  }, [props.bridge]);
  useEffect(() => {
    if (pending || state.selectionRequest === navigation.current.request) return;
    const create = state.createRequest !== navigation.current.create;
    navigation.current = {request: state.selectionRequest, create: state.createRequest};
    setEditor(create && !state.selectedId ? {title:'',members:[]} : undefined);
    setArchiveConfirmation(undefined);
  }, [state.selectionRequest, state.createRequest, state.selectedId, pending]);
  useEffect(() => {
    const seed = props.seed;
    if (!props.opened || !seed || seed.request === seenSeed.current || pending || !state.loaded || state.error) return;
    if (seed.groupId && state.selectedId !== seed.groupId) { state.select(seed.groupId); return; }
    if (seed.groupId && group?.id !== seed.groupId) return;
    const candidate = state.candidates.find(item => item.terminalId === seed.terminalId);
    if (!candidate) { seenSeed.current = seed.request; setNotice('该终端当前无法加入讨论组，请检查终端是否仍在运行。'); return; }
    const member = memberInput(candidate, props.terminals.find(item => item.id === seed.terminalId));
    if (!member) { seenSeed.current = seed.request; setNotice('这个终端暂时没有可用的参会方式。'); return; }
    const base = seed.groupId && group ? {groupId: group.id, title: group.title, members: group.members.map(({terminalId,mode,title}) => ({terminalId,mode,title}))}
      : editor && !editor.groupId ? editor : {title: '', members: []};
    if (seed.groupId && group?.status === 'running') { seenSeed.current = seed.request; setNotice('请等本轮讨论结束后添加成员。'); return; }
    seenSeed.current = seed.request;
    if (!base.members.some(item => item.terminalId === member.terminalId) && base.members.length >= 6) { setNotice('每组最多 6 个终端，可先移除一位成员。'); return; }
    setEditor({...base, members: base.members.some(item => item.terminalId === member.terminalId) ? base.members : [...base.members, member]});
    setNotice('已选中这个终端。确认参会方式后保存。');
  }, [props.seed, props.opened, state.selectedId, state.loaded, state.error, state.candidates, group, pending]);
  useEffect(() => {
    if (pending?.kind !== 'send' || group?.id !== pending.input.groupId) return;
    if (group.operation?.requestId !== pending.input.requestId && !group.messages.some(message => message.requestId === pending.input.requestId)) return;
    const id = pending.input.groupId;
    setPending(undefined); setNotice('已核对到这次讨论，记录会继续更新。');
    if (pending.input.kind === 'discussion') setDrafts(previous => ({...previous, [id]: {...(previous[id] || blankDraft()), prompt: '', excerpt: undefined}}));
  }, [group, pending]);
  useEffect(() => { nearEnd.current = true; setUnseen(false); }, [state.selectedId]);
  useEffect(() => {
    if (!props.opened || !scroll.current) return;
    if (nearEnd.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    else setUnseen(true);
  }, [group?.id, group?.messages.length, props.opened]);

  const perform = async (request: Pending) => {
    if (flight.current || state.error) return;
    const owner = props.bridge;
    flight.current = true; setBusy(true); setPending(request); setNotice('');
    try {
      const result = request.kind === 'create' ? await owner.groupCreate(request.input)
        : request.kind === 'update' ? await owner.groupUpdate(request.input)
        : request.kind === 'send' ? await owner.groupSend(request.input)
        : request.kind === 'stop' ? await owner.groupStop(request.input) : await owner.groupArchive(request.input);
      if (!alive.current || current.current.bridge !== owner) return;
      current.current.state.adopt(result); setPending(undefined);
      if (request.kind === 'create' || request.kind === 'update') {
        setEditor(undefined); current.current.state.select(result.id); setNotice(request.kind === 'create' ? '讨论组已建立。选择成员，开始讨论。' : '成员设置已保存。');
      } else if (request.kind === 'send') {
        if (request.input.kind === 'discussion') setDrafts(previous => ({...previous, [result.id]: {...(previous[result.id] || blankDraft()), prompt: '', excerpt: undefined}}));
        setNotice('已开始，回复会按成员显示。你可以暂时收起面板。');
      } else if (request.kind === 'archive') { current.current.state.overview(); setArchiveConfirmation(undefined); setNotice('讨论组已归档，终端仍保留在工作区。'); }
      else setNotice('已请求停止本组讨论，已完成的发言会保留。');
    } catch (error) {
      if (alive.current && current.current.bridge === owner) {
        const message = error instanceof Error ? error.message : '';
        const rejection = message.indexOf('[GROUP_REJECTED]');
        if (rejection >= 0) { setPending(undefined); setNotice(message.slice(rejection + '[GROUP_REJECTED]'.length).trim() || '这次操作未开始，请调整后重试。'); }
        else setNotice('操作结果尚未确认。请核对记录；再次确认会使用同一次请求。');
      }
    } finally {
      if (alive.current && current.current.bridge === owner) { flight.current = false; setBusy(false); await current.current.state.refresh(); }
    }
  };
  const saveEditor = () => {
    if (!editor || blocked || !editorValid) return;
    const input = {requestId: crypto.randomUUID(), title: editor.title.trim(), members: editor.members};
    void perform(editor.groupId ? {kind: 'update', input: {...input, groupId: editor.groupId}} : {kind: 'create', input});
  };
  const send = (kind: 'discussion' | 'conclusion') => {
    if (!group || running || blocked || (kind === 'discussion' ? !draft.prompt.trim() || !targets.length : !hasReplies || !author)) return;
    void perform({kind: 'send', input: {groupId: group.id, requestId: crypto.randomUUID(), kind,
      prompt: kind === 'discussion' ? draft.prompt.trim() : '请根据本组已完成的讨论，整理共识、仍有分歧的问题，以及可分派的下一步和验收标准。保留不同意见，不把未验证的内容当作事实。',
      targets: kind === 'discussion' ? targets : [author], rounds: kind === 'discussion' ? draft.rounds : 1,
      ...(kind === 'discussion' && draft.excerpt ? {excerpt: draft.excerpt} : {})}});
  };
  const startNew = () => { state.select(undefined); setEditor({title: '', members: []}); setNotice(''); setArchiveConfirmation(undefined); };
  const displayTitle = (id: string) => terminalTitle(props.terminals.find(item => item.id === id), state.candidates.find(item => item.terminalId === id));
  const editorValid = !!editor?.title.trim() && !!editor.members.length && editor.members.every(member => state.candidates.some(candidate => candidate.terminalId === member.terminalId && candidate.modes.some(mode => mode.mode === member.mode && mode.available)));

  return <section className="dt-group-panel" hidden={!props.opened} aria-label="终端讨论组" onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') props.onClose(); }}>
    <header className="dt-group-header"><div className="dt-group-header-title"><GroupGlyph/><div><span>TERMINAL GROUP</span><h2>一起，把问题聊透。</h2></div></div>
      <button type="button" className="dt-group-close" aria-label="关闭终端讨论组" onClick={props.onClose}>×</button></header>
    <div className="dt-group-navigation"><label><span className="dt-group-sr-only">选择讨论组</span><select aria-label="选择讨论组" value={state.selectedId || ''} onChange={event => { event.target.value ? state.select(event.target.value) : state.overview(); setEditor(undefined); setArchiveConfirmation(undefined); }}>
      <option value="">所有讨论组{state.groups.length ? ` · ${state.groups.length}` : ''}</option>
      {state.groups.map(item => <option key={item.id} value={item.id}>{item.title}{item.status === 'running' ? ' · 讨论中' : ''}</option>)}
    </select></label><button type="button" className="dt-group-add" disabled={blocked} onClick={startNew}>＋ 新建组</button></div>
    {(state.error || notice || pending) && <div className={`dt-group-notice${state.error || pending && !busy ? ' is-warning' : ''}`} role="status">
      <span>{state.error || notice || (busy ? '正在确认操作…' : '上次操作正在等待确认。')}</span>
      {state.error ? <button type="button" disabled={busy} onClick={() => { void state.refresh(); }}>重新连接</button>
        : pending && !busy ? <button type="button" onClick={() => { void perform(pending); }}>核对这次操作</button> : null}
    </div>}
    {editor ? <div className="dt-group-editor-scroll"><form className="dt-group-editor" onSubmit={event => {event.preventDefault();saveEditor();}}>
      <div className="dt-group-section-heading"><h3>{editor.groupId ? '调整参会成员' : '邀请终端，开始讨论'}</h3><span>{editor.members.length} / 6</span></div>
      <label className="dt-group-field">讨论组名称<input autoFocus required maxLength={120} placeholder="例如：产品体验评审" value={editor.title} disabled={blocked} onChange={event => setEditor({...editor, title: event.target.value})}/></label>
      <p className="dt-group-helper">加入组会保留原来的终端与布局。你可以选择终端的 DSH AI，或受支持的独立 CLI 任务。</p>
      <div className="dt-group-candidate-list">{state.candidates.map(candidate => {
        const terminal = props.terminals.find(item => item.id === candidate.terminalId);
        const selected = editor.members.find(item => item.terminalId === candidate.terminalId);
        const unavailable = !candidate.modes.some(mode => mode.available);
        return <div key={candidate.terminalId} className={`dt-group-candidate${selected ? ' is-selected' : ''}`}>
          <label className="dt-group-candidate-heading"><input type="checkbox" checked={!!selected} disabled={blocked || !selected && (editor.members.length >= 6 || unavailable)} onChange={() => {
            const member = memberInput(candidate, terminal);
            setEditor({...editor, members: selected ? editor.members.filter(item => item.terminalId !== candidate.terminalId) : member ? [...editor.members, member] : editor.members});
          }}/><AgentIcon launcher={candidate.launcher}/><span><strong>{terminalTitle(terminal, candidate)}</strong><small>{terminal?.number ? `终端 ${String(terminal.number).padStart(2, '0')} · ` : ''}{agentName(candidate.launcher)}</small></span>{selected && <b aria-hidden="true">✓</b>}</label>
          {selected ? <div className="dt-group-member-options"><label>参会身份<select aria-label={`${terminalTitle(terminal, candidate)}的参会身份`} value={selected.mode} disabled={blocked} onChange={event => setEditor({...editor, members: editor.members.map(member => member.terminalId === selected.terminalId ? {...member, mode: event.target.value as GroupMemberInput['mode']} : member)})}>
            {candidate.modes.map(mode => <option key={mode.mode} value={mode.mode} disabled={!mode.available}>{modeName(mode.mode)}{mode.available ? '' : ' · 暂不可用'}</option>)}
          </select></label><p>{selected.mode === 'cli' ? '以独立 CLI 任务参会，不会续接终端里已经打开的 CLI 对话。' : '使用这个终端的 DSH AI 会话参会；发言会明确标注 DSH AI。'}</p>
          {candidate.modes.find(mode => mode.mode === selected.mode)?.detail && <small>{candidate.modes.find(mode => mode.mode === selected.mode)?.detail}</small>}
          {selected.mode === 'dsh-ai' && candidate.model && <small>模型 · {candidate.model}</small>}</div>
          : unavailable && <small className="dt-group-unavailable">暂时无法参会 · 请检查 DSH 模型设置{['pi','piagent','codex'].includes(candidate.launcher) ? '与 CLI 安装状态' : '；这个 CLI 的独立参会暂未支持'}。</small>}
        </div>;
      })}</div>
      {editor.members.filter(member => !state.candidates.some(candidate => candidate.terminalId === member.terminalId)).map(member => <div className="dt-group-missing" key={member.terminalId}><span>{member.title} · 终端已不可用</span><button type="button" disabled={blocked} onClick={() => setEditor({...editor,members:editor.members.filter(item => item.terminalId !== member.terminalId)})}>移除</button></div>)}
      {!state.candidates.length ? <div className="dt-group-empty-inline"><strong>先打开一个终端</strong><p>在工作区启动 Shell 或 Agent 终端，再回来选择参会成员。</p><button type="button" disabled={busy} onClick={() => {void state.refresh();}}>刷新成员列表</button></div>
        : !state.candidates.some(candidate => candidate.modes.some(mode => mode.available)) && <div className="dt-group-empty-inline"><strong>当前还没有可用的参会方式</strong><p>请检查当前 DSH 会话的模型设置。也可以在智能体列表确认 Pi 或 Codex 已安装，然后启动对应终端。</p><small>CLI 的登录与模型连接情况会通过实际任务确认。</small><button type="button" disabled={busy} onClick={() => {void state.refresh();}}>重新检查</button></div>}
      <div className="dt-group-editor-footer"><p>不会自动分享旧日志。发送前可查看并选择共享内容。</p><div><button type="button" disabled={busy || !!pending} onClick={() => {setEditor(undefined);setNotice('');}}>暂不修改</button><button type="submit" className="dt-group-primary" disabled={blocked || !editorValid}>{busy ? '正在保存…' : editor.groupId ? '保存成员' : '建立讨论组'}</button></div></div>
    </form></div> : group ? <>
      <div className="dt-group-detail-heading"><div><h3>{group.title}</h3><span className={`dt-group-state is-${group.status}`}><i/>{terminalGroupStatus(group)}</span></div><button type="button" disabled={blocked || running} onClick={() => {setEditor({groupId: group.id, title: group.title, members: group.members.map(({terminalId,mode,title}) => ({terminalId,mode,title}))});setNotice('');}}>管理成员</button></div>
      <div className="dt-group-members" aria-label="参会成员">{group.members.map(member => <button type="button" key={member.id} onClick={() => props.onShowTerminal(member.terminalId)} title={`查看 ${member.title} 的来源终端`}>
        <AgentIcon launcher={member.mode === 'dsh-ai' ? 'deepseek' : member.launcher}/><span><strong>{member.title}</strong><small>{modeName(member.mode)}</small></span><span aria-hidden="true">↗</span></button>)}</div>
      <div className="dt-group-timeline" ref={scroll} onScroll={() => { const node = scroll.current; if (!node) return; nearEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight < 60; if (nearEnd.current) setUnseen(false); }}>
        {!group.messages.length ? <div className="dt-group-discussion-empty"><span>不同视角，同一个目标。</span><p>写下想讨论的问题，选择需要发言的成员。每条回复都会注明真实来源。</p><small>一轮收集意见；两轮会让成员参考上一轮回复。</small></div>
          : <div className="dt-group-messages">{group.messages.map(message => <GroupReply key={message.id} message={message} member={group.members.find(member => member.id === message.memberId)} terminalIds={props.terminals.map(terminal => terminal.id)} onShowTerminal={id => {props.onShowTerminal(id);}}/>)}</div>}
        {running && <div className="dt-group-progress" role="status"><i/><span>{group.operation?.kind === 'conclusion' ? '正在整理结论' : `第 ${group.operation?.round || 1} / ${group.operation?.rounds || 1} 轮`}{activeMember ? ` · 等待 ${activeMember.title}` : ' · 等待成员回复'}</span></div>}
        {group.status === 'interrupted' && <p className="dt-group-interrupted">上次讨论已中断，完成的发言仍在这里。你可以重新提出问题，继续讨论。</p>}
        {!!hasReplies && !running && <section className="dt-group-conclusion"><div><span>把讨论变成下一步</span><small>由一位成员整理共识、分歧与行动项。</small></div><label><span className="dt-group-sr-only">结论整理者</span><select aria-label="结论整理者" value={author} disabled={blocked} onChange={event => changeDraft({author: event.target.value})}>{group.members.map(member => <option value={member.id} key={member.id}>{member.title} · {modeName(member.mode)}</option>)}</select></label><button type="button" disabled={blocked || !author} onClick={() => send('conclusion')}>形成结论 ↗</button></section>}
        {latestConclusion && <div className="dt-group-handoff"><button className="dt-group-primary" type="button" disabled={blocked || running || !sourceForHandoff} onClick={() => {
          if (!sourceForHandoff) return;
          const goal = group.messages.find(message => message.kind === 'user')?.text || group.title;
          props.onHandoff({groupId: group.id, sourceTerminalId: sourceForHandoff.id, prompt: `讨论组：${group.title}\n原目标：${goal}\n\n请根据讨论结论完成下一步，并按结论中的验收标准返回可核对的结果。`.slice(0,4000), excerpt: latestConclusion.text.slice(0,8000)});
        }}>将结论交给 Agent 执行 <span aria-hidden="true">↗</span></button><small>{sourceForHandoff ? '下一步选择执行者与验收标准，确认后才会开始。' : '原成员终端已关闭。请先添加可用终端，再安排执行。'}</small></div>}
      </div>
      {unseen && <button className="dt-group-new-replies" type="button" onClick={() => {if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;nearEnd.current=true;setUnseen(false);}}>查看最新发言 ↓</button>}
      <footer className="dt-group-footer">
        <form onSubmit={event => {event.preventDefault();send('discussion');}}>
          <div className="dt-group-target-heading"><span>本次请谁回答</span><button type="button" disabled={blocked} onClick={() => changeDraft({targets: targets.length === group.members.length ? [] : group.members.map(member => member.id)})}>{targets.length === group.members.length ? '取消全选' : '选择全部'}</button></div>
          <div className="dt-group-targets">{group.members.map(member => <button type="button" key={member.id} aria-pressed={targets.includes(member.id)} disabled={blocked} onClick={() => changeDraft({targets: targets.includes(member.id) ? targets.filter(id => id !== member.id) : [...targets,member.id]})}><span aria-hidden="true">{targets.includes(member.id) ? '✓' : '＋'}</span>{member.title}</button>)}</div>
          {(draft.excerpt || props.excerpt?.text) && <div className="dt-group-excerpt">{draft.excerpt ? <><div><span>本次共享 · {displayTitle(draft.excerpt.terminalId)} 的选段</span><button type="button" aria-label="取消共享选段" disabled={blocked} onClick={() => changeDraft({excerpt: undefined})}>×</button></div><details><summary>查看共享内容 · {draft.excerpt.text.length} 字</summary><pre>{draft.excerpt.text}</pre></details></>
            : <button type="button" disabled={blocked} onClick={() => {if (props.excerpt) changeDraft({excerpt: {terminalId: props.excerpt.terminalId, text: props.excerpt.text.slice(0,8000)}});}}>＋ 附上 {displayTitle(props.excerpt!.terminalId)} 的选中内容</button>}</div>}
          <div className="dt-group-composer"><textarea aria-label="讨论问题" placeholder="请大家从各自角度提出意见，最后给出下一步…" rows={3} maxLength={4000} value={draft.prompt} disabled={!!pending} onChange={event => changeDraft({prompt: event.target.value})} onKeyDown={event => {if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {event.preventDefault();send('discussion');}}}/>
            <div className="dt-group-composer-actions"><label><span className="dt-group-sr-only">讨论轮数</span><select aria-label="讨论轮数" value={draft.rounds} disabled={blocked} onChange={event => changeDraft({rounds:Number(event.target.value) as 1|2})}><option value="1">1 轮 · 收集意见</option><option value="2">2 轮 · 相互讨论</option></select></label>{running ? <button type="button" className="dt-group-stop" disabled={blocked} onClick={() => {void perform({kind:'stop',input:{groupId:group.id}});}}>■ 停止讨论</button> : <button type="submit" className="dt-group-primary" disabled={blocked || !draft.prompt.trim() || !targets.length}>发送给 {targets.length} 位 <span aria-hidden="true">↑</span></button>}</div>
          </div>
          <div className="dt-group-composer-note"><span>{draft.excerpt ? '共享：组内讨论与上方选段' : '共享：组内讨论；未附加终端日志'}</span><span>⌘ / Ctrl + Enter</span></div>
        </form>
        <div className="dt-group-archive">{archiveConfirmation === group.id ? <><span>归档后会从列表隐藏，终端保持打开。</span><button type="button" disabled={blocked || running} onClick={() => {void perform({kind:'archive',input:{groupId:group.id}});}}>确认归档</button><button type="button" disabled={blocked} onClick={() => setArchiveConfirmation(undefined)}>取消</button></> : <button type="button" disabled={blocked || running} onClick={() => setArchiveConfirmation(group.id)}>归档讨论组</button>}</div>
      </footer>
    </> : <div className="dt-group-overview">
      {!state.loaded || state.selectedId && state.reading ? <p className="dt-group-loading" role="status">正在读取讨论组…</p> : state.groups.length ? <><div className="dt-group-section-heading"><h3>你的讨论组</h3><span>{state.groups.length} 个</span></div><div className="dt-group-list">{state.groups.map(item => <button type="button" key={item.id} onClick={() => state.select(item.id)}><div><strong>{item.title}</strong><span className={`dt-group-state is-${item.status}`}><i/>{terminalGroupStatus(item)}</span></div><p>{item.members.map(member => member.title).join(' · ')}</p><small>{item.members.length} 位成员 <span>查看讨论 ↗</span></small></button>)}</div></>
        : <div className="dt-group-empty"><GroupGlyph/><h3>让不同终端，坐到一张桌上。</h3><p>邀请成员，分享问题。把不同意见整理成结论，再交给合适的 Agent 执行。</p><button type="button" className="dt-group-primary" disabled={blocked} onClick={startNew}>建立第一个讨论组 <span aria-hidden="true">＋</span></button><small>可以拖入终端，也可以在组里选择成员。</small></div>}
    </div>}
  </section>;
}
