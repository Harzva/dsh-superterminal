import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { AgentIcon } from './agent-icon';
import { FitAddon } from '@xterm/addon-fit';
import { ShellCommandHistory } from './shell-command-history';
import naturalCss from './terminal-run-panel.css';
import type { TerminalBridge, TerminalSummary } from './types';

type Props = {
  terminal: TerminalSummary;
  bridge: TerminalBridge;
  viewerId: string;
  number: number;
  focused: boolean;
  connected: boolean;
  visible: boolean;
  zoomed: boolean;
  autoClaim: boolean;
  title?: string;
  draft?: { id: string; text: string };
  naturalContent?: React.ReactNode;
  naturalOpen?: boolean;
  onNaturalToggle?(open: boolean): void;
  onTitleChange?(title: string): void;
  onAddToGroup?(): void;
  onGroupDragStart?(event: React.DragEvent): void;
  onHide?(): void;
  onSelection?(text: string): void;
  onSelectionAction?(action: 'execute' | 'explain' | 'fix' | 'handoff', text: string): void;
  onReadStatus?(failed: boolean): void;
  centralizedStatus?: boolean;
  onFocus(): void;
  onZoom(): void;
  onSplit(axis: 'x' | 'y'): void;
  onClosed(): void;
  onState(state: string, exitCode?: number | null): void;
};

function nativeVisible(props: Props): boolean {
  return props.visible && !(props.naturalContent != null && props.naturalOpen);
}

function stateLabel(state: string, exitCode?: number | null): string {
  if (state === 'running') return '运行中';
  if (state === 'starting') return '启动中';
  if (state === 'exited') return exitCode == null ? '已退出' : `已退出 · ${exitCode}`;
  if (state === 'closed') return '已关闭';
  if (state === 'closing') return '结束中';
  if (state === 'error') return '启动失败';
  if (state === 'cleanup-error') return '结束失败';
  return state || '状态未知';
}


export function TerminalPane(props: Props) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const naturalShown = props.naturalContent != null && Boolean(props.naturalOpen);
  const terminalVisible = nativeVisible(props);
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const mountedRef = useRef(false);
  const leaseRef = useRef<string | null>(null);
  const activeViewerRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedCharacters = useRef(0);
  const managementBusy = useRef(false);
  const controlGeneration = useRef(0);
  const gapRef = useRef(false);
  const readyRef = useRef(false);
  const readableRef = useRef(true);
  const stateRef = useRef(props.terminal.state);
  const claimRef = useRef<() => Promise<void>>(async () => {});
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeAgain = useRef(false);
  const resizeRunning = useRef(false);
  const [ready, setReady] = useState(false);
  const [owned, setOwned] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [state, setState] = useState(props.terminal.state);
  const [exitCode, setExitCode] = useState(props.terminal.exitCode);
  const [bell, setBell] = useState(false);
  const [localTitle, setLocalTitle] = useState('');
  const title = props.title ?? localTitle;
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [draftCopy, setDraftCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [fontSize, setFontSize] = useState(12);
  const [gap, setGap] = useState(false);
  const [readError, setReadError] = useState('');
  const [controlError, setControlError] = useState('');
  const [size, setSize] = useState({ rows: props.terminal.rows, cols: props.terminal.cols });
  const [selectionText, setSelectionText] = useState('');
  const [selectionOpen, setSelectionOpen] = useState(false);
  const [selectionPosition, setSelectionPosition] = useState({left: 8, top: 48});
  useEffect(() => { propsRef.current.onReadStatus?.(Boolean(readError)); }, [Boolean(readError)]);

  const commitTitle = () => {
    const value = titleDraft.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48);
    setLocalTitle(value);
    props.onTitleChange?.(value);
    setEditingTitle(false);
  };

  useEffect(() => { setDraftCopy('idle'); }, [props.draft?.id, props.draft?.text]);

  const copyDraft = async () => {
    if (!props.draft) return;
    const current = props.draft;
    try {
      await navigator.clipboard.writeText(current.text);
      if (mountedRef.current && propsRef.current.draft?.id === current.id) setDraftCopy('copied');
    } catch {
      if (mountedRef.current && propsRef.current.draft?.id === current.id) setDraftCopy('failed');
    }
  };

  const inputAllowed = useCallback(() => (
    mountedRef.current && propsRef.current.connected && readyRef.current && readableRef.current && !gapRef.current &&
    leaseRef.current !== null && stateRef.current === 'running'
  ), []);

  const updateStdin = useCallback(() => {
    if (terminalRef.current) terminalRef.current.options.disableStdin = !nativeVisible(propsRef.current) || !inputAllowed();
  }, [inputAllowed]);

  const lockControl = useCallback((message: string) => {
    controlGeneration.current += 1;
    leaseRef.current = null;
    updateStdin();
    if (!mountedRef.current) return;
    setOwned(false);
    setControlError(message);
  }, [updateStdin]);

  const send = useCallback((data: string) => {
    if (!inputAllowed()) return;
    if (queuedCharacters.current + data.length > 1024 * 1024) {
      lockControl('待发送输入超过上限，已停止发送并丢弃排队输入。请重新接管后分段粘贴。');
      return;
    }
    const lease = leaseRef.current!;
    const generation = controlGeneration.current;
    for (let start = 0; start < data.length;) {
      let end = Math.min(start + 16384, data.length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end -= 1;
      const chunk = data.slice(start, end);
      start = end;
      queuedCharacters.current += chunk.length;
      queueRef.current = queueRef.current.then(async () => {
        try {
          if (!inputAllowed() || generation !== controlGeneration.current || lease !== leaseRef.current) return;
          const sequence = sequenceRef.current++;
          await propsRef.current.bridge.write({ terminalId: propsRef.current.terminal.id, lease, sequence, data: chunk });
        } catch (error) {
          if (generation === controlGeneration.current) {
            lockControl('未能确认输入是否送达，已暂停输入。请重新接管后检查终端，上一段输入不会自动重发。');
          }
        } finally {
          queuedCharacters.current -= chunk.length;
        }
      });
    }
  }, [inputAllowed, lockControl]);

  const resizeToViewport = useCallback(async (): Promise<void> => {
    const host = hostRef.current;
    const term = terminalRef.current;
    const lease = leaseRef.current;
    if (!mountedRef.current || !host || !term || !lease || !readyRef.current || gapRef.current || stateRef.current !== 'running' ||
        !nativeVisible(propsRef.current) || host.clientWidth < 16 || host.clientHeight < 16) return;
    if (resizeRunning.current) {
      resizeAgain.current = true;
      return;
    }
    fitRef.current?.fit();
    const { rows, cols } = term;
    if (rows < 1 || cols < 2) return;
    resizeRunning.current = true;
    const generation = controlGeneration.current;
    try {
      await propsRef.current.bridge.resize({ terminalId: propsRef.current.terminal.id, lease, rows, cols });
      if (mountedRef.current && generation === controlGeneration.current) setSize({ rows, cols });
    } catch (error) {
      if (generation === controlGeneration.current) {
        lockControl('窗口大小暂未同步，输入已暂停。请点击重新接管。');
      }
    } finally {
      resizeRunning.current = false;
      if (resizeAgain.current && mountedRef.current) {
        resizeAgain.current = false;
        resizeTimer.current = setTimeout(() => { void resizeToViewport(); }, 80);
      }
    }
  }, [lockControl]);

  const scheduleResize = useCallback(() => {
    if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      resizeTimer.current = null;
      void resizeToViewport();
    }, 80);
  }, [resizeToViewport]);

  const claim = useCallback(async () => {
    if (managementBusy.current) return;
    managementBusy.current = true;
    controlGeneration.current += 1;
    const generation = controlGeneration.current;
    leaseRef.current = null;
    setOwned(false);
    setClaiming(true);
    updateStdin();
    await queueRef.current;
    if (!mountedRef.current || generation !== controlGeneration.current) {
      managementBusy.current = false;
      if (mountedRef.current) setClaiming(false);
      return;
    }
    try {
      const claimViewerId = `${propsRef.current.viewerId}:${crypto.randomUUID()}`;
      const result = await propsRef.current.bridge.claim({
        terminalId: propsRef.current.terminal.id,
        viewerId: claimViewerId,
      });
      if (!mountedRef.current || generation !== controlGeneration.current) return;
      leaseRef.current = result.lease;
      activeViewerRef.current = claimViewerId;
      sequenceRef.current = result.nextSequence;
      setOwned(true);
      setControlError('');
      updateStdin();
      scheduleResize();
      if (nativeVisible(propsRef.current) && propsRef.current.focused) terminalRef.current?.focus();
    } catch (error) {
      if (mountedRef.current && generation === controlGeneration.current) {
        setControlError('暂时无法接管，可继续查看终端。请稍后重试。');
      }
    } finally {
      managementBusy.current = false;
      if (mountedRef.current) setClaiming(false);
    }
  }, [scheduleResize, updateStdin]);
  claimRef.current = claim;

  const close = useCallback(async () => {
    const settled = stateRef.current === 'exited' || stateRef.current === 'error';
    const lease = leaseRef.current ?? (settled ? 'dismiss-exited' : null);
    if (!lease || managementBusy.current) return;
    managementBusy.current = true;
    setClosing(true);
    controlGeneration.current += 1;
    const generation = controlGeneration.current;
    leaseRef.current = null;
    updateStdin();
    await queueRef.current;
    if (!mountedRef.current) return;
    try {
      await propsRef.current.bridge.close({ terminalId: propsRef.current.terminal.id, lease });
      if (mountedRef.current) propsRef.current.onClosed();
    } catch (error) {
      if (mountedRef.current && generation === controlGeneration.current) {
        setOwned(false);
        setControlError('尚未确认终端是否关闭，请刷新列表查看。');
      }
    } finally {
      managementBusy.current = false;
      if (mountedRef.current) setClosing(false);
    }
  }, [updateStdin]);

  useEffect(() => {
    mountedRef.current = true;
    let canceled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let offset = 0;
    let firstRead = true;
    let resolveWrite: (() => void) | null = null;
    const term = new Terminal({
      rows: Math.max(1, propsRef.current.terminal.rows || 24),
      cols: Math.max(2, propsRef.current.terminal.cols || 80),
      cursorBlink: true,
      convertEol: false,
      disableStdin: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      lineHeight: 1.18,
      scrollback: 5000,
      theme: {
        background: '#10151b', foreground: '#d6dde5', cursor: '#8dddd0', selectionBackground: '#3a647866',
        black: '#25303b', red: '#f08b91', green: '#9cd7ac', yellow: '#e7c78b',
        blue: '#89b9ed', magenta: '#c2a2e8', cyan: '#7bd1cf', white: '#d6dde5',
        brightBlack: '#718093', brightRed: '#ffa1a7', brightGreen: '#b4ebc2', brightYellow: '#f4d8a4',
        brightBlue: '#a3cdff', brightMagenta: '#d9bcfb', brightCyan: '#a0e7e5', brightWhite: '#f4f7fb',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    terminalRef.current = term;
    fitRef.current = fit;
    const inputDisposable = term.onData(send);
    const bellDisposable = term.onBell(() => { if (!canceled) setBell(true); });
    const selectionDisposable = term.onSelectionChange(() => {
      if (canceled) return;
      const text = term.getSelection().slice(0, 4000);
      setSelectionText(text); setSelectionOpen(Boolean(text));
      propsRef.current.onSelection?.(text);
    });
    term.attachCustomKeyEventHandler(event => !(event.altKey && event.shiftKey && (
      event.key.startsWith('Arrow') || event.key === 'Enter'
    )));
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(hostRef.current!);

    const poll = async () => {
      if (canceled || gapRef.current) return;
      let delay = nativeVisible(propsRef.current) ? 100 : 1000;
      try {
        const result = await propsRef.current.bridge.read({ terminalId: propsRef.current.terminal.id, offset });
        if (canceled) return;
        if (result.gap || result.baseOffset > offset || result.nextOffset < offset) {
          gapRef.current = true;
          readableRef.current = false;
          setGap(true);
          updateStdin();
          return;
        }
        if (result.data.length > 0) {
          await new Promise<void>(resolve => {
            resolveWrite = resolve;
            term.write(result.data, () => { resolveWrite = null; resolve(); });
          });
        }
        if (canceled) return;
        offset = result.nextOffset;
        readableRef.current = true;
        const replayComplete = !firstRead || result.data.length === 0;
        readyRef.current = replayComplete;
        stateRef.current = result.state;
        setReadError('');
        setReady(replayComplete);
        setState(result.state);
        setExitCode(result.exitCode);
        propsRef.current.onState(result.state, result.exitCode);
        updateStdin();
        if (firstRead && replayComplete) {
          firstRead = false;
          if (propsRef.current.autoClaim && result.state === 'running') void claimRef.current();
        }
        if (firstRead) delay = 0;
      } catch (error) {
        if (canceled) return;
        readableRef.current = false;
        setReadError('终端暂时无法更新，正在重新连接');
        updateStdin();
        delay = 1000;
      }
      if (!canceled && !gapRef.current) pollTimer = setTimeout(() => { void poll(); }, delay);
    };
    void poll();
    return () => {
      canceled = true;
      mountedRef.current = false;
      controlGeneration.current += 1;
      leaseRef.current = null;
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
      observer.disconnect();
      inputDisposable.dispose();
      bellDisposable.dispose();
      selectionDisposable.dispose();
      propsRef.current.onSelection?.('');
      resolveWrite?.();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [props.terminal.id, scheduleResize, send, updateStdin]);

  useEffect(() => {
    if (!leaseRef.current && props.terminal.cols > 0 && props.terminal.rows > 0) {
      terminalRef.current?.resize(props.terminal.cols, props.terminal.rows);
      setSize({ rows: props.terminal.rows, cols: props.terminal.cols });
    }
  }, [props.terminal.cols, props.terminal.rows]);

  useEffect(() => {
    stateRef.current = props.terminal.state;
    setState(props.terminal.state);
    setExitCode(props.terminal.exitCode);
    updateStdin();
  }, [props.terminal.state, props.terminal.exitCode, props.connected, terminalVisible, updateStdin]);

  useEffect(() => {
    if (leaseRef.current && props.terminal.writer && props.terminal.writer !== activeViewerRef.current) {
      lockControl('其他视图已接管此终端。当前只读，可显式重新接管。');
    }
  }, [props.terminal.writer, lockControl]);

  useEffect(() => {
    if (terminalVisible) {
      scheduleResize();
      if (props.focused && ready) terminalRef.current?.focus();
    } else {
      terminalRef.current?.blur();
    }
  }, [terminalVisible, props.focused, props.zoomed, ready, scheduleResize]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.fontSize = fontSize;
    scheduleResize();
  }, [fontSize, scheduleResize]);

  const writable = props.connected && owned && ready && !gap && !readError && state === 'running' && !closing && !claiming;
  const settled = state === 'exited' || state === 'error';
  return (
    <section ref={paneRef} className={`dt-pane${props.focused ? ' is-focused' : ''}${bell ? ' has-bell' : ''}`}
      aria-label={`终端 ${props.number} ${props.terminal.launcher}`} onPointerDown={props.onFocus}
      onPointerUp={event => {
        if (!terminalVisible || !terminalRef.current?.getSelection()) return;
        const bounds = paneRef.current?.getBoundingClientRect();
        if (bounds) setSelectionPosition({left: Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 290)), top: Math.max(46, Math.min(event.clientY - bounds.top + 8, bounds.height - 90))});
      }}
      onFocusCapture={props.onFocus}>
      <style>{naturalCss}</style>
      <header className="dt-pane-bar" draggable={Boolean(props.onGroupDragStart) && !editingTitle}
        onDragStart={event => {
          const target = event.target as HTMLElement;
          if (editingTitle || target.closest('input,textarea') || (target.closest('button') && !target.closest('.dt-pane-title,.dt-pane-group'))) {event.preventDefault();return;}
          props.onGroupDragStart?.(event);
        }}>
        <AgentIcon launcher={props.terminal.launcher} />
        <span className="dt-pane-number">{String(props.number).padStart(2, '0')}</span>
        {editingTitle ? <input className="dt-title-input" autoFocus maxLength={48}
          aria-label={`终端 ${props.number} 名称`} value={titleDraft}
          onChange={event => setTitleDraft(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Enter') { event.preventDefault(); commitTitle(); }
            if (event.key === 'Escape') { event.preventDefault(); setEditingTitle(false); }
          }} /> : <button className="dt-pane-title" draggable={Boolean(props.onGroupDragStart)} title={`${props.terminal.launcher} · 点击命名任务`}
          aria-label={`重命名终端 ${props.number}`} onClick={() => { setTitleDraft(title); setEditingTitle(true); }}>
          {title || props.terminal.launcher}</button>}
        <span className={`dt-state dt-state-${state}`}>{props.connected ? stateLabel(state, exitCode) : '连接中断'}</span>
        {bell && <button className="dt-bell" onClick={() => setBell(false)} title="清除终端响铃标记">终端响铃 ×</button>}
        <span className="dt-pane-spacer" />
        {props.onAddToGroup && <button type="button" className="dt-icon-button dt-pane-group" draggable={Boolean(props.onGroupDragStart)} onClick={props.onAddToGroup}
          aria-label={`将终端 ${props.number} 加入讨论组`} title="加入讨论组，也可拖动标题到组名">◎</button>}
        <button className="dt-split-button" onClick={() => props.onSplit('x')} title="左右分割，添加空窗格"
          aria-label={`左右分割终端 ${props.number}`}>◫</button>
        <button className="dt-split-button" onClick={() => props.onSplit('y')} title="上下分割，添加空窗格"
          aria-label={`上下分割终端 ${props.number}`}><span className="dt-split-vertical">◫</span></button>
        <button className="dt-icon-button" onClick={props.onZoom} title={props.zoomed ? '还原布局' : '放大此窗格'}
          aria-label={props.zoomed ? '还原布局' : `放大终端 ${props.number}`}>{props.zoomed ? '↙' : '⤢'}</button>
        {props.onHide && <button className="dt-icon-button" onClick={props.onHide} title="收起终端，任务继续运行"
          aria-label={`收起终端 ${props.number}`}>−</button>}
        <button className="dt-icon-button dt-close" onClick={() => setConfirmClose(true)} disabled={(!owned && !settled) || closing || claiming}
          title={settled ? '移除已结束的任务' : owned ? '结束任务' : '接管后可结束任务'} aria-label={`结束终端 ${props.number} 的任务`}>×</button>
      </header>
      {props.naturalContent != null && <div className="dt-pane-modes" role="group" aria-label={`终端 ${props.number} 视图`}>
        <button type="button" className={naturalShown ? 'is-active' : ''} aria-pressed={naturalShown}
          disabled={!props.onNaturalToggle} onClick={() => props.onNaturalToggle?.(true)}>AI 任务</button>
        <button type="button" className={!naturalShown ? 'is-active' : ''} aria-pressed={!naturalShown}
          disabled={!props.onNaturalToggle} onClick={() => props.onNaturalToggle?.(false)}>终端</button>
      </div>}
      {confirmClose && <div className="dt-pane-confirm" role="alertdialog" aria-label="确认结束任务">
        <p>{settled ? '移除这个已结束的任务？' : '结束这个任务？当前运行会停止。'}</p>
        <div>
          <button onClick={() => setConfirmClose(false)} disabled={closing}>取消</button>
          <button className="dt-danger" onClick={() => { setConfirmClose(false); void close(); }}
            disabled={(!owned && !settled) || closing || claiming}>{settled ? '移除任务' : '结束任务'}</button>
        </div>
      </div>}
      {naturalShown && props.connected && !readError && controlError && <div className="dt-pane-notice dt-danger" role="alert">{controlError}</div>}
      <div className="dt-pane-natural" style={{ display: naturalShown ? 'flex' : 'none' }} aria-hidden={!naturalShown}>
        {props.naturalContent}
      </div>
      <div className="dt-pane-native" style={{ display: naturalShown ? 'none' : 'flex' }} aria-hidden={naturalShown}>
      <div className="dt-terminal-scroll"><div className="dt-terminal-host" ref={hostRef} /></div>
      {props.terminal.launcher === 'shell' && <ShellCommandHistory bridge={props.bridge} terminalId={props.terminal.id}
        connected={props.connected && !readError} visible={terminalVisible} onExplain={text => props.onSelectionAction?.('explain', text)}/>}
      {selectionOpen && selectionText && props.focused && props.onSelectionAction && <div className="dt-selection-actions" role="toolbar" aria-label="对选中的终端内容使用 AI" style={selectionPosition}
        onPointerDown={event => event.preventDefault()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') setSelectionOpen(false); }}>
        <span>终端 {String(props.number).padStart(2, '0')} · 已选 {selectionText.length} 字符</span>
        <div>{([['execute', '直接处理'], ['explain', '解释'], ['fix', '建议修复'], ['handoff', '交给 Agent']] as const).map(([action, label]) => <button key={action} onClick={() => {
          props.onSelectionAction?.(action, selectionText); setSelectionOpen(false);
        }}>{label}</button>)}<button aria-label="收起选区操作" onClick={() => setSelectionOpen(false)}>×</button></div>
      </div>}
      {props.draft && <div className="dt-pane-draft">
        <div className="dt-pane-draft-actions"><strong>待发送草稿</strong>
          <button onClick={() => { void copyDraft(); }}>{draftCopy === 'copied' ? '已复制' : '复制草稿'}</button>
        </div>
        <textarea readOnly aria-label={`终端 ${props.number} 待发送草稿`} value={props.draft.text} rows={3}
          onKeyDown={event => event.stopPropagation()} />
        <span role="status">{draftCopy === 'failed' ? '未能复制，请选中文字手动复制。' : draftCopy === 'copied'
          ? '已复制。请检查终端当前输入位置后粘贴。' : '检查内容后，可复制到这个终端。'}</span>
      </div>}
      {gap && <div className="dt-pane-notice dt-danger" role="alert">输出缓冲已截断，无法准确恢复画面，输入已停用。接管后可关闭此终端，再新建。</div>}
      {props.connected && !props.centralizedStatus && !gap && readError && <div className="dt-pane-notice" role="status">输出读取失败：{readError}。暂停输入，正在重试读取…</div>}
      {!gap && !readError && !ready && <div className="dt-pane-notice" role="status">正在读取真实终端输出…</div>}
      {props.connected && !readError && controlError && <div className="dt-pane-notice dt-danger" role="alert">{controlError}</div>}
      <footer className="dt-pane-footer">
        <span title={props.terminal.id}>{props.terminal.pid ? `PID ${props.terminal.pid}` : '等待进程'}</span>
        <span title="终端字符列数 × 行数">{size.cols} × {size.rows}</span>
        <div className="dt-font-controls" aria-label={`终端 ${props.number} 字号`}>
          <button disabled={fontSize <= 10} onClick={() => setFontSize(value => Math.max(10, value - 1))}
            aria-label={`缩小终端 ${props.number} 字号`} title="缩小字号">A−</button>
          <button onClick={() => setFontSize(12)} title="恢复 12px 字号" aria-label={`重置终端 ${props.number} 字号`}>{fontSize}</button>
          <button disabled={fontSize >= 22} onClick={() => setFontSize(value => Math.min(22, value + 1))}
            aria-label={`放大终端 ${props.number} 字号`} title="放大字号">A+</button>
        </div>
        <button className="dt-scroll-bottom" onClick={() => terminalRef.current?.scrollToBottom()}
          title="回到最新输出" aria-label={`终端 ${props.number} 回到底部`}>↓</button>
        <span className="dt-pane-spacer" />
        {settled ? <span>进程已结束</span> : !props.connected || readError ? <span>输入暂停</span> : owned && !controlError ? <span className="dt-writer">可输入</span> : <button
          className="dt-claim" disabled={claiming || closing || (state !== 'running' && state !== 'cleanup-error')} onClick={() => { void claim(); }}
          title="取得此终端的人工输入控制权">{claiming ? '接管中…' : controlError ? '重新接管' : '接管输入'}</button>}
        <button className="dt-interrupt" disabled={!writable} onClick={() => send('\u0003')} title="向此终端发送 Ctrl-C">Ctrl-C</button>
      </footer>
      </div>
    </section>
  );
}
