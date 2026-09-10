import { randomUUID } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'

const PREFIX = '777;dsh-command;'
const MAX_FRAME = 16384
const MAX_OUTPUT = 32768
const MAX_MEMORY = 1024 * 1024
const cleanCommand = value => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
const cutBytes = (text, cap) => { let value = Buffer.from(text).subarray(0, cap).toString('utf8'); if (value.endsWith('\ufffd')) value = value.slice(0, -1); return value }

/** In-band shell telemetry is display-only, never authorization or Agent completion. */
export class CommandJournal {
  constructor(nonce, reason) {
    this.nonce = nonce
    this.status = nonce ? 'starting' : 'unavailable'
    this.reason = reason
    this.createdAt = Date.now()
    this.sequence = 0
    this.records = []
    this.active = null
    this.pending = ''
    this.dropping = false
    this.dropEscape = false
    this.control = ''
    this.memory = 0
    this.discarded = false
  }

  text(value) {
    if (!this.active || this.active.prompt) return
    let plain = ''
    for (const char of value) {
      if (this.control === 'esc') { this.control = char === '[' ? 'csi' : ['P', '^', '_', ']'].includes(char) ? 'string' : ''; continue }
      if (this.control === 'csi') { if (char >= '@' && char <= '~') this.control = ''; continue }
      if (this.control === 'string') { if (char === '\x07') this.control = ''; else if (char === '\x1b') this.control = 'string-esc'; continue }
      if (this.control === 'string-esc') { this.control = char === '\\' ? '' : 'string'; continue }
      if (char === '\x1b') { this.control = 'esc'; continue }
      if (char === '\n' || char === '\t' || (char >= ' ' && !/[\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(char))) plain += char
    }
    if (!plain) return
    const record = this.active.record
    const bytes = Buffer.byteLength(plain)
    const retained = cutBytes(plain, Math.max(0, MAX_OUTPUT - this.active.bytes))
    this.active.bytes += Buffer.byteLength(retained)
    record.output += retained
    this.memory += Buffer.byteLength(retained)
    if (retained.length < plain.length || bytes > MAX_OUTPUT) record.outputTruncated = true
    this.trim()
  }

  trim() {
    while ((this.records.length > 50 || this.memory > MAX_MEMORY) && this.records.length > 1) {
      const record = this.records.shift()
      this.memory -= Buffer.byteLength(record.command) + Buffer.byteLength(record.output)
      this.discarded = true
    }
  }

  finishCommand(exitCode = null) {
    if (!this.active) return
    const record = this.active.record
    record.finishedAt = Date.now()
    record.durationMs = Math.max(0, Math.round(performance.now() - this.active.clock))
    record.exitCode = exitCode
    record.status = exitCode === null ? 'interrupted' : exitCode === 0 ? 'succeeded' : 'failed'
    this.active = null
    this.control = ''
  }

  frame(value) {
    const parts = value.split(';')
    if (parts[2] !== this.nonce || !/^(0|[1-9]\d{0,8})$/.test(parts[3] ?? '')) return
    const sequence = Number(parts[3]), type = parts[4]
    if (type === 'R' && sequence === 0 && this.sequence === 0 && parts.length === 6) { this.status = 'ready'; this.reason = undefined; return }
    if (type === 'X' && sequence === 0 && parts.length === 6) {
      this.status = 'unavailable'; this.reason = '当前 Shell 配置与命令记录不兼容，终端仍可正常使用'; return
    }
    if (this.status !== 'ready') return
    if (type === 'P' && sequence === 0 && this.active && parts.length === 6) { this.active.prompt = true; return }
    if (type === 'C' && sequence === this.sequence + 1 && parts.length === 7 && /^[01]$/.test(parts[5])
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parts[6]) && parts[6].length <= 10924) {
      const bytes = Buffer.from(parts[6], 'base64')
      if (bytes.length > 8192) return
      let command
      try { command = new TextDecoder('utf8', { fatal: true }).decode(bytes) } catch { return }
      if (!command.trim()) return
      this.finishCommand()
      this.sequence = sequence
      const record = { id: randomUUID(), command: cleanCommand(command), commandTruncated: parts[5] === '1',
        output: '', outputTruncated: false, startedAt: Date.now(), finishedAt: null, durationMs: null, exitCode: null, status: 'running' }
      this.records.push(record)
      this.memory += Buffer.byteLength(record.command)
      this.active = { record, clock: performance.now(), bytes: 0 }
      this.trim()
    } else if (type === 'D' && sequence === this.sequence && this.active && parts.length === 6 && /^(0|[1-9]\d{0,2})$/.test(parts[5]) && Number(parts[5]) <= 255) {
      this.finishCommand(Number(parts[5]))
    }
  }

  /** Strip only our protocol from PTY replay; all other VT data stays native. */
  feed(data) {
    if (!this.nonce) return data
    let input = this.pending + data, visible = ''
    this.pending = ''
    while (input) {
      if (this.dropping) {
        let end = -1
        for (let index = 0; index < input.length; index++) {
          const char = input[index]
          if (char === '\x07' || (this.dropEscape && char === '\\')) { end = index; break }
          this.dropEscape = char === '\x1b'
        }
        if (end < 0) return visible
        this.dropping = false; this.dropEscape = false; input = input.slice(end + 1)
        continue
      }
      const start = input.indexOf('\x1b]')
      if (start < 0) {
        const tail = input.endsWith('\x1b') ? '\x1b' : ''
        const text = tail ? input.slice(0, -1) : input
        visible += text; this.text(text); this.pending = tail
        break
      }
      const text = input.slice(0, start)
      visible += text; this.text(text)
      input = input.slice(start + 2)
      const bell = input.indexOf('\x07'), st = input.indexOf('\x1b\\')
      const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st)
      if (end < 0) {
        if (input.length > MAX_FRAME) { this.dropping = true; this.dropEscape = input.endsWith('\x1b') }
        else this.pending = '\x1b]' + input
        break
      }
      const content = input.slice(0, end), length = end === st ? 2 : 1
      if (content.startsWith(PREFIX)) { if (content.length <= MAX_FRAME) this.frame(content) }
      else visible += '\x1b]' + content + input.slice(end, end + length)
      input = input.slice(end + length)
    }
    return visible
  }

  end() {
    const visible = this.pending.startsWith('\x1b]' + PREFIX) ? '' : this.pending
    this.pending = ''; this.dropping = false
    this.text(visible); this.finishCommand()
    if (this.nonce) this.status = 'ended'
    return visible
  }

  snapshot(lastN = 20) {
    if (!Number.isInteger(lastN) || lastN < 1 || lastN > 50) throw new Error('命令记录数量必须介于 1 和 50 之间')
    const delayed = this.status === 'starting' && Date.now() - this.createdAt > 5000
    return { status: delayed ? 'unavailable' : this.status,
      ...(this.reason || delayed ? { reason: this.reason || '尚未收到 Shell 命令记录信号，终端仍可正常使用' } : {}),
      records: this.records.slice(-lastN).map(record => ({ ...record })),
      truncated: this.discarded || this.records.length > lastN }
  }
}
