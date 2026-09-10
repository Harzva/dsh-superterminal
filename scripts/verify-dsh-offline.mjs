#!/usr/bin/env node
// Offline means no model or native-agent authentication is used. Installing
// the official DSH packages may access the public npm registry.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const dshVersion = process.env.DSH_VERIFY_VERSION ?? '0.1.1-rc.2'
if (dshVersion !== '0.1.1-rc.2') throw new Error('This release verifies only official DSH 0.1.1-rc.2')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))

async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: repo, env, stdio: 'inherit', ...options })
  const result = await once(child, 'exit')
  assert.equal(result[0], 0, `${command} exited ${result[0] ?? result[1]}`)
}

if (!process.argv[2]) await run(process.execPath, ['scripts/pack-dsh.mjs'])
const artifact = resolve(process.argv[2] ?? join(repo, 'artifacts', `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`))
const artifactBytes = await readFile(artifact)
const packed = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }))
assert.equal(packed.name, manifest.name)
assert.equal(packed.version, manifest.version)
const entries = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8' }).trim().split('\n')
for (const file of ['package.json', 'cordis.patch.yml', 'lib/host.mjs', 'lib/remote.mjs', 'lib/independent-scope.mjs', 'lib/pty-compat.mjs', 'lib/handoffs.mjs', 'lib/handoff-journal.mjs', 'lib/handoff-return.mjs', 'lib/cli-state.mjs', 'lib/client.js', 'README.md', 'LICENSE']) {
  assert.ok(entries.includes(`package/${file}`), `Release artifact must include ${file}`)
}
assert.ok(entries.every(path => path.startsWith('package/') && !path.split('/').includes('..')))

const fixture = await mkdtemp(join(tmpdir(), 'dsh-terminal-verify-'))
const runtime = join(fixture, 'runtime')
const home = join(fixture, 'home')
const workspace = join(fixture, 'workspace')
await Promise.all([mkdir(runtime), mkdir(home), mkdir(workspace)])
// This explicitly named protocol simulator tests the installed package's real
// subprocess/storage/return path without a model account. Live model acceptance
// is a separate check; this fixture never claims to be a real Pi model response.
const fixtureBin = join(fixture, 'protocol-simulator')
await mkdir(fixtureBin)
await writeFile(join(fixtureBin, 'pi'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
let input = ''
for await (const chunk of process.stdin) input += chunk
const task = JSON.parse(input.slice(input.indexOf('\\n') + 1))
appendFileSync('protocol-spawns.jsonl', JSON.stringify({ id: process.env.DSH_HANDOFF_TASK_ID, pid: process.pid }) + '\\n')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
emit({ type: 'agent_start' })
if (task.task === 'offline:wait') {
  setInterval(() => {}, 1000)
} else {
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: task.task === 'offline:error' ? 'error' : 'stop',
    errorMessage: task.task === 'offline:error' ? 'Offline protocol fixture failure' : undefined,
    content: [{ type: 'text', text: task.task === 'offline:error' ? '' : 'VERIFIED_NATIVE_HANDOFF' }] } })
  emit({ type: 'agent_end', willRetry: false })
}
`, { mode: 0o700 })
await writeFile(join(runtime, 'package.json'), JSON.stringify({
  name: 'dsh-terminal-verification-runtime', version: '0.0.0', private: true, type: 'module',
  dependencies: { '@deepseek-ai/dsh': dshVersion, react: '18.3.1' },
}, null, 2) + '\n')
console.log(`Installing official DSH ${dshVersion} into ${runtime}`)
// Seed the large official dependency graph before npm resolves its peer cycles.
// The second pass installs the required peers; legacy mode is not the final state.
await run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: runtime })
await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], { cwd: runtime })
// The official local provider's own install helper only restores the packaged
// node-pty helper's executable bit; it does not build or patch DSH sources.
await run(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs')], { cwd: runtime })
const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const childEnv = { ...env, PATH: fixtureBin + ':' + (env.PATH ?? ''), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', artifact, '--ignore-scripts'], { cwd: workspace, env: childEnv })
const profile = join(home, 'profiles/web')
const installedManifest = JSON.parse(await readFile(join(profile, 'node_modules/@harzva/dsh-terminal/package.json'), 'utf8'))
assert.equal(installedManifest.version, manifest.version)
const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
assert.ok(profileManifest.dsh.profile.bundles.includes(manifest.name), 'Actual plugin add must reconcile the bundle')
const runtimeRequire = createRequire(cli)
const pluginRequire = createRequire(join(profile, 'node_modules/@harzva/dsh-terminal/lib/pty-compat.mjs'))
const runtimePackages = {}
async function verifyRuntimePackages() {
  // Official profile boot creates its runtime-package bridge. Check the actual
  // resulting resolution after boot, before allocating any test terminals.
  for (const name of Object.keys(manifest.peerDependencies).filter(name => name.startsWith('@deepseek-ai/'))) {
    const runtimePackage = await realpath(runtimeRequire.resolve(`${name}/package.json`))
    const pluginPackage = await realpath(pluginRequire.resolve(`${name}/package.json`))
    assert.equal(pluginPackage, runtimePackage, `${name} must resolve to the official runtime's single package instance`)
    runtimePackages[name] = JSON.parse(await readFile(pluginPackage, 'utf8')).version
    assert.equal(runtimePackages[name], dshVersion, `${name} must use the selected official version`)
  }
}

const port = await new Promise((resolvePort, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolvePort(port)) })
})
const base = `http://127.0.0.1:${port}`
const command = [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']
const report = { schema: 1, artifactSha256: createHash('sha256').update(artifactBytes).digest('hex'), pluginVersion: manifest.version, dshVersion, runtimePackages, fixture, profile, workspace, cli, port, command, checks: {}, cleanup: {}, startedAt: new Date().toISOString() }
await writeFile(join(fixture, 'restart.json'), JSON.stringify({ executable: process.execPath, args: command, cwd: workspace, env: childEnv }, null, 2) + '\n')
let server
let logs = ''
let sessionId
const terminals = []
const spawnedJobs = async () => { try { return (await readFile(join(workspace, 'protocol-spawns.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
let handoffOwner, handoffInput, finishedHandoff, interruptedHandoff
let failure

async function rpc(method, payload) {
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`Verification gateway ${method}: HTTP ${response.status}`)
  const result = (await response.json()).result
  if (!result?.ok) throw new Error(`${method}: ${result?.error?.message ?? 'missing result'}`)
  return result.value
}
const callOwner = (ownerId, method, request) => rpc(`dshTerminal/${method}`, { args: { agentId: ownerId, request } })
const call = (method, request) => callOwner(sessionId, method, request)
async function until(check, label, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await delay(80) }
  throw new Error(`Timed out: ${label}`)
}
async function write(entry, data) {
  const result = await callOwner(entry.ownerSessionId, 'write', { terminalId: entry.id, lease: entry.lease, sequence: entry.sequence, data })
  entry.sequence = result.nextSequence
}
async function readUntil(entry, expected) {
  await until(async () => {
    const result = await callOwner(entry.ownerSessionId, 'read', { terminalId: entry.id, offset: entry.offset })
    assert.equal(result.gap, false)
    entry.offset = result.nextOffset
    entry.output += result.data
    return entry.output.includes(expected)
  }, 'native terminal output')
}
function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }

async function bootServer() {
  server = spawn(process.execPath, command, { cwd: workspace, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const remember = chunk => { logs = (logs + chunk.toString()).slice(-64000) }
  server.stdout.on('data', remember)
  server.stderr.on('data', remember)
  await until(async () => {
    if (server.exitCode !== null) throw new Error(`Official DSH exited during boot (${server.exitCode})`)
    try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
  }, 'official DSH HTTP ready', 45000)
  await until(async () => {
    if (server.exitCode !== null) throw new Error('Official DSH exited before its API was ready')
    try { await rpc('host.describe', {}); return true }
    catch (error) { if (/HTTP 404|fetch failed/.test(error.message)) return false; throw error }
  }, 'official DSH API ready', 45000)
}

async function createSource(cwd = workspace) {
  const id = (await rpc('session.create', { cwd })).sessionId
  await until(async () => {
    const history = await rpc('session.history', { sessionId: id })
    const current = history.projections?.values?.permissions?.currentValue
    if (current === undefined) return false
    assert.equal(current, 'workspace-write')
    return true
  }, 'permission projection is ready')
  return id
}

async function createPty(ownerId) {
  const opened = await callOwner(ownerId, 'open', { launcher: 'shell', requestId: randomUUID(), rows: 24, cols: 80 })
  const entry = { ...opened, ownerSessionId: ownerId, offset: 0, output: '', endedByRestart: false }
  terminals.push(entry)
  const claim = await callOwner(ownerId, 'claim', { terminalId: entry.id, viewerId: `verification-${randomUUID()}` })
  entry.lease = claim.lease
  entry.sequence = claim.nextSequence
  return entry
}

try {
  await bootServer()
  report.checks.realOfficialWebBoot = true
  await verifyRuntimePackages()
  report.checks.officialPeerVersionsAndSingleInstances = true
  sessionId = await createSource()
  report.sessionId = sessionId
  report.checks.defaultWorkspaceWrite = true
  const listing = await call('list', {})
  assert.ok(listing.launchers.some(item => item.id === 'shell' && item.available))
  report.checks.packedRemoteReachable = true
  for (let index = 0; index < 6; index++) {
    const entry = await createPty(sessionId)
    await write(entry, "printf '\\033[32m原生PTY_%s\\033[0m\\n' \"$TERM\"\r")
    await readUntil(entry, '\u001b[32m原生PTY_xterm-256color\u001b[0m')
    await call('resize', { terminalId: entry.id, lease: entry.lease, rows: 37 + index, cols: 119 + index })
    await write(entry, 'stty size\r')
    await readUntil(entry, `\r\n${37 + index} ${119 + index}\r\n`)
  }
  assert.equal(new Set(terminals.map(entry => entry.pid)).size, 6)
  report.checks.actualUnpatchedPtyTermUnicodeAnsiResize = true
  report.checks.distinctPtys = true
  report.checks.distinctPtyCount = terminals.length

  // A distinct real owner remains independent of the selected conversation.
  // Only fixture-created PTYs are used; no model requests or credentials.
  const [side, duplicate] = await Promise.all([call('independent', {}), call('independent', {})])
  assert.notEqual(side.sessionId, sessionId)
  assert.equal(side.sessionId, duplicate.sessionId)
  assert.equal(side.mode, 'workspace-write')
  assert.equal(side.cwd, await realpath(workspace))
  assert.equal(side.restored, false)
  assert.deepEqual((await callOwner(side.sessionId, 'list', {})).terminals, [])
  const sidePty = await createPty(side.sessionId)
  await write(sidePty, "printf 'SIDE_TERMINAL_READY\\n'\r")
  await readUntil(sidePty, '\r\nSIDE_TERMINAL_READY\r\n')
  await assert.rejects(call('read', { terminalId: sidePty.id, offset: 0 }), /没有这个终端/)
  await assert.rejects(callOwner(side.sessionId, 'read', { terminalId: terminals[0].id, offset: 0 }), /没有这个终端/)
  await assert.rejects(call('independent', { sessionId }), /原工作区/)
  const otherWorkspace = join(workspace, 'separate-workspace')
  await mkdir(otherWorkspace)
  const otherSessionId = await createSource(otherWorkspace)
  await assert.rejects(callOwner(otherSessionId, 'independent', { sessionId: side.sessionId }), /原工作区/)
  const sameWorkspaceSessionId = await createSource()
  const existing = await callOwner(sameWorkspaceSessionId, 'independent', { sessionId: side.sessionId })
  assert.equal(existing.sessionId, side.sessionId)
  assert.equal((await callOwner(side.sessionId, 'list', {})).terminals[0].pid, sidePty.pid)
  report.checks.independentOwnerAndPtyIsolation = true
  report.checks.independentSurvivesConversationSwitch = true

  handoffOwner = side.sessionId
  const handoffCall = (method, request = {}) => callOwner(handoffOwner, method, request)
  handoffInput = { requestId: randomUUID(), sourceTerminalId: sidePty.id, targetLauncher: 'pi', prompt: 'offline:complete', returnToConversation: false }
  finishedHandoff = await handoffCall('handoffStart', handoffInput)
  assert.ok(finishedHandoff.id && !finishedHandoff.rejected)
  assert.equal((await handoffCall('handoffStart', handoffInput)).id, finishedHandoff.id)
  await until(async () => {
    const task = (await handoffCall('handoffList')).tasks.find(task => task.id === finishedHandoff.id)
    if (task?.status === 'failed') throw new Error(`Protocol fixture failed: ${task.error}`)
    if (task?.status !== 'succeeded') return false
    assert.equal(task.result, 'VERIFIED_NATIVE_HANDOFF'); return true
  }, 'packed handoff completes through real subprocess and native storage')
  assert.equal((await spawnedJobs()).filter(job => job.id === finishedHandoff.id).length, 1)
  assert.ok(!(await call('handoffList', {})).tasks.some(task => task.id === finishedHandoff.id))
  await assert.rejects(call('handoffReturn', { taskId: finishedHandoff.id }), /当前会话/)
  const delivered = await handoffCall('handoffReturn', { taskId: finishedHandoff.id })
  assert.equal(delivered.delivery, 'queued')
  assert.equal((await handoffCall('handoffReturn', { taskId: finishedHandoff.id })).messageId, delivered.messageId)
  const history = await rpc('session.history', { sessionId: handoffOwner })
  const inserted = history.events.flatMap(item => item.event?.type === 'agent/inbox/spliced' ? item.event.data.inserted : [])
  assert.equal(inserted.filter(message => message.id === delivered.messageId).length, 1)
  report.checks.packedProtocolSimulatorCompleteReturnAndDedupe = true
  report.checks.packedHandoffOwnerIsolation = true
  const failed = await handoffCall('handoffStart', { ...handoffInput, requestId: randomUUID(), prompt: 'offline:error' })
  await until(async () => (await handoffCall('handoffList')).tasks.some(task => task.id === failed.id && task.status === 'failed' && !!task.error), 'explicit protocol failure is recorded')
  const cancelled = await handoffCall('handoffStart', { ...handoffInput, requestId: randomUUID(), prompt: 'offline:wait' })
  await until(async () => (await spawnedJobs()).some(job => job.id === cancelled.id), 'cancellable process starts')
  assert.equal((await handoffCall('handoffCancel', { taskId: cancelled.id })).status, 'cancelled')
  await until(async () => (await spawnedJobs()).filter(job => job.id === cancelled.id).every(job => !alive(job.pid)), 'cancelled process is gone')
  interruptedHandoff = await handoffCall('handoffStart', { ...handoffInput, requestId: randomUUID(), prompt: 'offline:wait' })
  await until(async () => (await spawnedJobs()).some(job => job.id === interruptedHandoff.id), 'restart-interrupted process starts')
  report.checks.packedHandoffFailureAndCancellation = true

  // Graceful cold restart proves that the dedicated owner is durable while
  // the PTYs are accurately treated as processes that have stopped.
  server.kill('SIGINT')
  await until(() => server.exitCode !== null || server.signalCode !== null, 'DSH restart shutdown', 15000)
  await until(() => terminals.every(entry => !alive(entry.pid)), 'all bound and independent PTYs stopped with DSH', 5000)
  for (const entry of terminals) entry.endedByRestart = true
  report.checks.independentShutdownDrainsPtys = true
  await bootServer()
  sessionId = await createSource()
  const restored = await call('independent', { sessionId: side.sessionId })
  assert.equal(restored.sessionId, side.sessionId)
  assert.equal(restored.restored, true)
  assert.equal(restored.mode, 'workspace-write')
  assert.deepEqual((await callOwner(restored.sessionId, 'list', {})).terminals, [])
  const records = (await callOwner(restored.sessionId, 'handoffList', {})).tasks
  assert.equal(records.find(task => task.id === finishedHandoff.id)?.delivery, 'queued')
  assert.equal(records.find(task => task.id === finishedHandoff.id)?.result, 'VERIFIED_NATIVE_HANDOFF')
  assert.ok(['interrupted', 'cancelled'].includes(records.find(task => task.id === interruptedHandoff.id)?.status), 'unfinished task must remain stopped after graceful restart')
  assert.equal((await callOwner(restored.sessionId, 'handoffStart', handoffInput)).id, finishedHandoff.id)
  assert.equal((await spawnedJobs()).length, 4, 'restore/retry must not start new processes')
  assert.ok((await spawnedJobs()).every(job => !alive(job.pid)))
  report.checks.packedHandoffColdRestoreNoRerun = true
  const restoredPty = await createPty(restored.sessionId)
  await write(restoredPty, "printf 'SIDE_TERMINAL_RESUMED\\n'\r")
  await readUntil(restoredPty, '\r\nSIDE_TERMINAL_RESUMED\r\n')
  await callOwner(restored.sessionId, 'resize', { terminalId: restoredPty.id, lease: restoredPty.lease, rows: 31, cols: 107 })
  await write(restoredPty, 'stty size\r')
  await readUntil(restoredPty, '\r\n31 107\r\n')
  report.checks.independentColdResumeAndFreshPty = true
  const html = await (await fetch(base)).text()
  assert.ok(html.includes('<html'))
  report.checks.webArtifactServed = true
} catch (error) {
  failure = error
  report.failure = { name: error.name, message: error.code === 'ERR_ASSERTION' ? 'Verification assertion failed; terminal output omitted' : error.message }
} finally {
  const errors = []
  if (server && server.exitCode === null) {
    for (const entry of terminals.filter(entry => !entry.endedByRestart)) {
      try {
        await callOwner(entry.ownerSessionId, 'close', { terminalId: entry.id, lease: entry.lease ?? 'verification-settled' })
      } catch (error) { errors.push(error.message) }
    }
    server.kill('SIGINT')
    try { await until(() => server.exitCode !== null || server.signalCode !== null, 'official DSH shutdown', 10000) }
    catch {
      server.kill('SIGTERM')
      await delay(1000)
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
      errors.push('Official DSH did not complete its normal shutdown deadline')
    }
  }
  try { await until(() => terminals.every(entry => !alive(entry.pid)), 'owned PTY cleanup', 5000); report.cleanup.ptyProcessesGone = true }
  catch (error) { report.cleanup.ptyProcessesGone = false; errors.push(error.message) }
  try { await until(async () => (await spawnedJobs()).every(job => !alive(job.pid)), 'owned handoff process cleanup', 5000); report.cleanup.handoffProcessesGone = true }
  catch (error) { report.cleanup.handoffProcessesGone = false; errors.push(error.message) }
  report.cleanup.errors = errors
  report.cleanup.serverStopped = !server || server.exitCode !== null || server.signalCode !== null
  report.ok = !failure && errors.length === 0 && report.cleanup.serverStopped
  report.finishedAt = new Date().toISOString()
  await mkdir(join(repo, 'artifacts'), { recursive: true })
  await writeFile(join(repo, 'artifacts', `verification-${dshVersion}.json`), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(fixture, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) { await writeFile(join(fixture, 'private-runtime.log'), logs, { mode: 0o600 }); console.error('Verification failed; private diagnostics retained in the isolated fixture.'); process.exitCode = 1 }
}
