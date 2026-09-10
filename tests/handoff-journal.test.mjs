import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { HandoffJournal, handoffDomainSpec, handoffRecordSchema } from '../src/handoff-journal.mjs'
import { handoffMessageId, returnHandoffResult } from '../src/handoff-return.mjs'

function task(patch = {}) {
  return { id: 'task-1', requestId: 'request-1', sourceSessionId: 'source', sourceTerminalId: 'terminal-1',
    sourceLauncher: 'codex', targetLauncher: 'pi', fingerprint: 'a'.repeat(64),
    prompt: '检查已提交改动', returnToConversation: true, status: 'succeeded', delivery: 'none',
    result: '已检查，发现一处需要核对的边界情况。', createdAt: 10, updatedAt: 20, exitCode: 0, ...patch }
}

function fixture() {
  const records = new Map(), agents = new Map()
  let opened = false, puts = 0, flushes = 0, followed = 0
  let writeError = false, flushError = false, flushResult = true
  const table = {
    entries: () => [...records].map(([key, value]) => [key, structuredClone(value)])[Symbol.iterator](),
    get: key => records.get(key),
    put: async (key, value) => {
      if (writeError) throw new Error('storage unavailable')
      records.set(key, handoffRecordSchema.parse(structuredClone(value))); puts += 1
    },
  }
  const facility = { async open(spec) {
    assert.equal(spec.name, 'dsh_terminal_handoffs')
    assert.equal(opened, false)
    opened = true
    return { table: name => { assert.equal(name, 'tasks'); return table }, close: async () => { opened = false } }
  } }
  const sessions = { async flush() {
    flushes += 1
    if (flushError) throw new Error('checkpoint failed')
    return flushResult
  } }
  const ctx = { agents, get: name => ({ storageDomain: facility, sessions })[name] }
  const owner = { id: 'source', session: { events: [] }, followup(message) {
    followed += 1
    owner.session.events.push({ seq: owner.session.events.length, type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [structuredClone(message)] } })
  } }
  agents.set(owner.id, owner)
  return { ctx, owner, agents, records, table, sessions, facility,
    stats: () => ({ puts, flushes, followed, opened }),
    failWrites: value => { writeError = value }, failFlush: value => { flushError = value },
    flushResult: value => { flushResult = value } }
}

test('native domain restores only the captured owner; running work becomes interrupted without spawning', async () => {
  const f = fixture(), first = new HandoffJournal(f.ctx)
  await first.put(f.owner, task({ status: 'running' }))
  assert.equal((await first.list(f.owner))[0].status, 'running')
  const other = { ...f.owner, id: 'other', session: { events: [] } }
  f.agents.set(other.id, other)
  await first.put(other, task({ id: 'other-task', sourceSessionId: 'other', status: 'queued' }))
  await first.close()
  const second = new HandoffJournal(f.ctx)
  const restored = await second.list(f.owner)
  assert.equal(restored.length, 1)
  assert.equal(restored[0].status, 'interrupted')
  assert.equal(restored[0].requestId, 'request-1')
  assert.equal(restored[0].fingerprint, 'a'.repeat(64))
  assert.equal([...f.records.values()].find(row => row.sourceSessionId === 'other').status, 'queued')
  restored[0].prompt = 'mutated UI copy'
  assert.equal((await second.list(f.owner))[0].prompt, '检查已提交改动')
  assert.equal(f.owner.session.events.length, 0)
  assert.equal(f.stats().followed, 0)
  await second.close()
})

test('journal refuses foreign records, replaced owners, identity changes, failed writes and writes after close', async () => {
  const f = fixture(), journal = new HandoffJournal(f.ctx)
  await assert.rejects(journal.put(f.owner, task({ sourceSessionId: 'other' })), /不属于/)
  await journal.put(f.owner, task())
  await assert.rejects(journal.put(f.owner, task({ fingerprint: 'b'.repeat(64) })), /身份/)
  f.failWrites(true)
  await assert.rejects(journal.put(f.owner, task({ status: 'failed' })), /storage unavailable/)
  assert.equal((await journal.list(f.owner))[0].status, 'succeeded')
  f.agents.set(f.owner.id, { ...f.owner })
  await assert.rejects(journal.list(f.owner), /已失效/)
  await journal.close()
  await assert.rejects(journal.put(f.owner, task()), /已关闭/)
})

test('concurrent return calls queue one plugin notice into the original session and await durability', async () => {
  const f = fixture()
  f.ctx.current = { id: 'unrelated-ui-selection' }
  const results = await Promise.all([returnHandoffResult({ ...f, task: task() }), returnHandoffResult({ ...f, task: task() })])
  assert.deepEqual(results[0], results[1])
  assert.equal(results[0].messageId, handoffMessageId(f.owner.id, 'task-1'))
  assert.equal(f.stats().followed, 1)
  assert.equal(f.stats().flushes, 1)
  const message = f.owner.session.events[0].data.inserted[0]
  assert.equal(message.source.plugin, 'dsh-terminal')
  assert.equal(message.role, 'user')
  assert.match(message.content[0].text, /任务成果仍需核验/)
  await returnHandoffResult({ ...f, task: task() })
  assert.equal(f.stats().followed, 1)
})

test('a lost durability acknowledgement retries the checkpoint without duplicating a consumed message', async () => {
  const f = fixture()
  f.failFlush(true)
  await assert.rejects(returnHandoffResult({ ...f, task: task() }), error => error.delivery === 'uncertain')
  assert.equal(f.stats().followed, 1)
  const message = f.owner.session.events[0].data.inserted[0]
  f.owner.session.events = [{ seq: 0, type: 'user/message', data: message }]
  f.failFlush(false)
  await returnHandoffResult({ ...f, task: task() })
  assert.equal(f.stats().followed, 1)
  assert.equal(f.stats().flushes, 2)
})

test('return fails closed for lost persistence, replaced owner, unready task and message collision', async () => {
  const f = fixture()
  await assert.rejects(returnHandoffResult({ ...f, task: task({ status: 'running' }) }), /尚未结束/)
  await assert.rejects(returnHandoffResult({ ...f, task: task({ sourceSessionId: 'other' }) }), /不属于/)
  f.flushResult(false)
  await assert.rejects(returnHandoffResult({ ...f, task: task() }), error => error.delivery === 'uncertain')
  f.flushResult(true)
  await assert.rejects(returnHandoffResult({ ...f, task: task({ result: 'changed result' }) }), /身份冲突/)
  f.agents.set(f.owner.id, { ...f.owner })
  await assert.rejects(returnHandoffResult({ ...f, task: task() }), /已失效/)
  assert.equal(f.stats().followed, 1)
})

test('cancellation and owner replacement during checkpoint cannot report a successful delivery', async () => {
  const f = fixture(), abort = new AbortController()
  f.sessions.flush = async () => { abort.abort(); return true }
  await assert.rejects(returnHandoffResult({ ...f, task: task(), signal: abort.signal }), error => error.delivery === 'uncertain')
  f.sessions.flush = async () => { f.agents.set(f.owner.id, { ...f.owner }); return true }
  await assert.rejects(returnHandoffResult({ ...f, task: task() }), error => error.delivery === 'uncertain')
  assert.equal(f.stats().followed, 1)
})

test('missing native storage refuses to promise durable task persistence', async () => {
  const f = fixture(), journal = new HandoffJournal({ ...f.ctx, get: () => undefined })
  await assert.rejects(journal.list(f.owner), /未提供任务存储/)
  await journal.close()
})

test('handoff domain and table identifiers satisfy the native storage backend contract', () => {
  // @deepseek-ai/dsh-storage exports this grammar as UNIT_NAME_RE in rc.2.
  // DomainFacility.open alone does not run defineDomain's name validation.
  const unitName = /^[a-z][a-z0-9_]*$/
  assert.match(handoffDomainSpec.name, unitName)
  for (const name of Object.keys(handoffDomainSpec.tables)) assert.match(name, unitName)
})

test('official JSON provider persists and reopens handoffs with valid unit names', async t => {
  const runtime = process.env.DSH_NATIVE_RUNTIME
    ? resolve(process.env.DSH_NATIVE_RUNTIME)
    : fileURLToPath(new URL('../../runtime/dsh', import.meta.url))
  const domainPath = join(runtime, 'packages/storage/storage-domain/lib/index.js')
  const backendPath = join(runtime, 'packages/storage/storage-json/lib/index.js')
  if (!existsSync(domainPath) || !existsSync(backendPath)) {
    t.skip('Set DSH_NATIVE_RUNTIME to a built official rc.2 source checkout to run native persistence verification')
    return
  }
  const [{ DomainFacility, defineDomain }, { JsonStorageBackend }] = await Promise.all([
    import(pathToFileURL(domainPath).href), import(pathToFileURL(backendPath).href),
  ])
  const directory = await mkdtemp(join(tmpdir(), 'dsh-handoff-storage-test-'))
  const opened = []
  t.after(async () => {
    for (const { journal, backend } of opened.reverse()) {
      await journal.close()
      await backend.close()
    }
    await rm(directory, { recursive: true, force: true })
  })
  const owner = { id: 'source', session: { events: [] } }
  const open = () => {
    const backend = new JsonStorageBackend(directory)
    const facility = new DomainFacility({
      storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {} },
    }, { backend: 'json' })
    const ctx = { agents: new Map([[owner.id, owner]]), get: name => name === 'storageDomain' ? facility : undefined }
    const journal = new HandoffJournal(ctx)
    opened.push({ journal, backend })
    return { journal, backend }
  }
  assert.equal(defineDomain(handoffDomainSpec), handoffDomainSpec)
  const first = open()
  // This must reject the original defect through the actual persistence provider.
  await assert.rejects(first.backend.kv.open({ name: 'dsh-terminal-handoffs', version: 1, tables: ['tasks'], hasGlobal: false }), /invalid unit name/)
  await first.journal.put(owner, task({ status: 'running' }))
  await first.journal.close()
  await first.backend.close()
  const saved = JSON.parse(await readFile(join(directory, `${handoffDomainSpec.name}.json`), 'utf8'))
  assert.equal(saved.unit.name, handoffDomainSpec.name)
  assert.equal(Object.values(saved.tables.tasks)[0].status, 'running')
  const second = open()
  const restored = await second.journal.list(owner)
  assert.equal(restored.length, 1)
  assert.equal(restored[0].status, 'interrupted')
  assert.equal(restored[0].requestId, 'request-1')
  assert.equal(restored[0].fingerprint, 'a'.repeat(64))
  assert.equal(owner.session.events.length, 0)
  const recovered = JSON.parse(await readFile(join(directory, `${handoffDomainSpec.name}.json`), 'utf8'))
  assert.equal(Object.values(recovered.tables.tasks)[0].status, 'interrupted')
})
