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
for (const file of ['package.json', 'cordis.patch.yml', 'lib/host.mjs', 'lib/remote.mjs', 'lib/pty-compat.mjs', 'lib/client.js', 'README.md', 'LICENSE']) {
  assert.ok(entries.includes(`package/${file}`), `Release artifact must include ${file}`)
}
assert.ok(entries.every(path => path.startsWith('package/') && !path.split('/').includes('..')))

const fixture = await mkdtemp(join(tmpdir(), 'dsh-terminal-verify-'))
const runtime = join(fixture, 'runtime')
const home = join(fixture, 'home')
const workspace = join(fixture, 'workspace')
await Promise.all([mkdir(runtime), mkdir(home), mkdir(workspace)])
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
const childEnv = { ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
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
const call = (method, request) => rpc(`dshTerminal/${method}`, { args: { agentId: sessionId, request } })
async function until(check, label, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await check()) return; await delay(80) }
  throw new Error(`Timed out: ${label}`)
}
async function write(entry, data) {
  const result = await call('write', { terminalId: entry.id, lease: entry.lease, sequence: entry.sequence, data })
  entry.sequence = result.nextSequence
}
async function readUntil(entry, expected) {
  await until(async () => {
    const result = await call('read', { terminalId: entry.id, offset: entry.offset })
    assert.equal(result.gap, false)
    entry.offset = result.nextOffset
    entry.output += result.data
    return entry.output.includes(expected)
  }, 'native terminal output')
}
function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }

try {
  server = spawn(process.execPath, command, { cwd: workspace, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const remember = chunk => { logs = (logs + chunk.toString()).slice(-64000) }
  server.stdout.on('data', remember)
  server.stderr.on('data', remember)
  await until(async () => {
    if (server.exitCode !== null) throw new Error(`Official DSH exited during boot (${server.exitCode})`)
    try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok } catch { return false }
  }, 'official DSH HTTP ready', 45000)
  report.checks.realOfficialWebBoot = true
  await verifyRuntimePackages()
  report.checks.officialPeerVersionsAndSingleInstances = true
  sessionId = (await rpc('session.create', { cwd: workspace })).sessionId
  report.sessionId = sessionId
  await until(async () => {
    const history = await rpc('session.history', { sessionId })
    const current = history.projections?.values?.permissions?.currentValue
    if (current === undefined) return false
    assert.equal(current, 'workspace-write')
    return true
  }, 'permission projection is ready')
  report.checks.defaultWorkspaceWrite = true
  const listing = await call('list', {})
  assert.ok(listing.launchers.some(item => item.id === 'shell' && item.available))
  report.checks.packedRemoteReachable = true
  for (let index = 0; index < 6; index++) {
    const opened = await call('open', { launcher: 'shell', requestId: randomUUID(), rows: 24, cols: 80 })
    const entry = { ...opened, offset: 0, output: '' }
    terminals.push(entry)
    const claim = await call('claim', { terminalId: entry.id, viewerId: `verification-${randomUUID()}` })
    entry.lease = claim.lease
    entry.sequence = claim.nextSequence
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
  const html = await (await fetch(base)).text()
  assert.ok(html.includes('<html'))
  report.checks.webArtifactServed = true
} catch (error) {
  failure = error
  report.failure = { name: error.name, message: error.code === 'ERR_ASSERTION' ? 'Verification assertion failed; terminal output omitted' : error.message }
} finally {
  const errors = []
  if (server && server.exitCode === null) {
    for (const entry of terminals) {
      try {
        await call('close', { terminalId: entry.id, lease: entry.lease ?? 'verification-settled' })
      } catch (error) { errors.push(error.message) }
    }
    try { await until(() => terminals.every(entry => !alive(entry.pid)), 'owned PTY cleanup', 5000); report.cleanup.ptyProcessesGone = true }
    catch (error) { errors.push(error.message) }
    server.kill('SIGINT')
    try { await until(() => server.exitCode !== null || server.signalCode !== null, 'official DSH shutdown', 10000) }
    catch {
      server.kill('SIGTERM')
      await delay(1000)
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL')
      errors.push('Official DSH did not complete its normal shutdown deadline')
    }
  }
  report.cleanup.errors = errors
  report.cleanup.serverStopped = !server || server.exitCode !== null || server.signalCode !== null
  report.ok = !failure && errors.length === 0 && report.cleanup.serverStopped
  report.finishedAt = new Date().toISOString()
  await mkdir(join(repo, 'artifacts'), { recursive: true })
  await writeFile(join(repo, 'artifacts', `verification-${dshVersion}.json`), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(fixture, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) { console.error(logs); process.exitCode = 1 }
}
