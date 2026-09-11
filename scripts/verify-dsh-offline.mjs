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
for (const file of ['package.json', 'cordis.patch.yml', 'lib/host.mjs', 'lib/remote.mjs', 'lib/independent-scope.mjs', 'lib/terminal-runs.mjs', 'lib/native-result-text.mjs', 'lib/terminal-groups.mjs', 'lib/terminal-group-journal.mjs', 'lib/pty-compat.mjs', 'lib/handoffs.mjs', 'lib/handoff-journal.mjs', 'lib/handoff-return.mjs', 'lib/cli-state.mjs', 'lib/agent-readiness.mjs', 'lib/shell-integration.mjs', 'lib/command-journal.mjs', 'lib/client.js', 'README.md', 'LICENSE']) {
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
const goal = task.task.match(/本次用户目标：\\n([\\s\\S]*?)\\n\\n共享讨论材料/)?.[1] ?? task.task
const group = goal.startsWith('offline:group-')
const failed = goal === 'offline:error' || goal === 'offline:group-error'
appendFileSync('protocol-spawns.jsonl', JSON.stringify({ id: process.env.DSH_HANDOFF_TASK_ID, pid: process.pid }) + '\\n')
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n')
emit({ type: 'agent_start' })
if (goal === 'offline:wait' || goal === 'offline:group-wait') {
  setInterval(() => {}, 1000)
} else {
  emit({ type: 'message_end', message: { role: 'assistant', stopReason: failed ? 'error' : 'stop',
    errorMessage: failed ? 'Offline protocol fixture failure' : undefined,
    content: [{ type: 'text', text: failed ? '' : goal === 'offline:group-long' ? 'LONG_REPLY_START' + 'x'.repeat(18000) + 'LONG_REPLY_END' : goal === 'offline:group-conclusion' ? 'VERIFIED_GROUP_CONCLUSION' : group ? 'VERIFIED_GROUP_REPLY' : 'VERIFIED_NATIVE_HANDOFF' }] } })
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
const runtimePackageSources = {}
async function verifyWebPlatformSeed(name) {
  const frontend = '@deepseek-ai/dsh-web-frontend'
  const runtimePackage = await realpath(runtimeRequire.resolve(`${frontend}/package.json`))
  const pluginPackage = await realpath(pluginRequire.resolve(`${frontend}/package.json`))
  assert.equal(pluginPackage, runtimePackage, 'The plugin must use the official runtime frontend')
  const frontendVersion = JSON.parse(await readFile(runtimePackage, 'utf8')).version
  assert.equal(frontendVersion, dshVersion, 'The browser platform seed must come from the selected official frontend')
  const dist = join(dirname(runtimePackage), 'dist')
  const officialHtml = await readFile(join(dist, 'index.html'), 'utf8')
  const response = await fetch(base, { signal: AbortSignal.timeout(10000) })
  assert.equal(response.ok, true, 'The official frontend must be served')
  const servedHtml = await response.text()
  let evidence
  for (const [, source] of officialHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
    const url = new URL(source, base)
    if (url.origin !== base || !url.pathname.startsWith('/assets/') || !url.pathname.endsWith('.js')) continue
    const asset = await readFile(join(dist, url.pathname.slice(1)))
    const code = asset.toString('utf8')
    // The pinned official shell exports React primitives through its platform
    // seed, not through a Node package installed beside the CLI or plugin.
    const seed = code.match(/"@deepseek-ai\/dsh-client-ui-primitives"\s*:\s*([\w$]+)/)
    if (!seed) continue
    const identifier = seed[1].replaceAll('$', '\\$')
    const namespace = code.match(new RegExp(`${identifier}\\s*=\\s*Object\\.freeze\\(Object\\.defineProperty\\(\\{([^}]+)\\},`))
    assert.ok(namespace && /\bMarkdownText\s*:/.test(namespace[1]), 'The public platform seed must export MarkdownText')
    assert.ok(servedHtml.includes(`src="${source}"`), 'The live frontend must load the verified official asset')
    const served = await fetch(url, { signal: AbortSignal.timeout(10000) })
    assert.equal(served.ok, true, 'The platform seed asset must be reachable')
    const hash = bytes => createHash('sha256').update(bytes).digest('hex')
    assert.equal(hash(Buffer.from(await served.arrayBuffer())), hash(asset), 'The served platform seed must match the official installed frontend')
    evidence = { kind: 'web-platform-seed', package: frontend, version: frontendVersion, assetSha256: hash(asset), exports: ['MarkdownText'] }
    break
  }
  assert.ok(evidence, `${name} must be present in the official frontend platform seed`)
  runtimePackages[name] = frontendVersion
  runtimePackageSources[name] = evidence
}
async function verifyRuntimePackages() {
  // Official profile boot creates its runtime-package bridge. Check the actual
  // resulting resolution after boot, before allocating any test terminals.
  for (const name of Object.keys(manifest.peerDependencies).filter(name => name.startsWith('@deepseek-ai/'))) {
    assert.equal(packed.peerDependencies?.[name], dshVersion, `${name} must declare the selected official version in the release artifact`)
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      await verifyWebPlatformSeed(name)
      continue
    }
    const runtimePackage = await realpath(runtimeRequire.resolve(`${name}/package.json`))
    const pluginPackage = await realpath(pluginRequire.resolve(`${name}/package.json`))
    assert.equal(pluginPackage, runtimePackage, `${name} must resolve to the official runtime's single package instance`)
    runtimePackages[name] = JSON.parse(await readFile(pluginPackage, 'utf8')).version
    assert.equal(runtimePackages[name], dshVersion, `${name} must use the selected official version`)
    runtimePackageSources[name] = { kind: 'node-single-instance', version: runtimePackages[name] }
  }
}

const port = await new Promise((resolvePort, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolvePort(port)) })
})
const base = `http://127.0.0.1:${port}`
const command = [cli, '--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']
const report = { schema: 1, artifactSha256: createHash('sha256').update(artifactBytes).digest('hex'), pluginVersion: manifest.version, dshVersion, runtimePackages, runtimePackageSources, fixture, profile, workspace, cli, port, command,
  groupEvidence: { kind: 'offline-protocol-simulator', realModelVerified: false }, checks: {}, cleanup: {}, startedAt: new Date().toISOString() }
await writeFile(join(fixture, 'restart.json'), JSON.stringify({ executable: process.execPath, args: command, cwd: workspace, env: childEnv }, null, 2) + '\n')
let server
let logs = ''
let sessionId
const terminals = []
const spawnedJobs = async () => { try { return (await readFile(join(workspace, 'protocol-spawns.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
let handoffOwner, handoffInput, finishedHandoff, interruptedHandoff, reviewedHandoff
let completedGroup, completedGroupInput, stoppedGroup, stoppedGroupInput, spawnCountBeforeRestart
let crashCleanupPids = []
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

async function createPty(ownerId, launcher = 'shell') {
  const opened = await callOwner(ownerId, 'open', { launcher, requestId: randomUUID(), rows: 24, cols: 80 })
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
    if (index === 0) {
      await until(async () => (await call('commands', {terminalId:entry.id})).records.some(record=>record.command==='stty size' && record.exitCode===0 && record.output.includes('37 119')), 'real command boundary and successful exit code')
      await write(entry, "printf 'COMMAND_FAILURE_OUTPUT\\n'; false\r")
      await until(async () => {
        const records=(await call('commands',{terminalId:entry.id})).records
        const failure=records.find(record=>record.command.includes('COMMAND_FAILURE_OUTPUT')&&record.status==='failed')
        if(!failure)return false
        assert.equal(failure.exitCode,1);assert.ok(failure.durationMs>=0)
        assert.ok(failure.output.includes('COMMAND_FAILURE_OUTPUT'))
        assert.ok(!failure.output.includes('harzva'));return true
      }, 'real failed command retains output, duration and command exit code')
      report.checks.actualShellCommandSuccessFailureAndTiming = true
    }
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
  await assert.rejects(callOwner(side.sessionId, 'commands', { terminalId: terminals[0].id }), /没有这个终端/)
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

  // Reading natural-language execution state must not allocate an executor or
  // run a model. Real native execution is verified separately with a model.
  const sessionBaseline = (await rpc('session.list', {})).items.map(item => item.sessionId).sort()
  for (let index = 0; index < 3; index++) {
    for (const entry of [terminals[0], sidePty]) {
      const state = await callOwner(entry.ownerSessionId, 'runState', { terminalId: entry.id })
      assert.equal(state.terminalId, entry.id)
      assert.equal(state.status, 'idle')
      assert.deepEqual(state.messages, [])
      assert.deepEqual(state.acceptedRequestIds, [])
      assert.equal(state.sessionId, undefined, 'Read-only state must not bind an execution session')
      assert.equal(state.policy.mode, 'workspace-write')
      assert.equal(state.policy.approval, 'never')
    }
  }
  await assert.rejects(call('runState', { terminalId: sidePty.id }), /没有这个终端/)
  await assert.rejects(callOwner(side.sessionId, 'runState', { terminalId: terminals[0].id }), /没有这个终端/)
  for (const ownerId of [sessionId, side.sessionId]) {
    await assert.rejects(callOwner(ownerId, 'runResult', { terminalId: terminals[0].id, messageId: 'assistant-1-0', offset: 0 }))
  }
  await assert.rejects(call('runResult', { terminalId: terminals[0].id, messageId: 'assistant-1-0', offset: 0, limit: 16001 }))
  const sessionsAfterState = (await rpc('session.list', {})).items
  assert.deepEqual(sessionsAfterState.map(item => item.sessionId).sort(), sessionBaseline,
    'Polling empty execution state must not allocate a native Agent session')
  assert.ok(sessionsAfterState.every(item => !item.running), 'Read-only state must not start an Agent turn')
  assert.deepEqual((await call('list', {})).terminals.map(entry => entry.id).sort(),
    terminals.filter(entry => entry.ownerSessionId === sessionId).map(entry => entry.id).sort())
  assert.deepEqual((await callOwner(side.sessionId, 'list', {})).terminals.map(entry => entry.id), [sidePty.id])
  report.checks.nativeRunEmptyStateDoesNotAllocateOrExecute = true
  report.checks.nativeRunReadOwnerIsolation = true
  report.checks.nativeResultReadDoesNotAllocateOrExecute = true

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
  const piHealth=(await handoffCall('inventory')).agents.find(agent=>agent.id==='pi').health
  assert.equal(piHealth.connection.state,'last_succeeded')
  assert.equal(piHealth.quota.state,'unknown')
  assert.ok(piHealth.connection.checkedAt)
  report.checks.agentReadinessUsesTimestampedExecutionEvidence = true
  const reworkInput={taskId:finishedHandoff.id,requestId:randomUUID(),issues:'补上失败用例的说明；保留原任务与结果供核对。',returnToConversation:false}
  reviewedHandoff=await handoffCall('handoffRework',reworkInput)
  assert.ok(reviewedHandoff.id&&!reviewedHandoff.rejected)
  assert.equal(reviewedHandoff.parentTaskId,finishedHandoff.id)
  assert.equal((await handoffCall('handoffRework',reworkInput)).id,reviewedHandoff.id)
  await until(async()=>(await handoffCall('handoffList')).tasks.some(task=>task.id===reviewedHandoff.id&&task.status==='succeeded'),'rework task completes')
  const reviewInput={taskId:reviewedHandoff.id,requestId:randomUUID(),notes:'已核对返回内容与完成判据。'}
  assert.equal((await handoffCall('handoffAccept',reviewInput)).acceptance,'accepted')
  assert.equal((await handoffCall('handoffAccept',reviewInput)).acceptance,'accepted')
  await assert.rejects(call('handoffAccept',reviewInput),/当前会话/)
  assert.equal((await handoffCall('handoffRework',{...reworkInput,taskId:reviewedHandoff.id,requestId:randomUUID()})).rejected,true)
  assert.equal((await spawnedJobs()).filter(job=>job.id===reviewedHandoff.id).length,1)
  report.checks.packedExplicitAcceptanceAndReworkDedupe = true
  const failed = await handoffCall('handoffStart', { ...handoffInput, requestId: randomUUID(), prompt: 'offline:error' })
  await until(async () => (await handoffCall('handoffList')).tasks.some(task => task.id === failed.id && task.status === 'failed' && !!task.error), 'explicit protocol failure is recorded')
  const cancelled = await handoffCall('handoffStart', { ...handoffInput, requestId: randomUUID(), prompt: 'offline:wait' })
  await until(async () => (await spawnedJobs()).some(job => job.id === cancelled.id), 'cancellable process starts')
  assert.equal((await handoffCall('handoffCancel', { taskId: cancelled.id })).status, 'cancelled')
  await until(async () => (await spawnedJobs()).filter(job => job.id === cancelled.id).every(job => !alive(job.pid)), 'cancelled process is gone')

  // These are real installed Group RPCs, storage domains and managed child
  // processes. Only the child response protocol is simulated, never a model.
  const groupPtys = [await createPty(handoffOwner, 'pi'), await createPty(handoffOwner, 'pi')]
  const beforeGroupInventory = (await rpc('session.list', {})).items.map(item => item.sessionId).sort()
  const groupInventory = await handoffCall('groupList')
  for (const entry of groupPtys) {
    const candidate = groupInventory.candidates.find(row => row.terminalId === entry.id)
    assert.equal(candidate.launcher, 'pi')
    assert.equal(candidate.modes.find(row => row.mode === 'cli').available, true)
  }
  assert.deepEqual((await rpc('session.list', {})).items.map(item => item.sessionId).sort(), beforeGroupInventory,
    'Group candidates must not allocate native Agent sessions')
  const createGroupInput = { requestId: randomUUID(), title: 'Offline protocol discussion', members: groupPtys.map((entry, index) => ({
    terminalId: entry.id, mode: 'cli', title: `Protocol participant ${index + 1}`,
  })) }
  completedGroup = await handoffCall('groupCreate', createGroupInput)
  assert.equal((await handoffCall('groupCreate', createGroupInput)).id, completedGroup.id)
  assert.deepEqual(completedGroup.members.map(member => member.launcher), ['pi', 'pi'])
  await assert.rejects(call('groupRead', { groupId: completedGroup.id }), /当前会话/)
  await assert.rejects(call('groupCreate', { ...createGroupInput, requestId: randomUUID() }), /当前会话|不属于/)
  const beforeInvalidGroup = (await handoffCall('groupList')).groups.map(group => group.id).sort()
  // The public gateway may replace Zod's Chinese validation detail with its
  // generic RPC error. Assert rejection at this endpoint and no allocation,
  // rather than requiring a private validation message to cross the gateway.
  await assert.rejects(handoffCall('groupCreate', { ...createGroupInput, requestId: randomUUID(), members: [createGroupInput.members[0], createGroupInput.members[0]] }), /dshTerminal\/groupCreate:/)
  assert.deepEqual((await handoffCall('groupList')).groups.map(group => group.id).sort(), beforeInvalidGroup)
  completedGroupInput = { groupId: completedGroup.id, requestId: randomUUID(), prompt: 'offline:group-complete',
    targets: completedGroup.members.map(member => member.id), rounds: 2, kind: 'discussion', excerpt: { terminalId: sidePty.id, text: 'EXPLICIT_OFFLINE_GROUP_MATERIAL' } }
  await handoffCall('groupSend', completedGroupInput)
  await until(async () => {
    const group = await handoffCall('groupRead', { groupId: completedGroup.id })
    if (group.status === 'failed') throw new Error(`Group protocol fixture failed: ${group.operation?.error}`)
    if (group.status !== 'completed') return false
    const replies = group.messages.filter(message => message.kind === 'reply')
    assert.equal(replies.length, 4)
    assert.deepEqual(replies.map(reply => reply.round), [1, 1, 2, 2])
    for (const reply of replies) {
      assert.equal(reply.text, 'VERIFIED_GROUP_REPLY'); assert.equal(reply.mode, 'cli'); assert.equal(reply.launcher, 'pi')
      assert.ok(groupPtys.some(entry => entry.id === reply.terminalId)); assert.equal(reply.model, undefined)
      assert.ok(reply.taskId)
    }
    assert.equal(new Set(replies.map(reply => reply.taskId)).size, 4)
    completedGroup = group; return true
  }, 'installed group completes two rounds through the offline protocol simulator', 20000)
  const groupChildren = (await handoffCall('handoffList')).tasks.filter(task => task.sourceGroupId === completedGroup.id)
  assert.equal(groupChildren.length, 4)
  assert.ok(groupChildren.every(task => task.groupPurpose === 'discussion' && task.returnToConversation === false && task.delivery === 'none'))
  for (const task of groupChildren) assert.equal((await spawnedJobs()).filter(job => job.id === task.id).length, 1)
  const groupSpawnBaseline = (await spawnedJobs()).length
  assert.equal((await handoffCall('groupSend', completedGroupInput)).id, completedGroup.id)
  await assert.rejects(handoffCall('groupSend', { ...completedGroupInput, prompt: 'changed request' }), /标识/)
  await assert.rejects(call('groupSend', completedGroupInput), /当前会话/)
  assert.equal((await spawnedJobs()).length, groupSpawnBaseline)
  for (const entry of groupPtys) {
    const original = await handoffCall('read', { terminalId: entry.id, offset: 0 })
    assert.doesNotMatch(original.data, /offline:group|VERIFIED_GROUP_REPLY|EXPLICIT_OFFLINE_GROUP_MATERIAL/, 'Discussion input and reply must never be injected into the existing PTY')
  }
  await handoffCall('groupSend', { groupId: completedGroup.id, requestId: randomUUID(), prompt: 'offline:group-conclusion',
    targets: [completedGroup.members[0].id], rounds: 1, kind: 'conclusion' })
  await until(async () => {
    const group = await handoffCall('groupRead', { groupId: completedGroup.id })
    if (group.status === 'failed') throw new Error(`Group conclusion fixture failed: ${group.operation?.error}`)
    if (group.status !== 'completed') return false
    assert.equal(group.messages.at(-1).kind, 'conclusion'); assert.equal(group.messages.at(-1).text, 'VERIFIED_GROUP_CONCLUSION')
    return true
  }, 'one explicit member forms an offline protocol conclusion')
  report.checks.packedGroupProtocolRoundsConclusionAndIdentity = true
  report.checks.packedGroupDedupeOwnerIsolationAndUntouchedPtys = true
  report.checks.groupCandidateReadDoesNotAllocateNativeSession = true

  // Completed discussion turns retain their replay identities, but do not
  // consume the separate execution/rework record budget.
  for (let meeting = 0; meeting < 7; meeting++) {
    const input = { ...completedGroupInput, requestId: randomUUID() }
    await handoffCall('groupSend', input)
    await until(async () => {
      const group = await handoffCall('groupRead', { groupId: completedGroup.id })
      if (group.status === 'failed') throw new Error(`Repeated discussion failed: ${group.operation?.error}`)
      return group.status === 'completed' && group.messages.filter(message => message.requestId === input.requestId && message.kind === 'reply').length === 4
    }, 'discussion remains available beyond the execution record budget', 20000)
  }
  const retainedDiscussions = (await handoffCall('handoffList')).tasks.filter(task => task.groupPurpose === 'discussion')
  assert.equal(retainedDiscussions.length, 33)
  const executionList = (await handoffCall('handoffList', { includeDiscussions: false })).tasks
  assert.ok(executionList.length > 0 && executionList.every(task => task.groupPurpose !== 'discussion'))
  const afterDiscussions = await handoffCall('handoffStart', { ...handoffInput, requestId: randomUUID() })
  assert.ok(afterDiscussions.id && !afterDiscussions.rejected)
  await until(async () => (await handoffCall('handoffList')).tasks.some(task => task.id === afterDiscussions.id && task.status === 'succeeded'), 'execution is still available after 33 discussion records')
  const afterDiscussionRework = await handoffCall('handoffRework', { taskId: afterDiscussions.id, requestId: randomUUID(), issues: 'Verify the retained discussion does not block rework.', returnToConversation: false })
  assert.ok(afterDiscussionRework.id && !afterDiscussionRework.rejected)
  await until(async () => (await handoffCall('handoffList')).tasks.some(task => task.id === afterDiscussionRework.id && task.status === 'succeeded'), 'rework is still available after 33 discussion records')
  const retainedSpawnCount = (await spawnedJobs()).length
  await handoffCall('groupSend', completedGroupInput)
  assert.equal((await spawnedJobs()).length, retainedSpawnCount, 'Old discussion identities still prevent duplicate execution')
  report.checks.packedDiscussionBudgetPreservesExecutionReworkAndDedupe = true

  await handoffCall('groupSend', { groupId: completedGroup.id, requestId: randomUUID(), prompt: 'offline:group-long',
    targets: [completedGroup.members[0].id], rounds: 1, kind: 'discussion' })
  await until(async () => {
    const group = await handoffCall('groupRead', { groupId: completedGroup.id })
    if (group.status === 'failed') throw new Error(`Long reply fixture failed: ${group.operation?.error}`)
    if (group.status !== 'completed') return false
    const reply = group.messages.at(-1)
    assert.equal(reply.kind, 'reply'); assert.equal(reply.truncated, true)
    assert.equal(reply.sourceTruncated, true); assert.equal(reply.totalLength, 'LONG_REPLY_START'.length + 18000 + 'LONG_REPLY_END'.length)
    assert.ok(reply.text.length <= 16000 && reply.text.startsWith('LONG_REPLY_START'))
    assert.equal(reply.resultRef, undefined, 'CLI results must not advertise a nonexistent full native original')
    completedGroup = group
    return true
  }, 'long CLI discussion records explicitly distinguish retained preview from full original')
  report.checks.packedCliLongReplyTruncationIsExplicit = true

  stoppedGroup = await handoffCall('groupCreate', { requestId: randomUUID(), title: 'Offline cancellation discussion', members: [createGroupInput.members[0]] })
  stoppedGroupInput = { groupId: stoppedGroup.id, requestId: randomUUID(), prompt: 'offline:group-wait', targets: [stoppedGroup.members[0].id], rounds: 1, kind: 'discussion' }
  await handoffCall('groupSend', stoppedGroupInput)
  let stoppedGroupTask
  await until(async () => {
    stoppedGroupTask = (await handoffCall('handoffList')).tasks.find(task => task.sourceGroupId === stoppedGroup.id)
    return stoppedGroupTask && (await spawnedJobs()).some(job => job.id === stoppedGroupTask.id)
  }, 'group cancellation protocol process starts')
  await assert.rejects(handoffCall('groupUpdate', { ...createGroupInput, groupId: stoppedGroup.id, requestId: randomUUID() }), /等待|停止/)
  await assert.rejects(call('groupStop', { groupId: stoppedGroup.id }), /当前会话/)
  const stopped = await handoffCall('groupStop', { groupId: stoppedGroup.id })
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.messages.filter(message => message.kind === 'reply').length, 0)
  await until(async () => (await spawnedJobs()).filter(job => job.id === stoppedGroupTask.id).every(job => !alive(job.pid)), 'explicit group stop drains only its child process')
  assert.equal((await handoffCall('groupSend', stoppedGroupInput)).status, 'cancelled')
  assert.equal((await spawnedJobs()).filter(job => job.id === stoppedGroupTask.id).length, 1)
  report.checks.packedGroupStopAndCancelledRequestNoReplay = true
  stoppedGroupInput = { ...stoppedGroupInput, requestId: randomUUID() }
  await handoffCall('groupSend', stoppedGroupInput)
  await until(async () => {
    const task = (await handoffCall('handoffList')).tasks.find(task => task.sourceGroupId === stoppedGroup.id && task.id !== stoppedGroupTask.id)
    return task && (await spawnedJobs()).some(job => job.id === task.id)
  }, 'group child is running before graceful restart')
  interruptedHandoff = await handoffCall('handoffStart', { ...handoffInput, requestId: randomUUID(), prompt: 'offline:wait' })
  await until(async () => (await spawnedJobs()).some(job => job.id === interruptedHandoff.id), 'restart-interrupted process starts')
  spawnCountBeforeRestart = (await spawnedJobs()).length
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
  assert.equal(records.find(task => task.id === finishedHandoff.id)?.acceptance,'rework')
  assert.equal(records.find(task => task.id === reviewedHandoff.id)?.acceptance,'accepted')
  assert.equal(records.find(task => task.id === reviewedHandoff.id)?.parentTaskId,finishedHandoff.id)
  report.checks.packedAcceptanceSurvivesColdRestart = true
  assert.ok(['interrupted', 'cancelled'].includes(records.find(task => task.id === interruptedHandoff.id)?.status), 'unfinished task must remain stopped after graceful restart')
  assert.equal((await callOwner(restored.sessionId, 'handoffStart', handoffInput)).id, finishedHandoff.id)
  assert.equal((await spawnedJobs()).length, spawnCountBeforeRestart, 'restore/retry must not start new processes')
  assert.ok((await spawnedJobs()).every(job => !alive(job.pid)))
  report.checks.packedHandoffColdRestoreNoRerun = true
  const restoredGroup = await callOwner(restored.sessionId, 'groupRead', { groupId: completedGroup.id })
  assert.equal(restoredGroup.status, 'completed')
  assert.deepEqual(restoredGroup.messages, completedGroup.messages)
  assert.equal(restoredGroup.messages.at(-1).sourceTruncated, true)
  const restoredStoppedGroup = await callOwner(restored.sessionId, 'groupRead', { groupId: stoppedGroup.id })
  assert.ok(['interrupted', 'cancelled'].includes(restoredStoppedGroup.status))
  assert.equal((await callOwner(restored.sessionId, 'groupSend', stoppedGroupInput)).status, restoredStoppedGroup.status)
  assert.equal((await callOwner(restored.sessionId, 'groupSend', completedGroupInput)).id, completedGroup.id)
  await assert.rejects(call('groupRead', { groupId: completedGroup.id }), /当前会话/)
  assert.equal((await spawnedJobs()).length, spawnCountBeforeRestart)
  assert.equal((await callOwner(restored.sessionId, 'groupArchive', { groupId: completedGroup.id })).archived, true)
  assert.ok(!(await callOwner(restored.sessionId, 'groupList', {})).groups.some(group => group.id === completedGroup.id))
  assert.deepEqual((await callOwner(restored.sessionId, 'groupRead', { groupId: completedGroup.id })).messages, completedGroup.messages)
  report.checks.packedGroupColdRestoreArchiveAndNoReplay = true
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

  // A separate crash probe distinguishes journal recovery from the graceful
  // cancellation above. The killed server and every explicitly drained PID
  // were created by this fixture; it never signals an existing DSH or user CLI.
  const crashPty = await createPty(restored.sessionId, 'pi')
  const crashGroup = await callOwner(restored.sessionId, 'groupCreate', { requestId: randomUUID(), title: 'Offline crash recovery',
    members: [{ terminalId: crashPty.id, mode: 'cli', title: 'Crash protocol participant' }] })
  const crashInput = { groupId: crashGroup.id, requestId: randomUUID(), prompt: 'offline:group-wait',
    targets: [crashGroup.members[0].id], rounds: 1, kind: 'discussion' }
  await callOwner(restored.sessionId, 'groupSend', crashInput)
  let crashTask, crashProcess
  await until(async () => {
    crashTask = (await callOwner(restored.sessionId, 'handoffList', {})).tasks.find(task => task.sourceGroupId === crashGroup.id)
    crashProcess = crashTask && (await spawnedJobs()).find(job => job.id === crashTask.id)
    return crashProcess && alive(crashProcess.pid)
  }, 'crash probe group process starts')
  assert.equal((await callOwner(restored.sessionId, 'groupRead', { groupId: crashGroup.id })).status, 'running')
  const beforeCrashSpawns = (await spawnedJobs()).length
  const crashPtys = terminals.filter(entry => !entry.endedByRestart)
  const ownedCrashPids = [...new Set([...crashPtys.map(entry => entry.pid), crashProcess.pid])]
  crashCleanupPids = ownedCrashPids
  server.kill('SIGKILL')
  await until(() => server.exitCode !== null || server.signalCode !== null, 'fixture server crash exits', 5000)
  const signalOwned = signal => {
    for (const pid of ownedCrashPids) {
      if (!alive(pid)) continue
      try { process.kill(pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  signalOwned('SIGTERM')
  try { await until(() => ownedCrashPids.every(pid => !alive(pid)), 'fixture crash children stop', 3000) }
  catch { signalOwned('SIGKILL'); await until(() => ownedCrashPids.every(pid => !alive(pid)), 'fixture crash children are drained', 3000) }
  for (const entry of crashPtys) entry.endedByRestart = true
  report.checks.fixtureCrashProcessesExplicitlyDrained = true
  await bootServer()
  sessionId = await createSource()
  const crashOwner = await call('independent', { sessionId: side.sessionId })
  assert.equal(crashOwner.restored, true)
  const interruptedGroup = await callOwner(crashOwner.sessionId, 'groupRead', { groupId: crashGroup.id })
  assert.equal(interruptedGroup.status, 'interrupted')
  assert.equal(interruptedGroup.operation.status, 'interrupted')
  assert.equal(interruptedGroup.operation.activeMemberId, undefined)
  assert.equal(interruptedGroup.messages.filter(message => message.kind === 'reply').length, 0)
  assert.equal((await callOwner(crashOwner.sessionId, 'handoffList', {})).tasks.find(task => task.id === crashTask.id)?.status, 'interrupted')
  assert.equal((await callOwner(crashOwner.sessionId, 'groupSend', crashInput)).status, 'interrupted')
  await assert.rejects(call('groupRead', { groupId: crashGroup.id }), /当前会话/)
  assert.deepEqual((await callOwner(crashOwner.sessionId, 'list', {})).terminals, [])
  assert.equal((await spawnedJobs()).length, beforeCrashSpawns, 'Crash recovery must not replay an accepted group or child request')
  assert.ok((await spawnedJobs()).every(job => !alive(job.pid)))
  report.checks.packedGroupCrashRecoveryInterruptedWithoutReplay = true
} catch (error) {
  failure = error
  report.failure = { name: error.name, message: error.code === 'ERR_ASSERTION' ? 'Verification assertion failed; terminal output omitted' : error.message,
    location: error.stack?.split('\n').find(line=>line.includes('verify-dsh-offline.mjs:'))?.trim() }
} finally {
  const errors = []
  if (server && server.exitCode === null && server.signalCode === null) {
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
  // Also drain the explicitly captured crash-fixture children if an assertion
  // interrupted the crash/reboot sequence before its normal cleanup finished.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of crashCleanupPids) {
      try { if (alive(pid)) process.kill(pid, signal) } catch (error) { if (error.code !== 'ESRCH') errors.push('Could not signal a crash-fixture child') }
    }
    if (crashCleanupPids.some(pid => alive(pid))) await delay(200)
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
