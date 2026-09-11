import React, {useEffect} from 'react';
import {assistantMemory} from './assistant-memory';
import {NativeRunPanel} from './terminal-run-panel';
import type {NativeRunTarget} from './terminal-run-panel';
import type {NativeTaskState, TerminalBridge} from './types';

const idle: NativeTaskState = {terminalId: '', status: 'idle', messages: []};

export function NativeTerminalTask({bridge, sessionId, target, active, connected, onOpenTerminal}: {
  bridge: TerminalBridge; sessionId: string; target: NativeRunTarget; active: boolean;
  connected: boolean; onOpenTerminal(): void;
}) {
  const memory = React.useMemo(() => assistantMemory(sessionId, target.id), [sessionId, target.id]);
  const value = React.useSyncExternalStore(memory.subscribe, memory.getSnapshot, memory.getSnapshot);
  const [available, setAvailable] = React.useState(true);
  const commit = React.useCallback((state: NativeTaskState) => {
    if (state.terminalId !== target.id) return;
    memory.update(current => {
      const pending = current.runPending;
      const acknowledged = pending && state.acceptedRequestIds?.includes(pending.requestId);
      const stopped = current.runErrorKind === 'stop' && state.canStop === false;
      return {runState: state, ...(stopped ? {runError: '', runErrorKind: undefined} : {}), ...(acknowledged ? {
        runError: '',
        runPending: undefined, runDraft: current.runDraft?.trim() === pending.prompt ? '' : current.runDraft,
        runExcerpt: current.runExcerpt === pending.excerpt ? undefined : current.runExcerpt,
      } : {})};
    });
  }, [memory, target.id]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const revision = memory.getSnapshot().runRevision ?? 0;
      try {
        const state = await bridge.runState({terminalId: target.id});
        if (stopped) return;
        setAvailable(true);
        if (revision === (memory.getSnapshot().runRevision ?? 0) && !memory.getSnapshot().runBusy) commit(state);
      } catch { if (!stopped) setAvailable(false); }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 1000);
    };
    if (active && connected) void poll();
    return () => {stopped = true; clearTimeout(timer);};
  }, [bridge, target.id, active, connected, memory, commit]);

  const send = async (prompt: string) => {
    const saved = memory.getSnapshot();
    if (saved.runBusy) return;
    const pending = saved.runPending;
    if (pending && pending.prompt !== prompt) {
      memory.update({runError: '上一次发送仍待确认。请先保留原问题重试，确认后再提交新要求。'});
      return;
    }
    const input = pending ?? {terminalId: target.id, requestId: crypto.randomUUID(), prompt,
      ...(saved.runExcerpt ? {excerpt: saved.runExcerpt} : {})};
    memory.update({runPending: input, runBusy: true, runError: '', runRevision: (saved.runRevision ?? 0) + 1});
    try {
      const state = await bridge.runSend(input);
      commit(state);
      // The admitted request is idempotent even when it has not reached the next step yet.
      memory.update(current => ({runPending: undefined, runDraft: current.runDraft?.trim() === prompt ? '' : current.runDraft,
        runExcerpt: current.runExcerpt === input.excerpt ? undefined : current.runExcerpt}));
    } catch (error) {
      const rejected = (error instanceof Error ? error.message : '').match(/\[RUN_REJECTED\]([^\n]*)/);
      memory.update(rejected ? {runPending: undefined, runErrorKind: 'send', runError: rejected[1].trim().slice(0, 500) || '本次任务尚未开始，请调整后再试。'} : {
        runErrorKind: 'send',
        runError: '发送尚未确认，问题已保留。核对上次发送可确认同一请求，避免重复执行。',
      });
    } finally {memory.update({runBusy: false});}
  };
  const stop = async () => {
    if (memory.getSnapshot().runBusy) return;
    memory.update(current => ({runBusy: true, runError: '', runRevision: (current.runRevision ?? 0) + 1}));
    try {commit(await bridge.runStop({terminalId: target.id}));}
    catch {memory.update({runErrorKind: 'stop', runError: '停止尚未确认，请重试停止。当前记录和草稿已保留。'});}
    finally {memory.update({runBusy: false});}
  };

  return <NativeRunPanel readResult={bridge.runResult} target={target} state={{...(value.runState ?? idle), error: value.runError || value.runState?.error}}
    draft={value.runDraft ?? ''} onDraftChange={runDraft => memory.update(current => ({runDraft, runError: current.runPending ? current.runError : ''}))}
    onSend={send} onStop={stop} busy={value.runBusy} connected={connected && available} showRecoveryNotice={connected}
    pendingSend={Boolean(value.runPending)} onRetrySend={() => {const pending = memory.getSnapshot().runPending; if (pending) return send(pending.prompt);}}
    sharedExcerpt={value.runExcerpt ? {terminalId: target.id, text: value.runExcerpt} : undefined}
    onClearExcerpt={() => memory.update({runExcerpt: undefined})} onOpenTerminal={onOpenTerminal}/>;
}
