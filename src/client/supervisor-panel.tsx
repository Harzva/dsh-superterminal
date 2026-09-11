import React, { useEffect, useState } from 'react';
import { handoffStatus } from './handoff-panel';
import type { HandoffTask } from './types';
import type { GroupSummary } from './group-types';

type State = { suggestion?: string; suggestError?: string; suggesting?: boolean; mode?: string };
export function SupervisorPanel({ sessionId, tasks = [], groups = [], onOpenGroup, onOpenHandoffs }: { sessionId: string; tasks?: HandoffTask[]; groups?: GroupSummary[]; onOpenGroup?(id: string): void; onOpenHandoffs?(): void }) {
  const [state, setState] = useState<State>({});
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => controller.abort(), 45000);
    setBusy(true); setError('');
    const read = async () => {
      const response = await fetch(`/dsh-supervisor/states?ids=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
      if (!response.ok) throw new Error('当前实例的 DSH Supervisor 暂不可用');
      const result = await response.json();
      const next = result.states?.[sessionId];
      if (!next || typeof next !== 'object') throw new Error('未找到当前会话的监督状态');
      const checked: State = { suggestion: typeof next.suggestion === 'string' ? next.suggestion.slice(0, 4000) : '',
        suggestError: next.suggestError ? '暂时无法生成建议，请稍后重试。' : '', suggesting: next.suggesting === true };
      if (!controller.signal.aborted) setState(checked);
      return checked;
    };
    const run = async () => {
      try {
        if (round > 0) {
          const response = await fetch('/dsh-supervisor/regen', { method: 'POST', signal: controller.signal,
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) });
          if (!response.ok) throw new Error('生成请求未确认，请稍后重新查看状态');
        }
        const started = Date.now();
        const poll = async () => {
          try {
            const next = await read();
            if (controller.signal.aborted) return;
            if ((round > 0 && !next.suggestion && !next.suggestError && Date.now() - started < 30000) || next.suggesting) {
              timer = setTimeout(() => { void poll(); }, 1000);
            } else { clearTimeout(timeout); setBusy(false); }
          } catch (cause) { if (!controller.signal.aborted) { clearTimeout(timeout); setError('暂时无法读取建议，请稍后重试。'); setBusy(false); } }
        };
        await poll();
      } catch (cause) { if (!controller.signal.aborted) { clearTimeout(timeout); setError('暂时无法生成建议，请稍后重试。'); setBusy(false); } }
    };
    const onTimeout = () => { setBusy(false); setError('本次读取已超时，可关闭后重新查看；不会自动重新请求模型。'); };
    controller.signal.addEventListener('abort', onTimeout, { once: true });
    void run();
    return () => { clearTimeout(timeout); clearTimeout(timer); controller.signal.removeEventListener('abort', onTimeout); controller.abort(); };
  }, [sessionId, round]);
  return <aside className="dt-supervisor-panel" aria-label="DSH Supervisor">
    <div><strong>DSH Supervisor</strong><span>当前会话 · 运行状态</span>
      <button className="dt-toolbar-button" disabled={busy} onClick={() => setRound(value => value + 1)}>{busy ? '读取中…' : '生成一次建议'}</button></div>
    <p role="status">{error || state.suggestError || state.suggestion || (busy ? '正在读取监督状态…' : '尚无建议。点击生成时会使用 DSH 已配置的模型。')}</p>
    {groups.length > 0 && <section className="dt-supervisor-handoffs" aria-label="讨论组进展"><strong>讨论与落实</strong>
      {groups.slice(0, 6).map(group => <button key={group.id} onClick={() => onOpenGroup?.(group.id)} disabled={!onOpenGroup}>
        <span>{group.title} · {group.members.length} 位成员</span><span>{({idle:'尚未开始',running:'正在讨论',completed:'本轮已结束',failed:'需要处理',cancelled:'已停止',interrupted:'已中断'} as const)[group.status]}</span>
      </button>)}
      <small>展示讨论组的实际运行状态；会议结论仍需核对后落实。</small>
    </section>}
    {tasks.length > 0 && <section className="dt-supervisor-handoffs" aria-label="Supervisor 协作关系"><strong>谁在帮助谁</strong>
      {[...tasks].sort((a,b) => b.createdAt-a.createdAt).slice(0,4).map(task => <button key={task.id} onClick={onOpenHandoffs}>
        <span>{task.parentTaskId ? '↳ 返工 · ' : ''}{task.sourceLauncher} → {task.targetLauncher}</span><span>{handoffStatus(task)}</span></button>)}</section>}
    <small>根据任务目标、运行状态与协作关系提供建议。Agent 返回结果后，仍需结合目标验收。</small>
  </aside>;
}
