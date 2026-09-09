import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { AgentIcon } from './agent-icon';
import { FitAddon } from '@xterm/addon-fit';
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
  onFocus(): void;
  onZoom(): void;
  onSplit(axis: 'x' | 'y'): void;
  onClosed(): void;
  onState(state: string, exitCode?: number | null): void;
};

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
  const hostRef = useRef<HTMLDivElement>(null);
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
  const [title, setTitle] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [fontSize, setFontSize] = useState(12);
  const [gap, setGap] = useState(false);
  const [readError, setReadError] = useState('');
  const [controlError, setControlError] = useState('');
  const [size, setSize] = useState({ rows: props.terminal.rows, cols: props.terminal.cols });

  const inputAllowed = useCallback(() => (
    mountedRef.current && readyRef.current && readableRef.current && !gapRef.current &&
    leaseRef.current !== null && stateRef.current === 'running'
  ), []);

  const updateStdin = useCallback(() => {
    if (terminalRef.current) terminalRef.current.options.disableStdin = !inputAllowed();
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
        !propsRef.current.visible || host.clientWidth < 16 || host.clientHeight < 16) return;
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
      if (propsRef.current.focused) terminalRef.current?.focus();
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
    term.attachCustomKeyEventHandler(event => !(event.altKey && event.shiftKey && (
      event.key.startsWith('Arrow') || event.key === 'Enter'
    )));
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(hostRef.current!);

    const poll = async () => {
      if (canceled || gapRef.current) return;
      let delay = 100;
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
  }, [props.terminal.state, props.terminal.exitCode, updateStdin]);

  useEffect(() => {
    if (leaseRef.current && props.terminal.writer && props.terminal.writer !== activeViewerRef.current) {
      lockControl('其他视图已接管此终端。当前只读，可显式重新接管。');
    }
  }, [props.terminal.writer, lockControl]);

  useEffect(() => {
    if (props.visible) {
      scheduleResize();
      if (props.focused && ready) terminalRef.current?.focus();
    }
  }, [props.visible, props.focused, props.zoomed, ready, scheduleResize]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.fontSize = fontSize;
    scheduleResize();
  }, [fontSize, scheduleResize]);

  const writable = owned && ready && !gap && !readError && state === 'running' && !closing && !claiming;
  const settled = state === 'exited' || state === 'error';
  return (
    <section className={`dt-pane${props.focused ? ' is-focused' : ''}${bell ? ' has-bell' : ''}`}
      aria-label={`终端 ${props.number} ${props.terminal.launcher}`} onPointerDown={props.onFocus}
      onFocusCapture={props.onFocus}>
      <header className="dt-pane-bar">
        <AgentIcon launcher={props.terminal.launcher} />
        <span className="dt-pane-number">{String(props.number).padStart(2, '0')}</span>
        {editingTitle ? <input className="dt-title-input" autoFocus maxLength={48}
          aria-label={`终端 ${props.number} 名称`} value={titleDraft}
          onChange={event => setTitleDraft(event.target.value)}
          onBlur={() => { setTitle(titleDraft.trim()); setEditingTitle(false); }}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Enter') { event.preventDefault(); setTitle(titleDraft.trim()); setEditingTitle(false); }
            if (event.key === 'Escape') { event.preventDefault(); setEditingTitle(false); }
          }} /> : <button className="dt-pane-title" title={`${props.terminal.launcher} · 点击命名（当前视图）`}
          aria-label={`重命名终端 ${props.number}`} onClick={() => { setTitleDraft(title); setEditingTitle(true); }}>
          {title || props.terminal.launcher}</button>}
        <span className={`dt-state dt-state-${state}`}>{props.connected ? stateLabel(state, exitCode) : '连接中断'}</span>
        {bell && <button className="dt-bell" onClick={() => setBell(false)} title="清除终端响铃标记">终端响铃 ×</button>}
        <span className="dt-pane-spacer" />
        <button className="dt-split-button" onClick={() => props.onSplit('x')} title="左右分割，添加空窗格"
          aria-label={`左右分割终端 ${props.number}`}>◫</button>
        <button className="dt-split-button" onClick={() => props.onSplit('y')} title="上下分割，添加空窗格"
          aria-label={`上下分割终端 ${props.number}`}><span className="dt-split-vertical">◫</span></button>
        <button className="dt-icon-button" onClick={props.onZoom} title={props.zoomed ? '还原布局' : '放大此窗格'}
          aria-label={props.zoomed ? '还原布局' : `放大终端 ${props.number}`}>{props.zoomed ? '↙' : '⤢'}</button>
        <button className="dt-icon-button dt-close" onClick={() => { void close(); }} disabled={(!owned && !settled) || closing || claiming}
          title={settled ? '移除已结束的终端' : owned ? '关闭终端并结束进程' : '接管后可关闭终端并结束进程'} aria-label={`关闭终端 ${props.number} 并结束进程`}>×</button>
      </header>
      <div className="dt-terminal-scroll"><div className="dt-terminal-host" ref={hostRef} /></div>
      {gap && <div className="dt-pane-notice dt-danger" role="alert">输出缓冲已截断，无法准确恢复画面，输入已停用。接管后可关闭此终端，再新建。</div>}
      {props.connected && !gap && readError && <div className="dt-pane-notice" role="status">输出读取失败：{readError}。暂停输入，正在重试读取…</div>}
      {!gap && !readError && !ready && <div className="dt-pane-notice" role="status">正在读取真实终端输出…</div>}
      {props.connected && controlError && <div className="dt-pane-notice dt-danger" role="alert">{controlError}</div>}
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
        {settled ? <span>进程已结束</span> : owned && !controlError ? <span className="dt-writer">可输入</span> : <button
          className="dt-claim" disabled={claiming || closing || (state !== 'running' && state !== 'cleanup-error')} onClick={() => { void claim(); }}
          title="取得此终端的人工输入控制权">{claiming ? '接管中…' : controlError ? '重新接管' : '接管输入'}</button>}
        <button className="dt-interrupt" disabled={!writable} onClick={() => send('\u0003')} title="向此终端发送 Ctrl-C">Ctrl-C</button>
      </footer>
    </section>
  );
}
