export interface NativeResultRef { terminalId: string; messageId: string }
export interface ResultPreviewInfo { truncated?: boolean; totalLength?: number; sourceTruncated?: boolean; resultRef?: NativeResultRef }
export interface NativeResultPage extends NativeResultRef { text: string; offset: number; nextOffset: number; totalLength: number; hasMore: boolean }
export type ReadNativeResult = (input: NativeResultRef & {offset: number; limit?: number}) => Promise<NativeResultPage>;

export function resultExcerpt(message: ResultPreviewInfo & {text: string}, limit = 8000) {
  if (!message.truncated && message.text.length <= limit) return message.text;
  const notice = `[${message.sourceTruncated ? '原始 CLI 结果已截断，仅保留开头' : '以下仅为原文节选'}${message.totalLength ? `；原文 ${message.totalLength} 字符` : ''}${message.resultRef ? `；原文引用 ${message.resultRef.terminalId}/${message.resultRef.messageId}` : ''}。未附完整原文，请先核对缺失材料再执行。]\n`;
  const budget = Math.max(0, limit - notice.length), marker = '\n（中间内容因共享长度限制已省略，以下接当前记录末尾）\n';
  if (message.text.length <= budget) return notice + message.text;
  const head = Math.floor((budget - marker.length) / 2), tail = budget - marker.length - head;
  return notice + message.text.slice(0, head) + marker + message.text.slice(-tail);
}
