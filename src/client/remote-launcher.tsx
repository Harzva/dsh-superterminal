import React, { useEffect, useRef, useState } from 'react';
import { AgentIcon } from './agent-icon';
import type { RemoteCheck, RemoteDestination, RemoteTargets, TerminalBridge } from './types';

export const REMOTE_AI_NOTICE = 'DSH AI 尚未连接远端工作区，请使用远端 Agent CLI。';

export function RemoteLauncher({bridge, disabled, initial, launchState, onDestinationChange, onLaunch}: {
  bridge: TerminalBridge; disabled: boolean; initial?: RemoteDestination;
  launchState?: 'pending' | 'uncertain';
  onDestinationChange?(destination: RemoteDestination): void;
  onLaunch(launcher: string, remote: RemoteDestination): void;
}) {
  const [inventory, setInventory] = useState<RemoteTargets>();
  const [targetId, setTargetId] = useState(initial?.targetId ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '~');
  const [result, setResult] = useState<RemoteCheck>();
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  const generation = useRef(0);
  const checkingRef = useRef(false);
  const firstLauncher = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true; setLoading(true); setError(''); setResult(undefined);
    void bridge.remoteTargets({}).then(value => {
      if (!active) return;
      setInventory(value);
      setTargetId(previous => previous || value.targets[0]?.id || '');
    }).catch(() => {if (active) setError('暂时无法读取 SSH 主机，请重新检查。');})
      .finally(() => {if (active) setLoading(false);});
    return () => {active = false; generation.current += 1;};
  }, [bridge, round]);
  useEffect(() => {onDestinationChange?.({targetId, cwd});}, [targetId, cwd]);
  const change = () => {generation.current += 1; setResult(undefined); setError('');};
  const check = async () => {
    if (checkingRef.current || disabled || !targetId || !cwd.trim() || !inventory?.available) return;
    const directory = cwd.trim();
    if (directory !== '~' && (!directory.startsWith('/') || /[\u0000-\u001f\u007f]/.test(directory))) {
      setResult(undefined); setError('请输入远端的绝对目录，例如 /home/me/project；使用 ~ 打开远端主目录。'); return;
    }
    const request = ++generation.current; checkingRef.current = true; setChecking(true); setResult(undefined); setError('');
    try {
      const value = await bridge.remoteCheck({targetId, ...(directory === '~' ? {} : {cwd: directory})});
      if (request !== generation.current) return;
      if (value.targetId !== targetId) {setError('连接检查的主机已改变，请重新检查。'); return;}
      setResult(value);
      if (value.available) requestAnimationFrame(() => {if(request === generation.current) firstLauncher.current?.focus();});
    } catch {
      if (request === generation.current) setError('连接检查未完成，请确认主机可访问后重试。');
    } finally {
      checkingRef.current = false;
      if (request === generation.current) setChecking(false);
    }
  };
  const usable = result?.available && result.targetId === targetId;
  const availableLaunchers = result?.launchers.filter(item => item.available) ?? [];
  return <div className="dt-remote-launcher">
    <form onSubmit={event => {event.preventDefault();void check();}}>
      <label>SSH 主机<select aria-label="SSH 主机" value={targetId} disabled={disabled || loading || checking || !inventory?.available} onChange={event => {change();setTargetId(event.target.value);}}>
        {!targetId && <option value="">{loading ? '正在读取…' : '选择主机'}</option>}
        {targetId && !inventory?.targets.some(item => item.id === targetId) && <option value={targetId} disabled>原主机暂不可用</option>}
        {inventory?.targets.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <label>远端目录<input aria-label="远端工作目录" value={cwd} placeholder="~" maxLength={2048} disabled={disabled || checking} onChange={event => {change();setCwd(event.target.value);}}/></label>
      <button className="dt-remote-check" type="submit" disabled={disabled || checking || loading || !inventory?.available || !inventory.targets.some(item => item.id === targetId) || !cwd.trim()}>{checking ? '正在检查连接…' : result ? '重新检查连接' : '检查连接'}</button>
    </form>
    {loading && <p role="status">正在读取已配置的 SSH 主机…</p>}
    {inventory && !loading && (!inventory.available || !inventory.targets.length) && <p role="status">{inventory.reason || '尚无可用的 SSH 主机。请先在本机 SSH 配置中添加主机别名，再重新读取。'}</p>}
    {error && <p role="alert">{error}</p>}
    {(error || inventory && (!inventory.available || !inventory.targets.length)) && <button disabled={loading || checking || disabled} onClick={() => setRound(value => value + 1)}>重新读取主机</button>}
    {launchState === 'pending' && <p role="status">正在打开远端终端…</p>}
    {result && <div className={`dt-remote-result${usable ? ' is-ready' : ''}`} role="status"><strong>{usable ? '连接已就绪' : '暂时无法启动'}</strong><span>{result.label} · {result.cwd}</span><small>检查于 {new Date(result.checkedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}{result.reason ? ` · ${result.reason}` : ''}</small></div>}
    {usable && <><div className="dt-launchers dt-remote-agents">{availableLaunchers.map((launcher, index) => <button ref={index === 0 ? firstLauncher : undefined} key={launcher.id} disabled={disabled || checking} title={`在 ${result.label} 启动 ${launcher.label}`} onClick={() => onLaunch(launcher.id, {targetId:result.targetId, cwd:result.cwd})}><AgentIcon launcher={launcher.id}/><span className="dt-launcher-name">{launcher.label}</span></button>)}</div>{!availableLaunchers.length && <p>远端尚未检测到可用的 Shell 或 Agent CLI。</p>}<p className="dt-remote-ai-note">{REMOTE_AI_NOTICE}</p></>}
  </div>;
}
