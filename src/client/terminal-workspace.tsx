import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentManager, SmartAssistant } from './agent-manager';
import { AgentIcon } from './agent-icon';
import { TerminalPane } from './terminal-pane';
import { SupervisorPanel } from './supervisor-panel';
import { layoutGeometry, leafSlots, neighborSlot, pointerRatio, presetLayout, removeSlot, resizeSplit, splitSlot } from './layout.mjs';
import type { LayoutPreset, LayoutTree, Rect, Separator } from './layout.mjs';
import type { TerminalBridge, TerminalLauncher, TerminalSummary } from './types';
import workspaceCss from './terminal-workspace.css';
import xtermCss from '@xterm/xterm/css/xterm.css';

export type TerminalWorkspaceProps = { bridge: TerminalBridge; sessionId: string };

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1200);
}

class PaneBoundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <div className="dt-pane dt-pane-error" role="alert">终端视图出错，进程未被关闭。请重新打开此视图。</div>
      : this.props.children;
  }
}

function WorkspaceSession({ bridge, sessionId }: TerminalWorkspaceProps) {
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const [viewerId] = useState(() => `viewer-${crypto.randomUUID()}`);
  const [slots, setSlots] = useState<(TerminalSummary | null)[]>(() => Array(12).fill(null));
  const [launchers, setLaunchers] = useState<TerminalLauncher[]>([]);
  const [layout, setLayout] = useState<LayoutTree | null>(() => presetLayout('six', [0, 1, 2, 3, 4, 5]));
  const [preset, setPreset] = useState<LayoutPreset | 'custom'>('six');
  const [selectedSlot, setSelectedSlot] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; separatorId: string } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [autoClaimIds, setAutoClaimIds] = useState<Set<string>>(() => new Set());
  const [opening, setOpening] = useState<Record<number, 'pending' | 'uncertain'>>({});
  const [cwd, setCwd] = useState('');
  const [showManager, setShowManager] = useState(false);
  const [showSmart, setShowSmart] = useState(false);
  const [showSupervisor, setShowSupervisor] = useState(false);
  const [customCli, setCustomCli] = useState('');
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [actionError, setActionError] = useState('');
  const aliveRef = useRef(true);
  const mutationRef = useRef(0);
  const listSequence = useRef(0);
  const listRef = useRef<() => Promise<void>>(async () => {});

  const refresh = useCallback(async (manual = false) => {
    const sequence = ++listSequence.current;
    const mutation = mutationRef.current;
    try {
      const result = await bridgeRef.current.list();
      if (!aliveRef.current || sequence !== listSequence.current || mutation !== mutationRef.current) return;
      const active = result.terminals.filter(item => item.state !== 'closed');
      const byId = new Map(active.map(item => [item.id, item]));
      setSlots(previous => {
        const next = previous.map(item => item ? byId.get(item.id) ?? null : null);
        const existing = new Set(next.filter(Boolean).map(item => item!.id));
        for (const item of active) {
          if (existing.has(item.id)) continue;
          const free = next.indexOf(null);
          if (free < 0) break;
          next[free] = item;
          existing.add(item.id);
        }
        return next;
      });
      setLaunchers(result.launchers);
      setCwd(result.cwd);
      setListError(active.length > 12 ? `当前有 ${active.length} 个终端，此视图只能展示 12 个。` : '');
      if (manual) {
        setOpening(previous => Object.fromEntries(Object.entries(previous).filter(([, value]) => value === 'pending')));
        setActionError('');
      }
    } catch (error) {
      if (aliveRef.current && sequence === listSequence.current) setListError(/Failed to fetch|NetworkError|fetch failed/i.test(errorText(error)) ? '终端服务连接中断，正在重连。已有画面暂存，输入暂停；请勿重复启动。' : `终端列表暂不可用：${errorText(error)}`);
    } finally {
      if (aliveRef.current && sequence === listSequence.current) setLoading(false);
    }
  }, []);
  listRef.current = () => refresh();

  useEffect(() => {
    aliveRef.current = true;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await listRef.current();
      if (!canceled) timer = setTimeout(() => { void poll(); }, 2000);
    };
    void poll();
    return () => {
      canceled = true;
      aliveRef.current = false;
      listSequence.current += 1;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (zoomed && !slots.some(item => item?.id === zoomed)) setZoomed(null);
  }, [slots, zoomed]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      setViewportSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const open = async (index: number, launcher: string) => {
    if (opening[index] || slots[index]) return;
    setOpening(previous => ({ ...previous, [index]: 'pending' }));
    setActionError('');
    mutationRef.current += 1;
    try {
      const terminal = await bridgeRef.current.open({ launcher, rows: 24, cols: 80, requestId: crypto.randomUUID() });
      if (!aliveRef.current) return;
      mutationRef.current += 1;
      setSlots(previous => {
        if (previous.some(item => item?.id === terminal.id)) return previous;
        const next = [...previous];
        const target = next[index] === null ? index : next.indexOf(null);
        if (target >= 0) next[target] = terminal;
        return next;
      });
      setAutoClaimIds(previous => new Set([...previous, terminal.id]));
      setFocused(terminal.id);
      setSelectedSlot(index);
      setOpening(previous => {
        const next = { ...previous };
        delete next[index];
        return next;
      });
    } catch (error) {
      if (!aliveRef.current) return;
      setOpening(previous => ({ ...previous, [index]: 'uncertain' }));
      setActionError(`启动未完成：${errorText(error)}。未自动重试，请刷新列表确认是否已创建终端。`);
    }
  };

  const onClosed = (id: string) => {
    mutationRef.current += 1;
    setSlots(previous => previous.map(item => item?.id === id ? null : item));
    setAutoClaimIds(previous => { const next = new Set(previous); next.delete(id); return next; });
    if (focused === id) setFocused(null);
    if (zoomed === id) setZoomed(null);
  };

  const onState = (id: string, state: string, exitCode?: number | null) => {
    setSlots(previous => {
      const index = previous.findIndex(item => item?.id === id);
      const item = previous[index];
      if (!item || (item.state === state && item.exitCode === exitCode)) return previous;
      const next = [...previous];
      next[index] = { ...item, state, exitCode };
      return next;
    });
  };

  const terminals = slots.filter((item): item is TerminalSummary => item !== null);
  const running = terminals.filter(item => item.state === 'running').length;
  const visibleSlots = leafSlots(layout);
  const hiddenTerminals = slots.flatMap((terminal, index) => terminal && !visibleSlots.includes(index) ? [{ terminal, index }] : []);
  const zoomedIndex = slots.findIndex(item => item?.id === zoomed);
  const geometry = useMemo(() => layoutGeometry(zoomedIndex >= 0 ? { slot: zoomedIndex } : layout,
    viewportSize.width, viewportSize.height), [layout, zoomedIndex, viewportSize]);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  const selectPreset = (next: LayoutPreset) => {
    const count = next === 'six' ? 6 : next === 'twelve' ? 12 : next === 'main' ? 3 : 2;
    const active = slots.flatMap((item, index) => item ? [index] : []);
    const priority = slots[selectedSlot] ? [selectedSlot] : [];
    const ordered = [...new Set([...priority, ...active, ...visibleSlots, ...slots.map((_, index) => index)])].slice(0, count);
    setLayout(presetLayout(next, ordered));
    setPreset(next);
    setZoomed(null);
    setSelectedSlot(ordered[0]);
    setFocused(slots[ordered[0]]?.id ?? null);
    setActionError('');
  };

  const splitPane = (target: number, axis: 'x' | 'y', existing?: number) => {
    const available = slots.map((item, index) => ({ item, index })).filter(({ item, index }) => !item && index !== target && !opening[index]);
    const added = existing ?? available.find(({ index }) => !visibleSlots.includes(index))?.index ?? available[0]?.index;
    if (added === undefined) {
      setActionError('12 个终端位置已占满，请先关闭一个终端再分割。已有分隔线仍可拖动。');
      return;
    }
    const anchor = visibleSlots.includes(target) ? target : visibleSlots[0];
    setLayout(previous => splitSlot(previous, anchor, added, axis));
    setPreset('custom');
    setZoomed(null);
    setSelectedSlot(added);
    setFocused(slots[added]?.id ?? null);
    setActionError('');
  };

  const hideEmpty = (index: number) => {
    if (visibleSlots.length <= 1 || slots[index] || opening[index]) return;
    setLayout(previous => removeSlot(previous, index));
    setPreset('custom');
    if (selectedSlot === index) setSelectedSlot(visibleSlots.find(value => value !== index)!);
  };

  const dragSeparator = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const separator = geometryRef.current.separators.find(item => item.id === drag.separatorId);
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!separator || !bounds) return;
    const ratio = pointerRatio(separator, event.clientX - bounds.left, event.clientY - bounds.top);
    setLayout(previous => resizeSplit(previous, separator.id, ratio));
    setPreset('custom');
  };

  const endDrag = (pointerId?: number) => {
    if (pointerId !== undefined && dragRef.current?.pointerId !== pointerId) return;
    dragRef.current = null;
    setDragging(null);
  };

  useEffect(() => {
    const current = dragRef.current;
    if (current && !geometry.separators.some(separator => separator.id === current.separatorId)) {
      dragRef.current = null;
      setDragging(null);
    }
  }, [geometry]);

  const resizeWithKeyboard = (event: React.KeyboardEvent, separator: Separator) => {
    const decrease = separator.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const increase = separator.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    let ratio: number;
    if (event.key === decrease) ratio = separator.ratio - 0.05;
    else if (event.key === increase) ratio = separator.ratio + 0.05;
    else if (event.key === 'Home') ratio = separator.minRatio;
    else if (event.key === 'End') ratio = separator.maxRatio;
    else return;
    event.preventDefault();
    event.stopPropagation();
    setLayout(previous => resizeSplit(previous, separator.id, Math.min(separator.maxRatio, Math.max(separator.minRatio, ratio))));
    setPreset('custom');
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!event.altKey || !event.shiftKey) return;
    if (event.key === 'Enter' && focused) {
      event.preventDefault();
      event.stopPropagation();
      setZoomed(previous => previous === focused ? null : focused);
      return;
    }
    const directions = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const;
    const direction = directions[event.key as keyof typeof directions];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const allGeometry = layoutGeometry(layout, viewportSize.width, viewportSize.height);
    const occupied: Record<number, Rect> = Object.fromEntries(Object.entries(allGeometry.panes).filter(([index]) => slots[Number(index)]));
    const index = neighborSlot(occupied, selectedSlot, direction);
    if (index !== null && slots[index]) {
      setSelectedSlot(index);
      setFocused(slots[index]!.id);
      if (zoomed) setZoomed(slots[index]!.id);
    }
  };

  return (
    <div className={`dsh-terminal-workspace${showSmart ? ' has-assistant' : ''}`} data-session-id={sessionId} onKeyDownCapture={onKeyDown}>
      <style>{workspaceCss}</style>
      <style>{xtermCss}</style>
      <header className="dt-workspace-bar">
        <div className="dt-brand"><span className="dt-brand-mark">&gt;_</span><strong>DSH SuperTerminal</strong><span className="dt-brand-subtitle">WORKSPACE</span></div>
        <span className="dt-toolbar-spacer" />
        <button className="dt-toolbar-button" aria-pressed={showManager} onClick={() => setShowManager(value => !value)}>智能体管理</button>
        <button className="dt-toolbar-button" aria-pressed={showSmart} onClick={() => setShowSmart(value => !value)}>✦ 智能建议</button>
        <button className="dt-toolbar-button" aria-expanded={showSupervisor} onClick={() => setShowSupervisor(value => !value)}>Supervisor</button>
        <span className="dt-running-count"><i />{running} 运行 · {terminals.length} 终端</span>
        <label className="dt-layout-select">布局 <select aria-label="布局预设" value={preset}
          onChange={event => selectPreset(event.target.value as LayoutPreset)}>
          <option value="six">六宫格 · 2 × 3</option><option value="twelve">十二宫格 · 3 × 4</option>
          <option value="horizontal">左右双格</option><option value="vertical">上下双格</option>
          <option value="main">主次三格</option><option value="custom" disabled>自定义布局</option>
        </select></label>
        <div className="dt-layout-actions" aria-label="分割所选窗格">
          <button className="dt-toolbar-button" onClick={() => splitPane(selectedSlot, 'x')} title="在所选窗格右侧增加一个空窗格">左右分割</button>
          <button className="dt-toolbar-button" onClick={() => splitPane(selectedSlot, 'y')} title="在所选窗格下方增加一个空窗格">上下分割</button>
        </div>
        {zoomed && <button className="dt-toolbar-button" onClick={() => setZoomed(null)}>还原布局</button>}
        <button className="dt-toolbar-button" onClick={() => { void refresh(true); }} disabled={loading}>刷新列表</button>
      </header>
      <div className="dt-workspace-context"><span className="dt-context-label">工作目录</span><span className="dt-cwd" title={cwd}>{cwd || (loading ? '读取中…' : '暂不可用')}</span><span className="dt-context-hint">会话内独立进程</span></div>
      {showManager && <AgentManager bridge={bridge} onClose={() => setShowManager(false)} onLaunch={id => {
        const index = !slots[selectedSlot] && !opening[selectedSlot] && leafSlots(layout).includes(selectedSlot) ? selectedSlot : slots.findIndex((item, i) => !item && !opening[i] && leafSlots(layout).includes(i));
        if (index < 0) { setActionError('请先增加一个空窗格，再启动智能体'); setShowManager(false); return; }
        setShowManager(false); void open(index, id);
      }} />}
      {showSmart && <SmartAssistant bridge={bridge} onClose={() => setShowSmart(false)} />}
      {showSupervisor && <SupervisorPanel sessionId={sessionId} />}
      {(listError || actionError) && <div className="dt-workspace-notice" role="alert">{listError || actionError}</div>}
      {hiddenTerminals.length > 0 && <div className="dt-hidden-panes"><span>已收起 · 进程保留</span>{hiddenTerminals.map(({ terminal, index }) =>
        <button key={terminal.id} onClick={() => splitPane(selectedSlot, 'x', index)} title={`重新显示终端 ${index + 1}`}>
          {String(index + 1).padStart(2, '0')} {terminal.launcher}</button>)}
        <button onClick={() => selectPreset('twelve')}>显示全部</button>
      </div>}
      <div className={`dt-layout-viewport${dragging ? ' is-resizing' : ''}`} ref={viewportRef}>
      <div className="dt-layout-canvas" ref={canvasRef} style={{ width: geometry.width, height: geometry.height }}>
        {slots.map((terminal, index) => {
          const rect = geometry.panes[index];
          const visible = Boolean(rect);
          const style: React.CSSProperties = {
            display: visible ? undefined : 'none',
            left: rect?.x ?? 0, top: rect?.y ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0,
          };
          return <div className="dt-cell" key={terminal?.id ?? `empty-${index}`} style={style} aria-hidden={!visible}>
            {terminal ? <PaneBoundary><TerminalPane
              terminal={terminal} bridge={bridge} viewerId={viewerId} number={index + 1} connected={!listError}
              focused={focused === terminal.id} visible={visible} zoomed={zoomed === terminal.id}
              autoClaim={autoClaimIds.has(terminal.id)} onFocus={() => { setFocused(terminal.id); setSelectedSlot(index); }}
              onZoom={() => { setSelectedSlot(index); setFocused(terminal.id); setZoomed(previous => previous === terminal.id ? null : terminal.id); }}
              onSplit={axis => splitPane(index, axis)}
              onClosed={() => onClosed(terminal.id)} onState={(state, exitCode) => onState(terminal.id, state, exitCode)}
            /></PaneBoundary> : <div className={`dt-empty-pane${selectedSlot === index ? ' is-selected' : ''}`}
              onPointerDown={() => { setSelectedSlot(index); setFocused(null); }}>
              <span className="dt-empty-number">{String(index + 1).padStart(2, '0')}</span>
              {visibleSlots.length > 1 && <button className="dt-empty-hide" disabled={Boolean(opening[index])}
                aria-label={`收起空窗格 ${index + 1}`} title="收起此空窗格" onClick={() => hideEmpty(index)}>×</button>}
              <span className="dt-empty-prompt">&gt;_</span>
              <strong>{opening[index] === 'pending' ? '正在启动…' : opening[index] === 'uncertain' ? '等待确认启动结果' : '在这里，开始工作。'}</strong>
              <span className="dt-empty-description">选择一个智能体，或打开 Shell</span>
              <div className="dt-launchers">{launchers.filter(item => ['shell','codex','claude','kimi'].includes(item.id)).map(launcher => <button key={launcher.id}
                disabled={!launcher.available || Boolean(opening[index]) || loading || Boolean(listError)}
                title={launcher.available ? `启动 ${launcher.label}` : `${launcher.label} 尚未安装或不可用`}
                onClick={() => { void open(index, launcher.id); }}><AgentIcon launcher={launcher.id} /><span className="dt-launcher-name">{launcher.label}</span>{!launcher.available && <span>未安装</span>}</button>)}</div>
              <button className="dt-all-agents" onClick={() => setShowManager(true)}>全部智能体 <span>↗</span></button>
              <details className="dt-custom-disclosure"><summary>使用其他命令</summary><form className="dt-custom-cli" onSubmit={event => { event.preventDefault(); const command = customCli.trim(); if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(command)) void open(index, command); }}>
                <input aria-label={`窗格 ${index + 1} 的其他本地 CLI`} placeholder="其他本地 CLI，如 piagent" maxLength={64}
                  value={customCli} onChange={event => setCustomCli(event.target.value)} />
                <button disabled={!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(customCli.trim()) || Boolean(opening[index]) || loading || Boolean(listError)}>启动</button>
              </form></details>
              {loading && <span className="dt-empty-description">正在读取可用 CLI…</span>}
              {opening[index] === 'uncertain' && <button className="dt-toolbar-button" onClick={() => { void refresh(true); }}>刷新列表确认</button>}
            </div>}
          </div>;
        })}
        {geometry.separators.map(separator => <div key={separator.id}
          className={`dt-separator dt-separator-${separator.axis}${dragging === separator.id ? ' is-dragging' : ''}`}
          role="separator" tabIndex={0} aria-label={separator.axis === 'x' ? '左右窗格分隔线' : '上下窗格分隔线'}
          aria-orientation={separator.axis === 'x' ? 'vertical' : 'horizontal'}
          aria-valuemin={Math.round(separator.minRatio * 100)} aria-valuemax={Math.round(separator.maxRatio * 100)} aria-valuenow={Math.round(separator.ratio * 100)}
          title="拖动调整大小 · 方向键微调 · 双击均分"
          style={{ left: separator.rect.x, top: separator.rect.y, width: separator.rect.width, height: separator.rect.height }}
          onPointerDown={event => {
            if (event.button !== 0 || dragRef.current) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { pointerId: event.pointerId, separatorId: separator.id };
            setDragging(separator.id);
          }}
          onPointerMove={dragSeparator} onPointerUp={event => endDrag(event.pointerId)}
          onPointerCancel={event => endDrag(event.pointerId)} onLostPointerCapture={event => endDrag(event.pointerId)}
          onBlur={() => endDrag()}
          onDoubleClick={() => { setLayout(previous => resizeSplit(previous, separator.id, 0.5)); setPreset('custom'); }}
          onKeyDown={event => resizeWithKeyboard(event, separator)}
        />)}
      </div>
      </div>
      <footer className="dt-workspace-footer"><span>{viewportSize.width > 0 && geometry.width > viewportSize.width ? '布局可横向滚动 · ' : ''}拖动分隔线调大小 · Alt + Shift + 方向键切焦点 / Enter 放大</span><span>返回 DSH 保留画面 · 刷新页面后画面可能不完整 · × 结束进程</span></footer>
    </div>
  );
}

export function TerminalWorkspace(props: TerminalWorkspaceProps) {
  return <WorkspaceSession key={props.sessionId} {...props} />;
}
