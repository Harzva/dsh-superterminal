import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AgentIcon } from './agent-icon';
import type { HandoffAcceptInput, HandoffInput, HandoffReworkInput, HandoffTarget, HandoffTask, TerminalBridge, TerminalSummary } from './types';

export const handoffStatus = (task: HandoffTask) => task.savePending ? '记录待确认保存' : task.acceptance === 'accepted' ? '已验收'
  : task.acceptance === 'rework' ? '已安排返工' : ({ queued: '准备中', running: '执行中', succeeded: '已返回 · 待验收',
  failed: '执行失败', cancelled: '已取消', interrupted: '运行中断' }[task.status] || '状态待确认');
const working = (task: HandoffTask) => task.status === 'running' || task.status === 'queued';
const names: Record<string, string> = { codex: 'Codex', pi: 'Pi Agent', piagent: 'Pi Agent', shell: 'Shell',
  claude: 'Claude Code', kimi: 'Kimi Code', kimicode: 'Kimi Code' };
const agentName = (id: string) => names[id] || id;

export function useHandoffs(bridge: TerminalBridge, active: boolean) {
  const [tasks, setTasks] = useState<HandoffTask[]>([]);
  const [targets, setTargets] = useState<HandoffTarget[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const currentBridge = useRef(bridge); currentBridge.current = bridge;
  const refresh = useCallback(async () => {
    const round = ++generation.current;
    const owner = currentBridge.current;
    try {
      const result = await owner.handoffList();
      if (!alive.current || round !== generation.current || owner !== currentBridge.current) return;
      setTasks(result.tasks); setTargets(result.targets); setError(''); setLoaded(true);
    } catch {
      if (alive.current && round === generation.current && owner === currentBridge.current) {
        setError('协作记录暂时无法连接，正在重试。'); setLoaded(true);
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped && active) timer = setTimeout(() => { void poll(); }, 3000);
    };
    if (active) void poll();
    return () => { stopped = true; alive.current = false; ++generation.current; clearTimeout(timer); };
  }, [active, bridge, refresh]);
  return { tasks, targets, error, loaded, refresh };
}

type Source = Pick<TerminalSummary, 'id' | 'launcher'> & { title?: string };
export type HandoffSeed = {id: string; sessionId: string; sourceTerminalId: string; prompt: string; excerpt: string};
type Props = {
  bridge: TerminalBridge; sessionId: string; conversationTitle: string; source?: Source;
  excerpt?: {terminalId: string; text: string}; tasks: HandoffTask[]; targets: HandoffTarget[];
  error: string; loaded: boolean; opened: boolean; onClose(): void; refresh(): Promise<void>;
  openAt: { section: 'form' | 'records'; request: number };
  availableTerminalIds: string[]; onShowTerminal(id: string): boolean; onShowConversation?(): void;
  seed?: HandoffSeed;
};
type Draft = { target: string; prompt: string; criteria: string; share: boolean; returnToConversation: boolean };
type PendingSubmission = { input: HandoffInput; source: Source; draft: Draft; conversationTitle: string };
const blankDraft = (): Draft => ({target: '', prompt: '', criteria: '', share: false, returnToConversation: true});

function HandoffReview({task, bridge, targets, expanded, blocked, refresh, reveal}: {
  task: HandoffTask; bridge: TerminalBridge; expanded: boolean; blocked: boolean;
  targets: HandoffTarget[];
  refresh(): Promise<void>; reveal(id: string): void;
}) {
  const [mode, setMode] = useState<'accept' | 'rework'>();
  const [text, setText] = useState('');
  const [target, setTarget] = useState(task.targetLauncher);
  const [pending, setPending] = useState<{kind:'accept'; input:HandoffAcceptInput} | {kind:'rework'; input:HandoffReworkInput}>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const alive = useRef(true), flight = useRef(false);
  const context = useRef({task, bridge, refresh}); context.current = {task, bridge, refresh};
  useEffect(() => { alive.current = true; return () => {alive.current = false;}; }, []);
  useEffect(() => {
    if (!pending) return;
    if (task.reviewRequestId === pending.input.requestId || (pending.kind === 'rework' && task.reworkTaskId)) {
      setPending(undefined); setMode(undefined); setText('');
      setNotice('已核对到这次操作的记录。');
    }
  }, [task.reviewRequestId, task.reworkTaskId, pending]);
  const submit = async () => {
    if (flight.current || blocked || !mode || (mode === 'rework' && (!text.trim() || (!pending && !targets.find(item => item.id === target)?.available)))) return;
    const request = pending ?? (mode === 'accept'
      ? {kind:'accept' as const, input:{taskId:task.id, requestId:crypto.randomUUID(), notes:text.trim() || undefined}}
      : {kind:'rework' as const, input:{taskId:task.id, requestId:crypto.randomUUID(), issues:text.trim(), targetLauncher:target}});
    const owner = bridge;
    setPending(request); setBusy(true); setNotice(''); flight.current = true;
    try {
      const response = request.kind === 'accept' ? await owner.handoffAccept(request.input) : await owner.handoffRework(request.input);
      if (!alive.current || context.current.bridge !== owner) return;
      if ('rejected' in response) { setPending(undefined); setNotice(response.message); return; }
      setPending(undefined); setMode(undefined); setText('');
      setNotice(request.kind === 'accept' ? '验收记录已保存。' : '返工已建立，原目标、完成判据和结果已随任务保留。');
      if (request.kind === 'rework') reveal(response.id);
    } catch {
      if (alive.current && context.current.bridge === owner) setNotice('操作尚未确认。请核对记录；再次确认将使用同一请求。');
    } finally {
      flight.current = false;
      if (alive.current && context.current.bridge === owner) {setBusy(false); await context.current.refresh();}
    }
  };
  if (!expanded) return null;
  if (task.acceptance === 'accepted' || task.acceptance === 'rework') return <section className="dt-handoff-review-record" aria-label="成果验收记录">
    <strong>{task.acceptance === 'accepted' ? '验收记录' : '返工记录'}</strong>
    {task.reviewedAt && <time dateTime={new Date(task.reviewedAt).toISOString()}>{new Date(task.reviewedAt).toLocaleString()}</time>}
    {task.reviewNotes && <p>{task.reviewNotes}</p>}
    {task.reworkTaskId && <button type="button" onClick={() => reveal(task.reworkTaskId!)}>查看后续返工 ↗</button>}
    {task.savePending && <p role="status">记录仍待确认保存。</p>}
  </section>;
  if (working(task)) return null;
  return <section className="dt-handoff-review" aria-label="验收或返工">
    {!mode ? <div className="dt-handoff-review-choices">
      {task.status === 'succeeded' && <button type="button" disabled={blocked || task.savePending} onClick={() => {setMode('accept');setText('');setNotice('');}}>验收成果</button>}
      <button type="button" disabled={blocked || task.savePending} onClick={() => {setMode('rework');setText('');setNotice('');}}>提出问题并返工</button>
    </div> : <form onSubmit={event => {event.preventDefault();void submit();}}>
      <strong>{mode === 'accept' ? '确认成果符合目标与完成判据' : '哪些问题需要修改？'}</strong>
      <p>{mode === 'accept' ? '验收由你确认，Agent 的正常返回不会代替这一步。' : '会创建一项关联任务，附上原目标、完成判据和上次结果摘要；来源终端关闭也可以继续。'}</p>
      <label className="dt-handoff-label">{mode === 'accept' ? '验收备注（选填）' : '需要修改的问题'}
        <textarea aria-label={mode === 'accept' ? '验收备注' : '返工问题'} rows={3} maxLength={mode === 'accept' ? 2000 : 4000}
          required={mode === 'rework'} disabled={!!pending || busy} value={text} onChange={event => setText(event.target.value)}/>
      </label>
      {mode === 'rework' && <label className="dt-handoff-label">交给谁继续<select aria-label="返工执行者" value={target} disabled={!!pending || busy} onChange={event => setTarget(event.target.value)}>
        {targets.filter(item => ['pi','piagent','codex'].includes(item.id)).map(item => <option key={item.id} value={item.id} disabled={!item.available}>
          {item.label}{item.available ? '' : ' · 暂不可用'}</option>)}
      </select></label>}
      <div className="dt-handoff-review-choices"><button type="submit" disabled={busy || blocked || (mode === 'rework' && (!text.trim() || (!pending && !targets.find(item => item.id === target)?.available)))}>
        {busy ? '正在确认…' : pending ? '核对这次提交' : mode === 'accept' ? '确认验收' : '建立返工任务'}</button>
        {!pending && <button type="button" disabled={busy} onClick={() => {setMode(undefined);setText('');}}>暂不处理</button>}</div>
    </form>}
    {notice && <p className="dt-handoff-review-notice" role="status">{notice}</p>}
  </section>;
}

function Route({ source, target }: {source: string; target: string}) {
  return <div className="dt-handoff-route"><span><AgentIcon launcher={source}/>{agentName(source)}</span>
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
    <span><AgentIcon launcher={target}/>{agentName(target)}</span></div>;
}

function HandoffResult({text}: {text: string}) {
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const readerRef = useRef<HTMLDivElement>(null);
  const copyRound = useRef(0);
  const collapsedHeight = 320;
  useEffect(() => {
    ++copyRound.current; setCopyState('idle'); setExpanded(false);
    const reader = readerRef.current;
    if (!reader) return;
    const measure = () => setCanExpand(reader.scrollHeight > collapsedHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(reader);
    return () => { ++copyRound.current; observer.disconnect(); };
  }, [text]);
  const copy = async () => {
    if (copyState === 'copying') return;
    const round = ++copyRound.current;
    setCopyState('copying');
    try {
      await navigator.clipboard.writeText(text);
      if (round === copyRound.current) setCopyState('copied');
    } catch {
      if (round === copyRound.current) { setCopyState('failed'); setExpanded(true); }
    }
  };
  return <section className="dt-handoff-output" aria-label="Agent 返回的结果">
    <div className="dt-handoff-output-heading"><strong>Agent 返回的结果</strong>
      <button type="button" disabled={copyState === 'copying'} onClick={() => { void copy(); }}>
        {copyState === 'copying' ? '正在复制…' : copyState === 'copied' ? '已复制' : copyState === 'failed' ? '重试复制' : '复制结果'}
      </button></div>
    <div className={`dt-handoff-copy-status${copyState === 'failed' ? ' is-error' : ''}`} role="status">
      {copyState === 'copied' ? '已复制完整结果。' : copyState === 'failed' ? '复制未成功。可选择下方结果手动复制，或重试。' : ''}
    </div>
    <div className={`dt-handoff-reader${canExpand && !expanded ? ' is-folded' : ''}`} ref={readerRef}
      style={{maxHeight: expanded ? 'none' : collapsedHeight}} tabIndex={0} aria-label="结果原文">{text}</div>
    {(canExpand || expanded) && <button className="dt-handoff-expand-result" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起结果' : '展开完整结果'} <span aria-hidden="true">{expanded ? '↑' : '↓'}</span></button>}
    <small>请结合完成判据核对结果；执行结束不代表已经验收。</small>
  </section>;
}

export function HandoffPanel(props: Props) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [seedShares, setSeedShares] = useState<Record<string, string>>({});
  const seenSeeds = useRef(new Set<string>());
  const [selection, setSelection] = useState<string>();
  const [pending, setPending] = useState<PendingSubmission>();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [details, setDetails] = useState<string>();
  const [revealTaskId, setRevealTaskId] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const recordsRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef(new Map<string, HTMLElement>());
  const confirmedRef = useRef(new Set<string>());
  const alive = useRef(true);
  const propsRef = useRef(props); propsRef.current = props;
  const inFlight = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (props.opened && !pending) { setSelection(props.source?.id); setNotice(''); }
  }, [props.opened, props.openAt]);
  useEffect(() => {
    const seed = props.seed;
    if (!props.opened || pending || !seed || seed.sessionId !== props.sessionId || seed.sourceTerminalId !== props.source?.id) return;
    const key = `${seed.sessionId}/${seed.id}`;
    if (seenSeeds.current.has(key)) return;
    seenSeeds.current.add(key); setSelection(seed.sourceTerminalId);
    setDrafts(previous => ({...previous, [seed.sourceTerminalId]: {...(previous[seed.sourceTerminalId] ?? blankDraft()), prompt: seed.prompt.slice(0,4000), share: !!seed.excerpt}}));
    setSeedShares(previous => ({...previous, [seed.sourceTerminalId]: seed.excerpt.slice(0,8000)}));
  }, [props.opened, props.seed, props.source?.id, props.sessionId, pending]);
  const scrollTo = useCallback((element?: HTMLElement | null) => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const top = element ? viewport.scrollTop + element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 12 : 0;
    viewport.scrollTo({top: Math.max(0, top), behavior: 'auto'});
  }, []);
  useEffect(() => {
    if (!props.opened) return;
    const frame = requestAnimationFrame(() => scrollTo(props.openAt.section === 'records' ? recordsRef.current : undefined));
    return () => cancelAnimationFrame(frame);
  }, [props.opened, props.openAt, scrollTo]);
  useEffect(() => {
    if (!props.opened || !revealTaskId || !cardsRef.current.has(revealTaskId)) return;
    const frame = requestAnimationFrame(() => {
      const card = cardsRef.current.get(revealTaskId);
      if (!card) return;
      scrollTo(card);
      setRevealTaskId(current => current === revealTaskId ? undefined : current);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.opened, props.tasks, revealTaskId, scrollTo]);
  const revealConfirmedTask = (id: string) => {
    if (confirmedRef.current.has(id)) return;
    confirmedRef.current.add(id);
    setRevealTaskId(id);
  };
  const source = pending?.source ?? (props.source?.id === selection ? props.source : undefined);
  const sourceAvailable = !!source && props.availableTerminalIds.includes(source.id);
  const draft = pending?.draft ?? drafts[selection ?? ''] ?? blankDraft();
  const target = pending?.input.targetLauncher || draft.target || props.targets.find(item => item.available && ['pi','piagent'].includes(item.id))?.id
    || props.targets.find(item => item.available)?.id || '';
  const selectedTarget = props.targets.find(item => item.id === target);
  const shared = pending ? pending.input.excerpt ?? ''
    : props.excerpt && props.excerpt.terminalId === selection ? props.excerpt.text : seedShares[selection ?? ''] ?? '';
  const accepted = pending ? props.tasks.find(task => task.requestId === pending.input.requestId) : undefined;
  const conversationTitle = pending?.conversationTitle ?? props.conversationTitle;
  useEffect(() => {
    if (!accepted) return;
    setPending(undefined); setDetails(accepted.id); setNotice('任务已建立，结果将保留在这次协作中。');
    revealConfirmedTask(accepted.id);
    setDrafts(previous => ({...previous, [accepted.sourceTerminalId]: blankDraft()}));
  }, [accepted?.id]);
  const change = (patch: Partial<Draft>) => {
    if (pending || !selection) return;
    setDrafts(previous => ({...previous, [selection]: {...(previous[selection] ?? blankDraft()), ...patch}}));
  };
  const submit = async () => {
    if (inFlight.current || !source || (!pending && (!sourceAvailable || !selectedTarget?.available)) || !draft.prompt.trim() || props.error) return;
    const input: HandoffInput = pending?.input ?? { requestId: crypto.randomUUID(), sourceTerminalId: source.id,
      targetLauncher: target, prompt: draft.prompt.trim(), criteria: draft.criteria.trim() || undefined,
      excerpt: draft.share && shared ? shared : undefined, returnToConversation: draft.returnToConversation };
    inFlight.current = true;
    if (!pending) setPending({ input, source: {...source}, draft: {...draft, target}, conversationTitle });
    setBusy('start'); setNotice('');
    try {
      const task = await props.bridge.handoffStart(input);
      if (!alive.current) return;
      if ('rejected' in task) { setPending(undefined); setNotice(task.message); return; }
      setPending(undefined); setDetails(task.id);
      revealConfirmedTask(task.id);
      setDrafts(previous => ({...previous, [input.sourceTerminalId]: blankDraft()}));
      setNotice('任务已建立。你可以收起面板，稍后查看结果。');
    } catch {
      if (alive.current) setNotice('提交结果尚未确认。正在核对记录；重新确认使用同一请求，不会新建第二项任务。');
    } finally {
      inFlight.current = false;
      if (alive.current) { setBusy(''); await propsRef.current.refresh(); }
    }
  };
  const action = async (task: HandoffTask, kind: 'cancel' | 'return') => {
    if (inFlight.current || props.error) return;
    inFlight.current = true; setBusy(task.id); setNotice('');
    try {
      if (kind === 'cancel') await props.bridge.handoffCancel({taskId: task.id});
      else await props.bridge.handoffReturn({taskId: task.id});
      if (alive.current) setNotice(kind === 'cancel' ? '已请求停止这项任务。' : '结果已加入原对话，等待对话处理。');
    } catch {
      if (alive.current) setNotice('操作结果尚未确认，请核对更新后的任务状态。');
    } finally {
      inFlight.current = false;
      if (alive.current) { setBusy(''); await propsRef.current.refresh(); }
    }
  };
  const ordered = [...props.tasks].sort((a,b) => b.createdAt - a.createdAt);
  const running = ordered.filter(working).length;
  if (!props.opened) return null;
  return <section className="dt-handoff-panel" aria-label="Agent 协作" onKeyDown={event => {
    event.stopPropagation(); if (event.key === 'Escape') props.onClose();
  }}>
    <header className="dt-handoff-header"><div><span className="dt-handoff-eyebrow">一起完成下一步</span><h2>把任务，交给搭档。</h2></div>
      <button className="dt-icon-action" aria-label="关闭协作面板" onClick={props.onClose}>×</button></header>
    <div className="dt-handoff-scroll" ref={scrollRef}>
      <div className="dt-handoff-destination"><span>关联对话</span><strong title={conversationTitle}>{conversationTitle}</strong></div>
      {source ? <form className="dt-handoff-form" onSubmit={event => {event.preventDefault(); void submit();}}>
        <div className="dt-handoff-source"><span>{pending ? '原来源' : '来自'}</span><button type="button" disabled={!sourceAvailable} title={sourceAvailable ? '回到来源终端' : '来源终端已关闭'} onClick={() => {
          if (props.onShowTerminal(source.id)) props.onClose();
          else setNotice('来源终端已关闭，任务内容仍然保留。');
        }}><AgentIcon launcher={source.launcher}/><span className="dt-handoff-source-name">{source.title || agentName(source.launcher)}</span> <span>{sourceAvailable ? '↗' : '已关闭'}</span></button></div>
        {!sourceAvailable && <p className="dt-handoff-source-closed" role="status">{pending ? '来源终端已关闭。仍可确认原提交，任务内容不会改变。' : '来源终端已关闭，草稿已保留。新建协作前，请选择一个可用终端。'}</p>}
        {pending && <p className="dt-handoff-pending" role="status">{busy === 'start' ? '正在确认这项提交。' : '这项提交仍待确认。'}任务内容与原来源已保留；重新确认不会改用当前终端，也不会新建第二项任务。</p>}
        <label className="dt-handoff-label">交给谁
          <div className="dt-handoff-target"><AgentIcon launcher={target || 'shell'}/><select aria-label="接收任务的 Agent" value={target} disabled={!!pending || !props.loaded || !!props.error} onChange={event => change({target:event.target.value})}>
            {!target && <option value="">{props.loaded ? '暂无可用的任务执行器' : '正在检测…'}</option>}
            {pending && !selectedTarget && <option value={target}>{agentName(target)} · 原执行者</option>}
            {props.targets.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{!item.available ? ` · ${item.reason || '暂不可用'}` : ''}</option>)}
          </select><span>独立执行</span></div>
          {selectedTarget?.reason && <span className="dt-handoff-target-note">{selectedTarget.reason}</span>}
        </label>
        <label className="dt-handoff-label">任务目标<textarea aria-label="协作任务目标" rows={4} maxLength={4000} value={draft.prompt} disabled={!!pending}
          placeholder="例如：审查这次修改，找出遗漏和风险，并给出修改建议。" onChange={event => change({prompt:event.target.value})}/></label>
        <label className="dt-handoff-label">怎样算完成 <span className="dt-handoff-optional">选填</span><input aria-label="协作完成判据" maxLength={2000} value={draft.criteria} disabled={!!pending}
          placeholder="例如：列出问题位置、原因与验证方法。" onChange={event => change({criteria:event.target.value})}/></label>
        <div className="dt-handoff-sharing">
          <label><input type="checkbox" checked={draft.share && !!shared} disabled={!shared || !!pending} onChange={event => change({share:event.target.checked})}/>
            <span>附上选中的终端内容<small>{shared ? `${shared.length.toLocaleString()} 个字符，可展开检查` : '在来源终端选择文字后，可附在任务中'}</small></span></label>
          {draft.share && shared && <details><summary>查看共享内容</summary><pre>{shared}</pre></details>}
          <label><input type="checkbox" checked={draft.returnToConversation} disabled={!!pending} onChange={event => change({returnToConversation:event.target.checked})}/>
            <span>完成后将结果送回关联对话<small>切换页面不会改变这项任务的归属</small></span></label>
        </div>
        <button className="dt-handoff-submit" disabled={!!busy || !!props.error || (!pending && (!sourceAvailable || !selectedTarget?.available)) || !draft.prompt.trim()} type="submit">
          <span>{busy === 'start' ? '正在提交…' : pending ? '重新确认提交' : '交给 '+agentName(target)}</span><span aria-hidden="true">↗</span></button>
        <p className="dt-handoff-footnote">使用该 Agent 的工作区配置与权限。未登录或连接失败时，会保留失败原因。</p>
      </form> : <div className="dt-handoff-no-source"><strong>先选择一个来源终端</strong><p>在终端中开始工作，再把下一步交给其他 Agent。</p><button onClick={props.onClose}>返回终端</button></div>}
      {(props.error || notice) && <div className="dt-handoff-notice" role="status">{props.error || notice}</div>}
      <div className="dt-handoff-list-heading" ref={recordsRef}><h3>协作记录 <span>{ordered.length}</span></h3><span>{running ? `${running} 项执行中` : '结果与来源一起保留'}</span></div>
      {!props.loaded && <p className="dt-handoff-empty" role="status">正在读取协作记录…</p>}
      {props.loaded && !ordered.length && <div className="dt-handoff-empty"><span>↗</span><p>第一项协作，从这里开始。</p><small>谁发起、谁执行、结果在哪里，都有记录。</small></div>}
      <div className="dt-handoff-list">{ordered.map(task => <article key={task.id} className={`dt-handoff-card is-${task.status}`}
        ref={element => { if (element) cardsRef.current.set(task.id, element); else cardsRef.current.delete(task.id); }}>
        <Route source={task.sourceLauncher} target={task.targetLauncher}/>
        {task.parentTaskId && <button className="dt-handoff-parent" type="button" onClick={() => {setDetails(task.parentTaskId);setRevealTaskId(task.parentTaskId);}}>↳ 返工自上一项任务 · 查看来源</button>}
        <p className="dt-handoff-task-title">{task.prompt}</p>
        <div className="dt-handoff-card-meta"><span className="dt-handoff-status"><i/>{handoffStatus(task)}</span>
          <time dateTime={new Date(task.createdAt).toISOString()}>{new Date(task.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div>
        {task.delivery === 'queued' && <button className="dt-handoff-delivered" onClick={props.onShowConversation} disabled={!props.onShowConversation}>↗ 结果已加入关联对话</button>}
        {task.delivery === 'failed' && <p className="dt-handoff-delivery-error">结果已保留，回传对话暂未成功。</p>}
        {task.delivery === 'uncertain' && <p className="dt-handoff-delivery-error">回传状态待确认，请先查看原对话。</p>}
        {task.status === 'interrupted' && <p className="dt-handoff-delivery-error">运行期间连接已中断，此任务不会自动重跑。</p>}
        <div className="dt-handoff-card-actions"><button aria-expanded={details === task.id} onClick={() => setDetails(details === task.id ? undefined : task.id)}>{details === task.id ? '收起详情' : '查看任务与结果'}</button>
          {working(task) && <button disabled={!!busy || !!props.error} onClick={() => { void action(task,'cancel'); }}>停止任务</button>}
          {(task.result || task.error) && ['succeeded','failed'].includes(task.status) && task.delivery !== 'queued' && <button disabled={!!busy || !!props.error} onClick={() => { void action(task,'return'); }}>{task.delivery === 'uncertain' ? '核对回传' : '送回对话'}</button>}</div>
        {details === task.id && <div className="dt-handoff-result">
          <div><strong>任务目标</strong><p>{task.prompt}</p></div>
          {task.criteria && <div><strong>完成判据</strong><p>{task.criteria}</p></div>}
          {task.reworkIssues && <div><strong>本次需要修改</strong><p>{task.reworkIssues}</p></div>}
          {task.error && <p className="dt-handoff-task-error">{task.error}</p>}
          {task.result ? <HandoffResult text={task.result}/> : <p>{working(task) ? 'Agent 正在执行，完成后会在这里显示结果。' : '这次执行没有返回结果。'}</p>}
        </div>}
        <HandoffReview task={task} bridge={props.bridge} targets={props.targets} expanded={details === task.id} blocked={!!busy || !!props.error}
          refresh={props.refresh} reveal={id => {setDetails(id);setRevealTaskId(id);}}/>
      </article>)}</div>
    </div>
  </section>;
}

export function HandoffSummary({tasks, onOpen}: {tasks:HandoffTask[];onOpen():void}) {
  const latest = [...tasks].sort((a,b) => b.createdAt - a.createdAt);
  if (!latest.length) return null;
  const task = latest.find(working) || latest[0];
  return <button className="dt-handoff-summary" onClick={onOpen} aria-label="查看 Agent 协作记录">
    <Route source={task.sourceLauncher} target={task.targetLauncher}/><span>{handoffStatus(task)}</span><span className="dt-handoff-summary-more">协作 {tasks.length} ↗</span>
  </button>;
}
