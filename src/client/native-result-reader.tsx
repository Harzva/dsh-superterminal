import React, { useEffect, useRef, useState } from 'react';
import type { NativeResultPage, ReadNativeResult, ResultPreviewInfo } from './result-types';
import css from './native-result-reader.css';

const PAGE_SIZE = 8000;
/** Loads one bounded page on demand; never starts or resumes an agent. */
export function NativeResultReader({result, readResult}: {result: ResultPreviewInfo; readResult?: ReadNativeResult}) {
  const [opened, setOpened] = useState(false), [page, setPage] = useState<NativeResultPage>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const revision = useRef(0), pendingOffset = useRef(0);
  const ref = result.resultRef;
  useEffect(() => { ++revision.current; setOpened(false); setPage(undefined); setError(''); setBusy(false);
    return () => { ++revision.current; }; }, [ref?.terminalId, ref?.messageId]);
  if (!result.truncated) return null;
  const load = async (offset: number) => {
    if (!ref || !readResult) return;
    const current = ++revision.current;
    pendingOffset.current = offset; setBusy(true); setError(''); setCopied(false);
    try { const value = await readResult({...ref, offset, limit: PAGE_SIZE});
      if (current === revision.current) setPage(value);
    } catch { if (current === revision.current) setError('原文暂时无法读取，请重试。当前记录已保留。'); }
    finally { if (current === revision.current) setBusy(false); }
  };
  return <div className="dt-result-reader">
    <style>{css}</style>
    <div className="dt-result-note"><span>{result.sourceTruncated ? '原始 CLI 结果已截断，仅保留开头部分。' : '此处仅显示原文首尾节选。'}
      {result.totalLength !== undefined && `原文 ${result.totalLength.toLocaleString()} 字符。`}
      {result.sourceTruncated && '未保存的部分无法在此补读。'}</span>
      {!result.sourceTruncated && ref && readResult && <button type="button" aria-expanded={opened} onClick={() => {
        setOpened(!opened); if (!opened && !page) void load(0);
      }}>{opened ? '收起原文' : '分段查看完整结果'}</button>}
    </div>
    {opened && <section className="dt-result-pages" aria-label="完整结果分段阅读" aria-busy={busy}>
      <div className="dt-result-location"><span>来源：该终端保存的 AI 回复</span><details><summary>来源详情</summary><code>{ref?.terminalId}/{ref?.messageId}</code></details></div>
      {page && <><div className="dt-result-range">{page.totalLength ? page.offset + 1 : 0}–{page.nextOffset} / {page.totalLength.toLocaleString()} 字符</div>
        <pre tabIndex={0}>{page.text || '本段没有文本内容。'}</pre></>}
      {busy && <p role="status">正在读取原文…</p>}
      {error && <p role="status">{error} <button type="button" disabled={busy} onClick={() => {void load(pendingOffset.current);}}>重试读取</button></p>}
      {page && <div className="dt-result-navigation">
        <button type="button" disabled={busy || page.offset === 0} onClick={() => {void load(Math.max(0, page.offset - PAGE_SIZE));}}>上一段</button>
        <button type="button" disabled={busy || !page.hasMore} onClick={() => {void load(page.nextOffset);}}>下一段</button>
        <button type="button" disabled={busy || !page.hasMore} onClick={() => {void load(Math.max(0, page.totalLength - PAGE_SIZE));}}>查看末尾</button>
        <button type="button" disabled={busy} onClick={() => {void navigator.clipboard.writeText(page.text).then(() => setCopied(true), () => setError('复制未成功，可选中本段文字手动复制。'));}}>{copied ? '已复制本段' : '复制本段'}</button>
      </div>}
    </section>}
  </div>;
}
