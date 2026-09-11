const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g
const OMITTED = '\n\n（中间原文因长度限制已省略，以下接原文末尾。）\n\n'
export const RESULT_PREVIEW_LIMIT = 8000
export const RESULT_PAGE_LIMIT = 16000

// Iterate in small pieces instead of materializing another unbounded copy of
// the native event text. The original event remains in DSH session storage.
function* cleanParts(value) {
  if (typeof value !== 'string') return
  for (let offset = 0; offset < value.length; offset += 4096) yield value.slice(offset, offset + 4096).replace(CONTROLS, '')
}
function* blockParts(blocks) {
  let first = true
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type !== 'text') continue
    if (!first) yield '\n'
    first = false
    yield* cleanParts(block.text)
  }
}
export function createTextPreview() { return { head: '', tail: '', totalLength: 0 } }
export function appendTextPreview(state, value, limit = RESULT_PREVIEW_LIMIT) {
  for (const part of cleanParts(value)) {
    state.totalLength += part.length
    if (state.head.length < limit) state.head += part.slice(0, limit - state.head.length)
    state.tail = (state.tail + part).slice(-limit)
  }
  return finishTextPreview(state, limit)
}
function finishTextPreview(state, limit) {
  if (state.totalLength <= limit) return { text: state.head, truncated: false, totalLength: state.totalLength }
  const marker = limit > OMITTED.length ? OMITTED : '…'
  const length = Math.max(0, limit - marker.length), head = Math.floor(length / 2)
  return { text: state.head.slice(0, head) + marker + (length > head ? state.tail.slice(-(length - head)) : ''), truncated: true, totalLength: state.totalLength }
}
export function previewTextBlocks(blocks, limit = RESULT_PREVIEW_LIMIT) {
  const state = createTextPreview()
  for (const part of blockParts(blocks)) appendTextPreview(state, part, limit)
  return finishTextPreview(state, limit)
}
export function readTextPage(blocks, offset, limit = RESULT_PAGE_LIMIT) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > RESULT_PAGE_LIMIT) throw new Error('Invalid result page bounds')
  const parts = []
  let totalLength = 0
  for (const part of blockParts(blocks)) {
    const start = totalLength; totalLength += part.length
    if (totalLength > offset && start < offset + limit) parts.push(part.slice(Math.max(0, offset - start), Math.min(part.length, offset + limit - start)))
  }
  const text = parts.join(''), nextOffset = Math.min(totalLength, offset + text.length)
  return { text, offset: Math.min(offset, totalLength), nextOffset, totalLength, hasMore: nextOffset < totalLength }
}
