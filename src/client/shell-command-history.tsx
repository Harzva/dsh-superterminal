import React, { useEffect, useRef, useState } from 'react';
import type { CommandRecord, CommandSnapshot, TerminalBridge } from './types';

const duration = (record: CommandRecord) => {
  const value = record.durationMs ?? Math.max(0, Date.now() - record.startedAt);
  return value < 1000 ? `${Math.round(value)} ms` : value < 60000 ? `${(value / 1000).toFixed(1)} 秒` : `${Math.floor(value / 60000)} 分 ${Math.round(value % 60000 / 1000)} 秒`;
};
export function ShellCommandHistory({bridge, terminalId, connected, visible, onExplain}: {
  bridge: TerminalBridge; terminalId: string; connected: boolean; visible: boolean; onExplain(text: string): void;
}) {
  const [opened, setOpened] = useState(false);
  const [snapshot, setSnapshot] = useState<CommandSnapshot>();
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string>();
  const [copied, setCopied] = useState<Record<string, 'copied' | 'failed'>>({});
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!opened || !visible || !connected) return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const value = await bridge.commands({terminalId, lastN: 20});
        if (stopped) return;
        if (value.terminalId !== terminalId) throw new Error('wrong terminal');
        setSnapshot(value); setError('');
      } catch { if (!stopped) setError('命令记录暂时无法更新，正在重试。'); }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 1500);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [bridge, terminalId, opened, connected, visible]);
  const copy = async (record: CommandRecord) => {
    try {
      await navigator.clipboard.writeText(record.command);
      if (alive.current) setCopied(value => ({...value, [record.id]: 'copied'}));
    } catch { if (alive.current) setCopied(value => ({...value, [record.id]: 'failed'})); }
  };
  return <section className={`dt-shell-history${opened ? ' is-open' : ''}`} aria-label="Shell 命令记录">
    <button className="dt-shell-history-toggle" aria-expanded={opened} onClick={() => setOpened(value => !value)}><span>命令记录 {snapshot?.records.length ? `· ${snapshot.records.length}` : ''}</span><span>{opened ? '收起 ↑' : '查看 ↓'}</span></button>
    {opened && <div className="dt-shell-history-scroll">
      {(error || !connected) && <p role="status">{connected ? error : '连接恢复后继续更新，已有记录保留。'}</p>}
      {!snapshot && !error && connected && <p role="status">正在读取命令边界…</p>}
      {snapshot?.reason && <p>{snapshot.reason}</p>}
      {snapshot?.status === 'ready' && !snapshot.records.length && <p>在这个 Shell 中运行命令后，这里会记录输出、用时和退出状态。</p>}
      {snapshot?.truncated && <p>仅保留最近的命令记录。</p>}
      {[...(snapshot?.records ?? [])].reverse().map(record => <article key={record.id} className={`dt-shell-command is-${record.status}`}>
        <button className="dt-shell-command-main" aria-expanded={expanded === record.id} onClick={() => setExpanded(value => value === record.id ? undefined : record.id)}>
          <code>{record.command || '命令文本未捕获'}{record.commandTruncated ? '…' : ''}</code>
          <span>{record.status === 'running' ? '运行中' : record.status === 'interrupted' ? '已中断' : `退出 ${record.exitCode ?? '未知'}`} · {duration(record)}</span>
        </button>
        {expanded === record.id && <div className="dt-shell-command-output">
          <pre aria-label="命令原文">{record.command}</pre>
          <div><button onClick={() => { void copy(record); }}>{copied[record.id] === 'copied' ? '已复制' : '复制命令'}</button>
            {record.status === 'failed' && <button onClick={() => onExplain(`请解释这条 Shell 命令的失败，并建议修复方法。\n命令：${record.command.slice(0, 800)}\n退出码：${record.exitCode}\n输出${record.output.length > 3000 ? '（末尾摘录）' : ''}：\n${record.output.slice(-3000)}`)}>解释失败</button>}</div>
          {copied[record.id] === 'failed' && <p role="status">复制失败，可选中上方命令手动复制。</p>}
          <pre aria-label="命令输出">{record.output || (record.status === 'running' ? '等待输出…' : '没有文本输出。')}</pre>
          {record.outputTruncated && <p>输出已截取，请结合终端中的完整记录检查。</p>}
        </div>}
      </article>)}
    </div>}
  </section>;
}
