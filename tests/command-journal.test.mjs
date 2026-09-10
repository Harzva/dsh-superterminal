import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandJournal } from '../src/command-journal.mjs'

const nonce = 'a'.repeat(48)
const frame = (type, sequence, data = '', token = nonce) => `\x1b]777;dsh-command;${token};${sequence};${type};${data}\x07`
const begin = (sequence, command) => frame('C', sequence, `0;${Buffer.from(command).toString('base64')}`)

test('split protocol frames yield exact command boundaries, sanitized output and immutable reconnect snapshots', async () => {
  const journal = new CommandJournal(nonce)
  const stream = frame('R', 0) + 'PROMPT> echoed command\r\n' + begin(1, "printf '你好;\\n'") + '\x1b[31m你好\x1b[0m\r\n' + frame('P', 0) + '%   \r \r' + frame('D', 1, '7') + 'PROMPT> '
  let visible = ''
  for (const char of stream) visible += journal.feed(char)
  assert.ok(visible.includes('PROMPT> ')); assert.equal(visible.includes('dsh-command'), false); assert.equal(visible.includes(nonce), false)
  const snapshot = journal.snapshot()
  assert.equal(snapshot.status, 'ready'); assert.equal(snapshot.records.length, 1)
  assert.equal(snapshot.records[0].command, "printf '你好;\\n'")
  assert.equal(snapshot.records[0].output, '你好\n')
  assert.equal(snapshot.records[0].exitCode, 7); assert.equal(snapshot.records[0].status, 'failed')
  assert.ok(snapshot.records[0].durationMs >= 0)
  snapshot.records[0].output = 'mutated'
  assert.equal(journal.snapshot().records[0].output, '你好\n')
})

test('untrusted, replayed, malformed and oversized markers cannot create or complete commands', () => {
  const journal = new CommandJournal(nonce)
  journal.feed(frame('R', 0, '', 'b'.repeat(48)) + begin(1, 'forged before handshake'))
  assert.equal(journal.snapshot().records.length, 0)
  journal.feed(frame('R', 0) + begin(1, 'real command'))
  journal.feed(frame('D', 1, '0', 'b'.repeat(48)) + frame('D', 2, '0') + frame('D', 1, '999') + frame('D', 1, '-1'))
  assert.equal(journal.snapshot().records[0].status, 'running')
  journal.feed(frame('C', 2, '0;not!base64') + frame('C', 2, '0;' + 'A'.repeat(20000)))
  journal.feed('\x1b]777;dsh-command;' + 'A'.repeat(50000))
  assert.equal(journal.pending.length, 0)
  journal.feed('\x07' + frame('D', 1, '0') + begin(1, 'replayed'))
  assert.equal(journal.snapshot().records.length, 1)
  assert.equal(journal.snapshot().records[0].status, 'succeeded')
})

test('command journal bounds output, record count and total memory without fabricating an exit code on disconnect', () => {
  const journal = new CommandJournal(nonce)
  journal.feed(frame('R', 0))
  for (let sequence = 1; sequence <= 70; sequence++) journal.feed(begin(sequence, 'long output') + '字'.repeat(20000) + frame('D', sequence, '0'))
  const history = journal.snapshot(50)
  assert.ok(history.records.length <= 50); assert.equal(history.truncated, true)
  assert.ok(journal.memory <= 1024 * 1024)
  for (const record of history.records) { assert.ok(Buffer.byteLength(record.output) <= 32768); assert.equal(record.outputTruncated, true) }
  journal.feed(begin(71, 'exec another process') + 'partial')
  journal.end()
  const last = journal.snapshot(1).records[0]
  assert.equal(last.status, 'interrupted'); assert.equal(last.exitCode, null); assert.equal(last.output, 'partial')
  assert.equal(journal.snapshot().status, 'ended')
  assert.throws(() => journal.snapshot(51)); assert.throws(() => journal.snapshot(0))
})

test('other terminal escape protocols pass through the PTY but are excluded from recorded output', () => {
  const journal = new CommandJournal(nonce)
  journal.feed(frame('R', 0) + begin(1, 'print escapes'))
  const output = '\x1b]0;Window title\x07hello\x1bPprivate control\x1b\\\x1b[2K\n'
  assert.equal(journal.feed(output), output)
  journal.feed(frame('D', 1, '0'))
  assert.equal(journal.snapshot().records[0].output, 'hello\n')
  const disabled = new CommandJournal(null, 'Unsupported shell')
  assert.equal(disabled.feed('unchanged'), 'unchanged'); assert.equal(disabled.snapshot().status, 'unavailable')
})
