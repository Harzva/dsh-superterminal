import themeCss from './terminal-theme.css';
import { useTerminalTheme } from './use-terminal-theme';
import { terminalThemeStore, TERMINAL_ACCENTS, type TerminalThemePreference } from './terminal-theme.mjs';
import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadWorkspaceMemory, saveWorkspaceMemory } from './workspace-memory.mjs';
import { AgentManager, SmartAssistant } from './agent-manager';
import { AgentIcon } from './agent-icon';
import { UiIcon } from './ui-icon';
import { assistantMemory, rememberedTerminalDrafts } from './assistant-memory';
import type { AssistantSeed } from './assistant-memory';
import { RemoteLauncher, REMOTE_AI_NOTICE } from './remote-launcher';
import type { RemoteDestination, TerminalExecution } from './types';
import { TerminalPane } from './terminal-pane';
import { workspaceShortcut } from './workspace-shortcut.mjs';
import { NativeTerminalTask } from './native-terminal-task';
import { SupervisorPanel } from './supervisor-panel';
import { HandoffPanel, HandoffSummary, useHandoffs } from './handoff-panel';
import type { HandoffSeed } from './handoff-panel';
import { TerminalGroupPanel, useTerminalGroups } from './terminal-group-panel';
import { layoutGeometry, leafSlots, neighborSlot, pointerRatio, presetLayout, removeSlot, resizeSplit, splitSlot } from './layout.mjs';
import type { LayoutPreset, LayoutTree, Rect, Separator } from './layout.mjs';
import type { TerminalBridge, TerminalLauncher, TerminalSummary } from './types';
import workspaceCss from './terminal-workspace.css';
import chromeCss from './workspace-chrome.css';
import handoffCss from './handoff.css';
import runCss from './terminal-run-panel.css';
import groupCss from './terminal-group-panel.css';
import xtermCss from '@xterm/xterm/css/xterm.css';

export type TerminalWorkspaceProps = { bridge: TerminalBridge; sessionId: string; active?: boolean; compact?: boolean; contextLabel?: string; conversationTitle?: string; onShowConversation?(): void; toolbarTrailing?: React.ReactNode };

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

function WorkspaceSession({ bridge, sessionId, active = true, compact = false, contextLabel = '关联对话', conversationTitle = '关联对话', onShowConversation, toolbarTrailing }: TerminalWorkspaceProps) {
  const appearance = useTerminalTheme();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const [memory] = useState(() => loadWorkspaceMemory(sessionId));
  const [records, setRecords] = useState<(null | { id: string; launcher: string; title: string; execution?: TerminalExecution })[]>(() => memory?.slots ?? Array(12).fill(null));
  const recordsRef = useRef(records); recordsRef.current = records;
  const [loaded, setLoaded] = useState(false);
  const [excerpt, setExcerpt] = useState<{terminalId:string;text:string} | undefined>();
  const [drafts, setDrafts] = useState<Record<string,{id:string;text:string}>>(() => rememberedTerminalDrafts(sessionId));
  const [viewerId] = useState(() => `viewer-${crypto.randomUUID()}`);
  const [slots, setSlots] = useState<(TerminalSummary | null)[]>(() => Array(12).fill(null));
  const [launchers, setLaunchers] = useState<TerminalLauncher[]>([]);
  const [layout, setLayout] = useState<LayoutTree | null>(() => memory ? memory.layout : {slot:0});
  const [preset, setPreset] = useState<LayoutPreset | 'custom'>(memory?.preset ?? 'custom');
  const [selectedSlot, setSelectedSlot] = useState(memory?.selectedSlot ?? 0);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; separatorId: string } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [naturalViews, setNaturalViews] = useState<Record<string, boolean>>({});
  const revealSlotRef = useRef<number | null>(null);
  const [revealRequest, setRevealRequest] = useState(0);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [autoClaimIds, setAutoClaimIds] = useState<Set<string>>(() => new Set());
  const [opening, setOpening] = useState<Record<number, 'pending' | 'uncertain'>>({});
  const [cwd, setCwd] = useState('');
  const [auxiliary, setAuxiliary] = useState<'agents' | 'assistant' | 'supervisor' | 'handoff' | 'groups' | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const [toolsOpened, setToolsOpened] = useState(false);
  const closeAuxiliary = () => {
    const trigger = Array.from(workspaceRef.current?.querySelectorAll<HTMLButtonElement>(`[data-auxiliary="${auxiliary}"]`) ?? [])
      .find(button => button.getClientRects().length > 0)
      ?? toolsRef.current?.querySelector<HTMLButtonElement>('.dt-tools-toggle');
    setAuxiliary(null);
    requestAnimationFrame(() => trigger?.focus());
  };
  useEffect(() => { setToolsOpened(false); }, [auxiliary]);
  useEffect(() => {
    if (!toolsOpened) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolsRef.current?.contains(event.target)) setToolsOpened(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [toolsOpened]);
  const showManager = auxiliary === 'agents', showSmart = auxiliary === 'assistant', showSupervisor = auxiliary === 'supervisor', showHandoff = auxiliary === 'handoff';
  const [assistantSeed, setAssistantSeed] = useState<AssistantSeed>();
  const [handoffSeed, setHandoffSeed] = useState<HandoffSeed>();
  const groups = useTerminalGroups(bridge, active);
  const [groupSeed, setGroupSeed] = useState<{request: number; terminalId: string; groupId?: string}>();
  const [groupDropTarget, setGroupDropTarget] = useState<string | null>(null);
  const [groupDragging, setGroupDragging] = useState(false);
  const showGroups = auxiliary === 'groups';
  const [readIssues, setReadIssues] = useState<Record<string, boolean>>({});
  const headingRef = useRef<HTMLDivElement>(null);
  const [helperTop, setHelperTop] = useState(112);
  useEffect(() => {
    const heading = headingRef.current;
    if (!heading) return;
    const measure = () => setHelperTop(heading.getBoundingClientRect().height);
    measure(); const observer = new ResizeObserver(measure); observer.observe(heading);
    return () => observer.disconnect();
  }, []);
  const [handoffOpenAt, setHandoffOpenAt] = useState<{section: 'form' | 'records'; request: number}>({section: 'form', request: 0});
  const [handoffSource, setHandoffSource] = useState<{id: string; launcher: string; title?: string; execution?: TerminalExecution}>();
  const handoffs = useHandoffs(bridge, active);
  const [launchLocations, setLaunchLocations] = useState<Record<number, 'local' | 'ssh'>>({});
  const [remoteSeeds, setRemoteSeeds] = useState<Record<number, RemoteDestination>>({});
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
          const remembered = recordsRef.current.findIndex(record => record?.id === item.id);
          const free = remembered >= 0 && !next[remembered] ? remembered : next.indexOf(null);
          if (free < 0) break;
          next[free] = item;
          existing.add(item.id);
        }
        return next;
      });
      setLoaded(true);
      setLaunchers(result.launchers);
      setCwd(result.cwd);
      setListError(active.length > 12 ? `当前有 ${active.length} 个终端，此视图只能展示 12 个。` : '');
      if (manual) {
        setOpening(previous => Object.fromEntries(Object.entries(previous).filter(([, value]) => value === 'pending')));
        setActionError('');
      }
    } catch (error) {
      if (aliveRef.current && sequence === listSequence.current) setListError(/Failed to fetch|NetworkError|fetch failed/i.test(errorText(error)) ? '终端服务连接中断，正在重连。已有画面暂存，输入暂停；请勿重复启动。' : '暂时无法加载终端列表，正在重试。');
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

  useEffect(() => {
    if (!loaded) return;
    setRecords(previous => previous.map((record,index) => slots[index] ? {id:slots[index]!.id, launcher:slots[index]!.launcher, execution:slots[index]!.execution, title:record?.id===slots[index]!.id ? record.title : ''} : record));
  }, [slots, loaded]);
  useEffect(() => {
    if (loaded) saveWorkspaceMemory(sessionId, { layout, preset, selectedSlot, slots:records });
  }, [sessionId, loaded, layout, preset, selectedSlot, records]);
  useEffect(() => {
    const id = slots[selectedSlot]?.id;
    const text = id ? assistantMemory(sessionId, id).getSnapshot().excerpt : '';
    setExcerpt(id && text ? {terminalId: id, text} : undefined);
  }, [sessionId, selectedSlot, slots[selectedSlot]?.id]);

  const open = async (index: number, launcher: string, remote?: RemoteDestination, showNatural = false) => {
    if (opening[index] || slots[index]) return;
    setOpening(previous => ({ ...previous, [index]: 'pending' }));
    setActionError('');
    mutationRef.current += 1;
    try {
      const terminal = await bridgeRef.current.open({ launcher, rows: 24, cols: 80, requestId: crypto.randomUUID(), ...(remote ? {remote} : {}) });
      if (!aliveRef.current) return;
      setNaturalViews(previous => ({...previous, [terminal.id]: !remote && showNatural}));
      mutationRef.current += 1;
      setSlots(previous => {
        if (previous.some(item => item?.id === terminal.id)) return previous;
        const next = [...previous];
        const target = next[index] === null ? index : next.indexOf(null);
        if (target >= 0) next[target] = terminal;
        return next;
      });
      setRecords(previous => previous.map((record,i) => i===index ? {id:terminal.id,launcher:terminal.launcher,execution:terminal.execution,title:record?.title ?? ''} : record));
      setAutoClaimIds(previous => new Set([...previous, terminal.id]));
      setFocused(terminal.id);
      setSelectedSlot(index);
      revealSlotRef.current = index;
      setRevealRequest(value => value + 1);
      setOpening(previous => {
        const next = { ...previous };
        delete next[index];
        return next;
      });
    } catch (error) {
      if (!aliveRef.current) return;
      setOpening(previous => ({ ...previous, [index]: 'uncertain' }));
      setActionError('尚未确认启动结果。请先刷新列表，确认终端是否已打开。');
    }
  };

  const onClosed = (id: string) => {
    setRecords(previous => previous.map(record => record?.id===id ? null : record));
    setReadIssues(previous => {const next = {...previous}; delete next[id]; return next;});
    setExcerpt(previous => previous?.terminalId===id ? undefined : previous);
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
  const selectedTerminal = slots[selectedSlot];
  const selectedExecution = selectedTerminal?.execution;
  const selectedCwd = selectedExecution?.cwd || cwd;
  const running = terminals.filter(item => item.state === 'running').length;
  const managerDestination = !slots[selectedSlot] && !opening[selectedSlot] ? selectedSlot : slots.findIndex((item, index) => !item && !opening[index]);
  const launchDisabledReason = listError ? '终端连接正在恢复，恢复后即可启动。'
    : loading ? '正在读取终端状态…'
    : managerDestination < 0 ? '终端位置已满，请先结束一个任务或等待启动完成。' : undefined;
  const openHandoff = (section: 'form' | 'records' = 'form') => {
    const source = slots[selectedSlot];
    setHandoffSource(source ? {id:source.id, launcher:source.launcher, execution:source.execution, title:records[selectedSlot]?.title} : undefined);
    setHandoffOpenAt(previous => ({section, request: previous.request + 1}));
    setAuxiliary('handoff');
  };
  const addToGroup = (terminalId: string, groupId?: string) => {
    const source = slots.find(terminal => terminal?.id === terminalId);
    if (!source) return;
    if (source.execution?.kind === 'ssh') {setActionError(REMOTE_AI_NOTICE);return;}
    if (groupId) groups.select(groupId);
    setGroupSeed(previous => ({request: (previous?.request ?? 0) + 1, terminalId, groupId}));
    setAuxiliary('groups');
  };
  const dropTerminal = (event: React.DragEvent, groupId?: string) => {
    event.preventDefault(); setGroupDropTarget(null); setGroupDragging(false);
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/x-dsh-terminal'));
      if (payload.sessionId !== sessionId || typeof payload.terminalId !== 'string') return;
      addToGroup(payload.terminalId, groupId);
    } catch { /* An unrelated drop is not a terminal invitation. */ }
  };
  const groupHandoff = (input: {groupId: string; sourceTerminalId: string; prompt: string; excerpt: string}) => {
    const index = slots.findIndex(terminal => terminal?.id === input.sourceTerminalId);
    const source = slots[index];
    if (!source) { setActionError('来源终端已关闭，请先选择组内可用的终端。'); return; }
    if (source.execution?.kind === 'ssh') {setActionError(REMOTE_AI_NOTICE);return;}
    setHandoffSource({id: source.id, launcher: source.launcher, execution:source.execution, title: records[index]?.title});
    setExcerpt({terminalId: source.id, text: input.excerpt});
    setHandoffSeed({id: crypto.randomUUID(), sessionId, sourceTerminalId: source.id, sourceGroupId: input.groupId, prompt: input.prompt, excerpt: input.excerpt});
    setHandoffOpenAt(previous => ({section: 'form', request: previous.request + 1}));
    setAuxiliary('handoff');
  };
  const openSelectionAction = (index: number, action: 'explain' | 'fix' | 'handoff' | 'execute', text: string) => {
    const terminal = slots[index];
    if (!terminal || !text.trim()) return;
    if (terminal.execution?.kind === 'ssh' && (action === 'execute' || action === 'handoff')) {setActionError(REMOTE_AI_NOTICE);return;}
    showSlot(index);
    const captured = text.slice(0, 4000);
    setExcerpt({terminalId: terminal.id, text: captured});
    assistantMemory(sessionId, terminal.id).update({excerpt: captured, share: true});
    if (action === 'execute') {
      assistantMemory(sessionId, terminal.id).update({runDraft: '请分析这段报错，检查当前项目，完成修复并验证结果。', runExcerpt: captured, runError: ''});
      setNaturalViews(previous => ({...previous, [terminal.id]: true})); setAuxiliary(null);
    } else if (action === 'handoff') {
      setHandoffSource({id: terminal.id, launcher: terminal.launcher, title: records[index]?.title});
      setHandoffSeed({id: crypto.randomUUID(), sessionId, sourceTerminalId: terminal.id, prompt: '请根据附上的终端内容，完成下一步任务，并给出结果和验证证据。', excerpt: captured});
      setHandoffOpenAt(previous => ({section: 'form', request: previous.request + 1}));
      setAuxiliary('handoff');
    } else {
      setAssistantSeed({id: crypto.randomUUID(), sessionId, terminalId: terminal.id, prompt: action === 'fix' ? '请分析这段输出中的问题，建议修复步骤和可验证的命令。' : '请解释这段终端输出，指出关键信息与下一步。', excerpt: captured});
      setAuxiliary('assistant');
    }
  };
  const visibleSlots = leafSlots(layout);
  const hiddenTerminals = slots.flatMap((terminal, index) => terminal && !visibleSlots.includes(index) ? [{ terminal, index }] : []);
  const showTerminalSwitcher = compact || Boolean(zoomed);
  const terminalNavigation = showTerminalSwitcher ? slots.flatMap((terminal, index) => terminal ? [{terminal, index}] : []) : hiddenTerminals;
  const navigationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = navigationRef.current;
    const selected = strip?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!strip || !selected) return;
    const rect = selected.getBoundingClientRect(), bounds = strip.getBoundingClientRect();
    if (rect.left < bounds.left) strip.scrollLeft -= bounds.left - rect.left;
    else if (rect.right > bounds.right) strip.scrollLeft += rect.right - bounds.right;
  }, [selectedSlot, compact, zoomed, terminalNavigation.length, viewportSize.width]);
  const zoomedIndex = slots.findIndex(item => item?.id === zoomed);
  const geometry = useMemo(() => layoutGeometry(zoomedIndex >= 0 ? { slot: zoomedIndex } : layout,
    viewportSize.width, viewportSize.height), [layout, zoomedIndex, viewportSize]);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  useEffect(() => {
    if (auxiliary) { revealSlotRef.current = null; return; }
    const index = revealSlotRef.current;
    const viewport = viewportRef.current;
    const rect = index == null ? undefined : geometry.panes[index];
    if (!active || !viewport || !rect) return;
    const frame = requestAnimationFrame(() => {
      if (revealSlotRef.current !== index) return;
      const left = rect.x < viewport.scrollLeft ? rect.x : rect.x + rect.width > viewport.scrollLeft + viewport.clientWidth ? rect.x + rect.width - viewport.clientWidth : viewport.scrollLeft;
      const top = rect.y < viewport.scrollTop ? rect.y : rect.y + rect.height > viewport.scrollTop + viewport.clientHeight ? rect.y + rect.height - viewport.clientHeight : viewport.scrollTop;
      viewport.scrollTo({left: Math.max(0, left), top: Math.max(0, top), behavior: 'auto'});
      const pane = canvasRef.current?.querySelector<HTMLElement>(`[data-slot-index="${index}"]`);
      const confirmation = pane?.querySelector('.dt-pane-confirm');
      const input = confirmation ? confirmation.querySelector<HTMLElement>('button:not(:disabled)') : pane?.querySelector<HTMLElement>('.dt-pane-natural[aria-hidden="false"] textarea:not(:disabled), .dt-pane-native[aria-hidden="false"] .xterm-helper-textarea, .dt-natural-start:not(:disabled), .dt-empty-invite:not(:disabled), .dt-restore-card button:not(:disabled)');
      input?.focus({preventScroll: true});
      revealSlotRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, geometry, selectedSlot, revealRequest, auxiliary]);

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
    revealSlotRef.current = added;
    setRevealRequest(value => value + 1);
    setActionError('');
  };

  const showSlot = (index: number, preserveZoom = false) => {
    setAuxiliary(null);
    setToolsOpened(false);
    revealSlotRef.current = index;
    setRevealRequest(value => value + 1);
    if (!visibleSlots.includes(index)) {
      setLayout(previous => previous ? splitSlot(previous, visibleSlots[0], index, 'x') : {slot:index});
      setPreset('custom');
    }
    setSelectedSlot(index); setFocused(slots[index]?.id ?? null);
    setZoomed(preserveZoom && zoomed ? slots[index]?.id ?? null : null);
  };
  const newTerminal = () => {
    const free = slots.findIndex((item,i) => !item && !opening[i] && !records[i]);
    const fallback = free >= 0 ? free : slots.findIndex((item,i) => !item && !opening[i]);
    if (fallback < 0) {setActionError('已打开 12 个终端，请先结束一个任务。'); return;}
    showSlot(fallback); setAuxiliary(null); void open(fallback, 'shell', undefined, true);
  };
  const hideTerminal = (index:number) => {
    setLayout(previous => removeSlot(previous,index)); setPreset('custom'); setZoomed(null);
    const next=visibleSlots.find(value=>value!==index);
    if(next!==undefined){setSelectedSlot(next);setFocused(slots[next]?.id??null)}else setFocused(null);
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
    const target = event.target instanceof Element ? event.target : null;
    const editing = Boolean(target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) && !target?.matches('.xterm-helper-textarea');
    const blocked = !active || Boolean(auxiliary) || Boolean(target?.closest('[role="dialog"],[role="alertdialog"]'));
    const action = workspaceShortcut({key:event.key, altKey:event.altKey, shiftKey:event.shiftKey, ctrlKey:event.ctrlKey, metaKey:event.metaKey,
      defaultPrevented:event.defaultPrevented, isComposing:event.nativeEvent.isComposing, keyCode:event.nativeEvent.keyCode}, blocked ? 'blocked' : editing ? 'editor' : 'terminal');
    if (!action) return;
    if (action === 'zoom') {
      if (!focused) return;
      event.preventDefault();
      event.stopPropagation();
      setZoomed(previous => previous === focused ? null : focused);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const allGeometry = layoutGeometry(layout, viewportSize.width, viewportSize.height);
    const occupied: Record<number, Rect> = Object.fromEntries(Object.entries(allGeometry.panes).filter(([index]) => slots[Number(index)]));
    const index = neighborSlot(occupied, selectedSlot, action);
    if (index !== null && slots[index]) {
      showSlot(index, Boolean(zoomed));
    }
  };

  return (
    <div ref={workspaceRef} data-dt-theme={appearance.resolved} data-dt-accent={appearance.accent} className={`dt-themed dsh-terminal-workspace dt-refined${showSmart ? ' has-assistant' : ''}${compact ? ' dt-compact' : ''}`} data-session-id={sessionId} style={{'--dt-helper-top': `${helperTop}px`} as React.CSSProperties} onKeyDownCapture={onKeyDown} onDragEnd={() => {setGroupDropTarget(null);setGroupDragging(false);}}>
      <style>{themeCss}</style>
      <style>{workspaceCss}</style>
      <style>{handoffCss}</style>
      <style>{runCss}</style>
      <style>{groupCss}</style>
      <style>{chromeCss}</style>
      <style>{xtermCss}</style>
      <div className="dt-workspace-heading" ref={headingRef}><header className="dt-workspace-bar">
        <div className="dt-brand"><span className="dt-brand-mark"><UiIcon name="terminal" size={21}/></span><strong>SuperTerminal</strong></div>
        <span className="dt-toolbar-spacer" />
        <button className="dt-toolbar-button dt-new-terminal" onClick={newTerminal} aria-label="新建终端"><UiIcon name="plus"/><span>新建终端</span></button>
        <button className="dt-toolbar-button" data-auxiliary="assistant" aria-label="助手" title="解释与建议" aria-pressed={showSmart} onClick={() => setAuxiliary(value => value === 'assistant' ? null : 'assistant')}><UiIcon name="sparkles"/><span>助手</span></button>
        <button className="dt-toolbar-button dt-handoff-entry" data-auxiliary="handoff" aria-label="协作" title="交给 Agent" aria-expanded={showHandoff} onClick={() => showHandoff ? closeAuxiliary() : openHandoff()}><UiIcon name="link"/><span>协作</span></button>
        <button className="dt-toolbar-button dt-groups-entry" data-auxiliary="groups" aria-label="讨论组" title="终端讨论组" aria-expanded={showGroups} onClick={() => setAuxiliary(value => value === 'groups' ? null : 'groups')}><UiIcon name="group"/><span>讨论组</span>{groups.groups.length > 0 && <small>{groups.groups.length}</small>}</button>
        <span className="dt-running-count" title={`${running} 个运行中的终端，共 ${terminals.length} 个终端`}><i className={running ? 'is-running' : ''}/>{running}</span>
        <div className="dt-toolbar-tools" ref={toolsRef} onBlur={event => {
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setToolsOpened(false);
        }} onKeyDown={event => {
          if (event.key !== 'Escape' || !toolsOpened) return;
          event.preventDefault(); event.stopPropagation(); setToolsOpened(false);
          toolsRef.current?.querySelector<HTMLButtonElement>('.dt-tools-toggle')?.focus();
        }}>
        <button className="dt-toolbar-button dt-tools-toggle" aria-label="更多终端操作" aria-expanded={toolsOpened}
          title="更多终端操作" onClick={() => setToolsOpened(value => !value)}><UiIcon name="more"/></button>
        {toolsOpened && <div className="dt-tools-popover" role="group" aria-label="更多终端操作" style={{maxHeight: Math.max(120, viewportSize.height)}}>
        <div className="dt-overflow-auxiliary">
          <button className="dt-toolbar-button" data-auxiliary="assistant" onClick={() => {setToolsOpened(false);setAuxiliary('assistant');}}><UiIcon name="sparkles"/><span>解释与建议</span></button>
          <button className="dt-toolbar-button" data-auxiliary="handoff" onClick={() => {setToolsOpened(false);openHandoff();}}><UiIcon name="link"/><span>交给 Agent</span></button>
          <button className="dt-toolbar-button" data-auxiliary="groups" onClick={() => {setToolsOpened(false);setAuxiliary('groups');}}><UiIcon name="group"/><span>终端讨论组</span></button>
        </div>
        <button className="dt-toolbar-button" aria-pressed={showManager} onClick={() => {setToolsOpened(false);setAuxiliary(value => value === 'agents' ? null : 'agents');}}>智能体管理</button>
        <button className="dt-toolbar-button" aria-pressed={showSupervisor} onClick={() => {setToolsOpened(false);setAuxiliary(value => value === 'supervisor' ? null : 'supervisor');}}>DSH Supervisor</button>
        <div className="dt-appearance">
          <div className="dt-appearance-label"><span>外观</span>{appearance.preference === 'system' && <small>当前{appearance.resolved === 'light' ? '浅色' : '深色'}</small>}</div>
          <div className="dt-appearance-options" role="group" aria-label="终端外观">
            {([['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']] as const).map(([value, label]) =>
              <button key={value} type="button" aria-pressed={appearance.preference === value}
                onClick={() => terminalThemeStore.setPreference(value as TerminalThemePreference)}>{label}</button>)}
          </div>
          <div className="dt-accent-label"><span>主题色</span><span>{TERMINAL_ACCENTS.find(item => item.id === appearance.accent)?.label}</span></div>
          <div className="dt-accent-options" role="group" aria-label="终端主题色">
            {TERMINAL_ACCENTS.map(({id, label, swatch}) => <button key={id} type="button"
              aria-label={`${label}主题色`} title={label} aria-pressed={appearance.accent === id}
              style={{'--dt-swatch': swatch} as React.CSSProperties} onClick={() => terminalThemeStore.setAccent(id)}>
              <span className="dt-accent-swatch">{appearance.accent === id && <UiIcon name="check" size={13}/>}</span>
            </button>)}
          </div>
        </div>
        {!compact && <div className="dt-tools-layout">
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
        </div>}
        <button className="dt-toolbar-button dt-refresh-list" onClick={() => {setToolsOpened(false);void refresh(true);}} disabled={loading}>刷新终端列表</button>
        </div>}
        </div>
        {toolbarTrailing && <div className="dt-window-actions">{toolbarTrailing}</div>}
      </header>
      <div className="dt-context-row">
      <div className="dt-project-identity" title={selectedCwd}><UiIcon name={selectedExecution?.kind === 'ssh' ? 'cloud' : 'folder'}/><span>{selectedExecution?.kind === 'ssh' ? selectedExecution.label : selectedCwd.split('/').filter(Boolean).at(-1) || (loading ? '读取中…' : '工作区')}</span>{selectedExecution?.kind === 'ssh' && <code>{selectedCwd}</code>}</div>
      <div className="dt-task-identity" aria-label="当前任务身份">
        <div><UiIcon name="chat"/><button disabled={!onShowConversation} onClick={onShowConversation} title={`${contextLabel} · ${conversationTitle}`}>{conversationTitle}</button></div>
        {auxiliary && slots[selectedSlot] && <div className="dt-current-target"><AgentIcon launcher={slots[selectedSlot]!.launcher}/><strong>{records[selectedSlot]?.title || slots[selectedSlot]!.launcher}</strong><span>#{String(selectedSlot + 1).padStart(2, '0')}</span></div>}
      </div>
      <HandoffSummary tasks={handoffs.tasks} onOpen={() => openHandoff('records')}/>
      </div>
      {terminalNavigation.length > 0 && (!showTerminalSwitcher || terminalNavigation.length > 1 || hiddenTerminals.length > 0) &&
        <div className="dt-terminal-navigation">
          {!showTerminalSwitcher && <span className="dt-navigation-label">已收起</span>}
          <div className="dt-terminal-switcher" ref={navigationRef} role="group" aria-label="切换终端">
            {terminalNavigation.map(({terminal, index}) => <button key={terminal.id} type="button"
              aria-pressed={selectedSlot === index} aria-label={`切换到终端 ${index + 1}：${records[index]?.title || terminal.launcher}`}
              onClick={() => showSlot(index, showTerminalSwitcher)} title={`${records[index]?.title || terminal.launcher} · 终端 ${index + 1}`}>
              <AgentIcon launcher={terminal.launcher}/><span className="dt-navigation-number">{String(index + 1).padStart(2, '0')}</span>
              <span className="dt-navigation-title">{records[index]?.title || terminal.launcher}</span>
            </button>)}
          </div>
          {!showTerminalSwitcher && <button className="dt-navigation-all" onClick={() => selectPreset(terminals.length <= 2 ? 'horizontal' : terminals.length <= 3 ? 'main' : terminals.length <= 6 ? 'six' : 'twelve')}>显示全部</button>}
        </div>}
      {(showGroups || groupDragging) && <div className="dt-group-strip" aria-label="终端讨论组">
        {groups.groups.map(group => <button type="button" key={group.id}
          className={`${showGroups && groups.selectedId === group.id ? 'is-selected' : ''}${groupDropTarget === group.id ? ' is-drop-target' : ''}`}
          onClick={() => {groups.select(group.id);setAuxiliary('groups');}}
          onDragOver={event => {if (event.dataTransfer.types.includes('application/x-dsh-terminal')) {event.preventDefault();event.dataTransfer.dropEffect = 'copy';setGroupDropTarget(group.id);}}}
          onDragLeave={() => setGroupDropTarget(null)} onDrop={event => dropTerminal(event, group.id)}
          title={`打开 ${group.title}，${group.members.length} 个参会终端`}>
          <span className={`dt-group-status-dot${group.status === 'running' ? ' is-running' : ''}`}/><span>{group.title}</span><small>{group.members.length}</small>
        </button>)}
        <button type="button" className={`dt-group-create-drop${groupDropTarget === 'new' ? ' is-drop-target' : ''}`}
          onClick={() => {groups.select(undefined);setAuxiliary('groups');}}
          onDragOver={event => {if (event.dataTransfer.types.includes('application/x-dsh-terminal')) {event.preventDefault();event.dataTransfer.dropEffect='copy';setGroupDropTarget('new');}}}
          onDragLeave={() => setGroupDropTarget(null)} onDrop={event => dropTerminal(event)}>
          <UiIcon name="plus"/> 新建讨论组</button>
      </div>}
      </div>
      <TerminalGroupPanel bridge={bridge} state={groups} opened={showGroups} seed={groupSeed} excerpt={excerpt}
        terminals={terminals.map(terminal => {const index = slots.findIndex(item => item?.id === terminal.id); return {...terminal, title: records[index]?.title, number: index + 1};})}
        onClose={closeAuxiliary} onHandoff={groupHandoff}
        onShowTerminal={id => {const index = slots.findIndex(item => item?.id === id); if(index < 0) return false; showSlot(index); return true;}}/>
      <HandoffPanel bridge={bridge} sessionId={sessionId} conversationTitle={conversationTitle}
        source={handoffSource} availableTerminalIds={terminals.map(item => item.id)}
        excerpt={excerpt} tasks={handoffs.tasks} targets={handoffs.targets} error={handoffs.error} loaded={handoffs.loaded}
        opened={showHandoff} openAt={handoffOpenAt} seed={handoffSeed} onClose={closeAuxiliary} refresh={handoffs.refresh}
        onShowTerminal={id => { const index = slots.findIndex(item => item?.id === id); if (index < 0) return false; showSlot(index); return true; }}
        onShowConversation={onShowConversation}/>
      {showManager && <AgentManager bridge={bridge} destination={managerDestination + 1} launchDisabledReason={launchDisabledReason} onClose={closeAuxiliary} onLaunch={id => {
        const index = managerDestination;
        if (launchDisabledReason || index < 0) return;
        showSlot(index); setAuxiliary(null); void open(index, id);
      }} />}
      {showSmart && <SmartAssistant bridge={bridge} sessionId={sessionId} conversationTitle={conversationTitle} contextLabel={contextLabel} connected={!listError} seed={assistantSeed} onClose={closeAuxiliary}
        target={slots[selectedSlot] ? {id:slots[selectedSlot]!.id,launcher:slots[selectedSlot]!.launcher,title:records[selectedSlot]?.title,number:selectedSlot+1,execution:slots[selectedSlot]!.execution} : undefined}
        excerpt={excerpt} onClearExcerpt={()=>setExcerpt(undefined)} onDraft={(targetId,text)=>{
          const index=slots.findIndex(item=>item?.id===targetId);
          if(index<0){setActionError('目标终端已关闭，请重新选择。');return;}
          const draft = {id:crypto.randomUUID(),text}; assistantMemory(sessionId, targetId).update({terminalDraft:draft});
          setNaturalViews(previous => ({...previous, [targetId]: false}));
          setDrafts(previous=>({...previous,[targetId]:draft}));showSlot(index);
        }} />}
      {showSupervisor && <SupervisorPanel sessionId={sessionId} tasks={handoffs.tasks} groups={groups.groups}
        onOpenGroup={id => {groups.select(id);setAuxiliary('groups');}} onOpenHandoffs={() => openHandoff('records')} />}
      {(listError || terminals.some(item => readIssues[item.id]) || actionError) && <div className="dt-workspace-notice dt-connection-status" role="status"><span>{listError || (terminals.some(item => readIssues[item.id]) ? `终端 ${slots.flatMap((item,index) => item && readIssues[item.id] ? [String(index+1).padStart(2,'0')] : []).join('、')} 正在恢复连接，画面与草稿已保留，相关终端暂停输入。` : actionError)}</span><button disabled={loading} onClick={() => { void refresh(true); }}>重新检查</button></div>}
      {visibleSlots.length===0 && <div className="dt-all-hidden"><span>终端已收起，任务继续运行。</span><button onClick={newTerminal}>新建终端</button></div>}
      <div className={`dt-layout-viewport${dragging ? ' is-resizing' : ''}`} ref={viewportRef}>
      <div className="dt-layout-canvas" ref={canvasRef} style={{ width: geometry.width, height: geometry.height }}>
        {slots.map((terminal, index) => {
          const rect = geometry.panes[index];
          const visible = Boolean(rect);
          const isRemote = terminal?.execution?.kind === 'ssh';
          const naturalOpen = terminal && !isRemote ? (naturalViews[terminal.id] ?? terminal.launcher === 'shell') : false;
          const style: React.CSSProperties = {
            display: visible ? undefined : 'none',
            left: rect?.x ?? 0, top: rect?.y ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0,
          };
          return <div className="dt-cell" data-slot-index={index} key={terminal?.id ?? `empty-${index}`} style={style} aria-hidden={!visible}>
            {terminal ? <PaneBoundary><TerminalPane theme={appearance.resolved} accent={appearance.accent}
              terminal={terminal} bridge={bridge} viewerId={viewerId} number={index + 1} connected={!listError}
              onAddToGroup={isRemote ? undefined : () => addToGroup(terminal.id, groups.selectedId)}
              onGroupDragStart={isRemote ? undefined : event => {setGroupDragging(true);event.dataTransfer.effectAllowed = 'copy';event.dataTransfer.setData('application/x-dsh-terminal', JSON.stringify({sessionId,terminalId:terminal.id}));}}
              naturalOpen={naturalOpen} onNaturalToggle={value => {setNaturalViews(previous => ({...previous, [terminal.id]: value})); if (value) setAuxiliary(null);}}
              naturalContent={isRemote ? undefined : <NativeTerminalTask bridge={bridge} sessionId={sessionId}
                target={{id: terminal.id, launcher: terminal.launcher, title: records[index]?.title, number: index + 1}}
                active={active && visible && naturalOpen} connected={!listError}
                onOpenTerminal={() => setNaturalViews(previous => ({...previous, [terminal.id]: false}))}/>}
              focused={focused === terminal.id} visible={visible && active} zoomed={zoomed === terminal.id}
              autoClaim={autoClaimIds.has(terminal.id)} onFocus={() => { if (!visible || !active) return; setFocused(terminal.id); setSelectedSlot(index); }}
              onZoom={() => { setSelectedSlot(index); setFocused(terminal.id); setZoomed(previous => previous === terminal.id ? null : terminal.id); }}
              title={records[index]?.id===terminal.id ? records[index]?.title : ''}
              onTitleChange={title=>setRecords(previous=>previous.map((record,i)=>i===index?{id:terminal.id,launcher:terminal.launcher,execution:terminal.execution,title}:record))}
              onHide={()=>hideTerminal(index)} draft={drafts[terminal.id]}
              onSelection={text=>{
                if (!text) return;
                const saved = assistantMemory(sessionId, terminal.id);
                if (saved.getSnapshot().excerpt !== text) saved.update({excerpt:text,share:false});
                if(index===selectedSlot) setExcerpt({terminalId:terminal.id,text});
              }}
              onSelectionAction={(action,text) => openSelectionAction(index, action, text)} centralizedStatus
              onReadStatus={failed => setReadIssues(previous => previous[terminal.id] === failed ? previous : {...previous, [terminal.id]: failed})}
              onSplit={axis => splitPane(index, axis)}
              onReconnected={updated => {mutationRef.current += 1;setSlots(previous=>previous.map(item=>item?.id===updated.id?updated:item));}}
              onClosed={() => onClosed(terminal.id)} onState={(state, exitCode) => onState(terminal.id, state, exitCode)}
            /></PaneBoundary> : <div className={`dt-empty-pane${selectedSlot === index ? ' is-selected' : ''}`}
              onPointerDown={event => { if(event.target === event.currentTarget) {setSelectedSlot(index);setFocused(null);} }}>
              <span className="dt-empty-number">{String(index + 1).padStart(2, '0')}</span>
              {visibleSlots.length > 1 && <button className="dt-empty-hide" disabled={Boolean(opening[index])}
                aria-label={`收起空窗格 ${index + 1}`} title="收起此窗格" onClick={() => hideEmpty(index)}><UiIcon name="close" size={14}/></button>}
              {loaded && records[index] && <div className="dt-restore-card"><strong>{records[index]!.title || records[index]!.launcher}</strong>{records[index]!.execution?.kind === 'ssh' ? <><p>远端 · {records[index]!.execution!.label}<br/>{records[index]!.execution!.cwd}</p><p>远端记录已保留。请重新选择主机并检查连接；这里不会自动重启原任务。</p><button disabled={Boolean(opening[index])||Boolean(listError)} onClick={() => {const saved = records[index]!.execution!;setLaunchLocations(previous=>({...previous,[index]:'ssh'}));if(saved.targetId)setRemoteSeeds(previous=>({...previous,[index]:{targetId:saved.targetId!,cwd:saved.cwd}}));setRecords(previous=>previous.map((item,i)=>i===index?null:item));}}>重新选择远端</button></> : <><p>已保留任务名称与布局。重新启动将打开一个新终端。</p><button disabled={Boolean(opening[index])||Boolean(listError)} onClick={()=>{void open(index,records[index]!.launcher)}}>重新启动</button></>}<button onClick={()=>setRecords(previous=>previous.map((item,i)=>i===index?null:item))}>移除记录</button></div>}
              {!(loaded && records[index]) && (selectedSlot !== index && !opening[index] ?
                <button className="dt-empty-invite" aria-label={`在窗格 ${index + 1} 选择终端`} onClick={() => {setSelectedSlot(index);setFocused(null);}}>
                  <span><UiIcon name="plus" size={23}/></span><strong>添加终端</strong>
                </button> : <div className="dt-launch-card">
                <div className="dt-launch-location" role="group" aria-label={`终端 ${index + 1} 执行位置`}>{([['local','本机'],['ssh','SSH']] as const).map(([location,label]) => <button key={location} type="button" aria-label={location === 'ssh' ? 'SSH 远程' : '本机'} aria-pressed={(launchLocations[index] ?? 'local') === location} disabled={Boolean(opening[index])} onClick={() => setLaunchLocations(previous=>({...previous,[index]:location}))}><UiIcon name={location === 'ssh' ? 'cloud' : 'monitor'} size={14}/>{label}</button>)}</div>
                {launchLocations[index] === 'ssh' ? <RemoteLauncher bridge={bridge} initial={remoteSeeds[index]} launchState={opening[index]} onDestinationChange={destination=>setRemoteSeeds(previous=>({...previous,[index]:destination}))} disabled={Boolean(opening[index]) || loading || Boolean(listError)} onLaunch={(launcher,remote)=>{void open(index,launcher,remote);}}/> : <>
                <h2 className="dt-launch-title">{opening[index] === 'pending' ? '正在启动…' : opening[index] === 'uncertain' ? '等待启动结果' : '从这里开始'}</h2>
                <button className="dt-natural-start" aria-label="打开 AI 终端" disabled={Boolean(opening[index]) || loading || Boolean(listError)} onClick={() => {void open(index, 'shell', undefined, true);}}><UiIcon name="sparkles" size={19}/><span>AI 任务</span><UiIcon name="arrowUpRight" size={17}/></button>
                <div className="dt-launch-separator"><span>或使用 CLI</span></div>
                <div className="dt-launchers dt-launch-favorites">{launchers.filter(item => ['shell','codex','claude','kimi'].includes(item.id)).map(launcher => <button key={launcher.id}
                  disabled={!launcher.available || Boolean(opening[index]) || loading || Boolean(listError)}
                  title={launcher.available ? `启动 ${launcher.label}` : `${launcher.label} 尚未安装或不可用`}
                  onClick={() => { void open(index, launcher.id); }}><span className="dt-launch-icon"><AgentIcon launcher={launcher.id}/></span><span className="dt-launcher-name">{launcher.id === 'claude' ? 'Claude' : launcher.id === 'kimi' ? 'Kimi' : launcher.label}</span></button>)}</div>
                <div className="dt-launch-secondary"><button className="dt-all-agents" onClick={() => setAuxiliary('agents')}>全部智能体<UiIcon name="chevronRight" size={13}/></button>
                <details className="dt-custom-disclosure"><summary>运行命令</summary><form className="dt-custom-cli" onSubmit={event => { event.preventDefault(); const command = customCli.trim(); if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(command)) void open(index, command); }}>
                  <input aria-label={`窗格 ${index + 1} 的其他本地 CLI`} placeholder="CLI 名称，如 piagent" maxLength={64}
                    value={customCli} onChange={event => setCustomCli(event.target.value)} />
                  <button disabled={!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(customCli.trim()) || Boolean(opening[index]) || loading || Boolean(listError)}>启动</button>
                </form></details></div></>}
                </div>)}
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
      <footer className="dt-workspace-footer"><span>{visibleSlots.length} 个窗格{viewportSize.width > 0 && geometry.width > viewportSize.width ? ' · 可横向滚动' : ''}</span><details className="dt-shortcuts"><summary><UiIcon name="command" size={12}/>快捷键</summary><div><span>调整大小 <b>拖动分隔线</b></span><span>切换终端 <b>Alt + Shift + 方向键</b></span><span>放大终端 <b>Alt + Shift + Enter</b></span></div></details></footer>
    </div>
  );
}

export function TerminalWorkspace(props: TerminalWorkspaceProps) {
  return <WorkspaceSession key={props.sessionId} {...props} />;
}
