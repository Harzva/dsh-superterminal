import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { appendTextPreview, createTextPreview, previewTextBlocks, readTextPage } from '../src/native-result-text.mjs'

test('bounded head and tail previews agree with original pages across text blocks and controls', () => {
  const blocks = [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: 'HEAD\0\n' + 'a'.repeat(18000) },
    { type: 'tool-call', arguments: 'PRIVATE_TOOL' }, { type: 'text', text: 'b'.repeat(9000) + '\nACTUAL_TAIL\n' }]
  const original = blocks.filter(block => block.type === 'text').map(block => block.text.replace(/\0/g, '')).join('\n')
  const preview = previewTextBlocks(blocks)
  assert.equal(preview.totalLength, original.length); assert.equal(preview.truncated, true); assert.equal(preview.text.length, 8000)
  assert.ok(preview.text.startsWith('HEAD\n')); assert.ok(preview.text.endsWith('ACTUAL_TAIL\n')); assert.match(preview.text, /省略/)
  const pages = []; let offset = 0
  while (offset < original.length) {
    const page = readTextPage(blocks, offset, 7000); pages.push(page.text); offset = page.nextOffset
    assert.ok(page.text.length <= 7000); assert.equal(page.totalLength, original.length)
  }
  assert.equal(pages.join(''), original); assert.doesNotMatch(pages.join(''), /PRIVATE_/)
  assert.equal(previewTextBlocks([{ type: 'text', text: 'hello' }], 1).text.length, 1)
  assert.throws(() => readTextPage(blocks, 0, 16001)); assert.throws(() => readTextPage(blocks, -1))
})

test('streaming preview memory remains bounded while final chunks and exact total length are retained', () => {
  const state = createTextPreview(); let preview
  for (let index = 0; index < 2000; index++) preview = appendTextPreview(state, `chunk-${index}\n` + 'c'.repeat(1000))
  assert.ok(state.head.length <= 8000); assert.ok(state.tail.length <= 8000); assert.ok(preview.text.length <= 8000)
  assert.ok(preview.totalLength > 2_000_000); assert.ok(preview.text.includes('chunk-1999'))
  assert.equal(preview.totalLength, state.totalLength)
})

const client = await build({ stdin: { contents: "export { NativeResultReader } from './src/client/native-result-reader'; export { resultExcerpt } from './src/client/result-types';",
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, format: 'cjs', platform: 'node',
  external: ['react', 'react/jsx-runtime'], loader: { '.css': 'text' }, logLevel: 'silent' })
const module = { exports: {} }
new Function('require', 'module', 'exports', client.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { NativeResultReader, resultExcerpt } = module.exports

test('native previews offer explicit original reading while CLI truncation never claims an original', () => {
  let reads = 0
  const readResult = async () => { reads++; throw Error('Mount must not read') }
  const native = renderToStaticMarkup(React.createElement(NativeResultReader, { result: { truncated: true, totalLength: 22000,
    resultRef: { terminalId: 'opaque-terminal', messageId: 'assistant-1-1' } }, readResult }))
  assert.match(native, /首尾节选/); assert.match(native, /22,000/); assert.match(native, /分段查看完整结果/)
  assert.doesNotMatch(native, /opaque-terminal/); assert.equal(reads, 0)
  const cli = renderToStaticMarkup(React.createElement(NativeResultReader, { result: { truncated: true, sourceTruncated: true, totalLength: 42000 }, readResult }))
  assert.match(cli, /原始 CLI 结果已截断/); assert.match(cli, /无法在此补读/); assert.doesNotMatch(cli, /分段查看完整结果/)
  const short = renderToStaticMarkup(React.createElement(NativeResultReader, { result: { truncated: false, totalLength: 20 }, readResult }))
  assert.equal(short, ''); assert.equal(reads, 0)
})

test('handoff excerpts retain the final correction and explicitly carry missing-source limits', () => {
  const input = { text: 'REAL_START\n' + 'x'.repeat(7900) + '\nFINAL_CORRECTION', truncated: true, totalLength: 35000,
    resultRef: { terminalId: 'terminal', messageId: 'assistant-1-1' } }
  const result = resultExcerpt(input)
  assert.ok(result.length <= 8000); assert.match(result, /原文 35000 字符/); assert.match(result, /未附完整原文/)
  assert.match(result, /terminal\/assistant-1-1/); assert.ok(result.endsWith('FINAL_CORRECTION'))
  const cli = resultExcerpt({ text: 'c'.repeat(16000), truncated: true, sourceTruncated: true, totalLength: 45000 })
  assert.ok(cli.length <= 8000); assert.match(cli, /原始 CLI 结果已截断/)
  assert.equal(resultExcerpt({ text: 'short complete result' }), 'short complete result')
})
