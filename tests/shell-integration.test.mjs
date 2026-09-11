import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareShellIntegration } from '../src/shell-integration.mjs'

test('shell startup files are temporary, user configuration is never changed, and unsupported shells degrade', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-command-test-'))
  const original = "PS1='USER_PROMPT> '\n"
  await writeFile(join(home, '.zshrc'), original)
  try {
    const integration = await prepareShellIntegration('/bin/zsh', [], { environment: { ZDOTDIR: home } })
    const directory = integration.env.ZDOTDIR
    assert.ok((await readFile(join(directory, '.zshenv'), 'utf8')).includes(home))
    assert.equal(await readFile(join(home, '.zshrc'), 'utf8'), original)
    assert.deepEqual(integration.argv, ['/bin/zsh', '-i'])
    await integration.dispose()
    await assert.rejects(access(directory))
    const fallback = await prepareShellIntegration('/bin/fish', ['-i'])
    assert.deepEqual(fallback.argv, ['/bin/fish', '-i']); assert.equal(fallback.journal.snapshot().status, 'unavailable')
    const denied = await prepareShellIntegration('/bin/zsh', [], { tempRoot: join(home, 'missing') })
    assert.equal(denied.journal.snapshot().status, 'unavailable')
  } finally { await rm(home, { recursive: true, force: true }) }
})

// Set this to the installed official provider's package.json to run against
// its existing node-pty binary. No test installs native modules or credentials.
let nodePty
try {
  const require = createRequire(process.env.DSH_SHELL_PTY_RUNTIME || import.meta.url)
  nodePty = require('node-pty')
} catch {}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function ptyExitBarrier(pty) {
  let exited = false
  const exit = Promise.withResolvers()
  const listener = pty.onExit(() => { exited = true; exit.resolve() })
  const wait = async ms => {
    let timer
    try { return await Promise.race([exit.promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) })]) }
    finally { clearTimeout(timer) }
  }
  return async () => {
    try {
      // node-pty kill() only sends a signal. A shell may still write startup or
      // history files until onExit; keep its temporary rc directory until then.
      if (!exited) pty.kill()
      if (!await wait(1000)) {
        pty.kill('SIGKILL')
        if (!await wait(5000)) throw new Error('Test PTY did not exit; temporary shell files were retained')
      }
    } finally { listener.dispose() }
  }
}
for (const shell of ['zsh', 'bash']) test(`real ${shell} PTY records success/failure and duration while preserving user prompts`, { skip: !nodePty }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-shell-pty-'))
  const original = "PS1='USER_PROMPT> '\nprintf 'USER_RC_LOADED\\n'\n"
  await writeFile(join(home, shell === 'zsh' ? '.zshrc' : '.bashrc'), original)
  const integration = await prepareShellIntegration(`/bin/${shell}`, [], { environment: {} })
  const pty = nodePty.spawn(integration.argv[0], integration.argv.slice(1), { name: 'xterm-256color', cols: 80, rows: 24, cwd: home,
    env: { HOME: home, PATH: process.env.PATH, TERM: 'xterm-256color', ...integration.env } })
  const stop = ptyExitBarrier(pty)
  let display = ''
  const listener = pty.onData(data => { display += integration.journal.feed(data) })
  const until = async predicate => { const end = Date.now() + 5000; while (!predicate()) {
    if (Date.now() > end) throw new Error(`Shell protocol did not settle: ${JSON.stringify({ shell, journal: integration.journal.snapshot().status, fixtureOutput: display.slice(-2000) })}`)
    await delay(10)
  } }
  try {
    await until(() => integration.journal.snapshot().status === 'ready')
    assert.ok(display.includes('USER_RC_LOADED'))
    pty.write("sleep 0.08; printf 'SUCCESS_OUTPUT\\n'\r")
    await until(() => integration.journal.snapshot().records[0]?.status === 'succeeded')
    pty.write("printf 'FAIL_OUTPUT\\n'; false\r")
    await until(() => integration.journal.snapshot().records[1]?.status === 'failed')
    const records = integration.journal.snapshot().records
    assert.equal(records.length, 2)
    assert.equal(records[0].output, 'SUCCESS_OUTPUT\n'); assert.equal(records[0].exitCode, 0); assert.ok(records[0].durationMs >= 60)
    assert.equal(records[1].output, 'FAIL_OUTPUT\n'); assert.equal(records[1].exitCode, 1)
    assert.ok(display.includes('USER_PROMPT> ')); assert.equal(display.includes('dsh-command'), false)
    assert.equal(await readFile(join(home, shell === 'zsh' ? '.zshrc' : '.bashrc'), 'utf8'), original)
  } finally { await stop(); listener.dispose(); await integration.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('existing Bash DEBUG hooks are preserved by explicitly declining command integration', { skip: !nodePty }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-shell-conflict-'))
  const original = "PS1='ORIGINAL_PROMPT> '\ntrap 'printf ORIGINAL_DEBUG_HOOK' DEBUG\n"
  await writeFile(join(home, '.bashrc'), original)
  const integration = await prepareShellIntegration('/bin/bash', [], { environment: {} })
  const pty = nodePty.spawn(integration.argv[0], integration.argv.slice(1), { name: 'xterm-256color', cols: 80, rows: 24, cwd: home,
    env: { HOME: home, PATH: process.env.PATH, TERM: 'xterm-256color', ...integration.env } })
  const stop = ptyExitBarrier(pty)
  let display = ''
  const listener = pty.onData(data => { display += integration.journal.feed(data) })
  try {
    const end = Date.now() + 5000
    while (integration.journal.snapshot().status === 'starting' && Date.now() < end) await delay(10)
    assert.equal(integration.journal.snapshot().status, 'unavailable')
    pty.write("printf 'STILL_WORKS\\n'\r")
    await delay(100)
    assert.ok(display.includes('STILL_WORKS')); assert.ok(display.includes('ORIGINAL_DEBUG_HOOK'))
    assert.equal(integration.journal.snapshot().records.length, 0)
    assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), original)
  } finally { await stop(); listener.dispose(); await integration.dispose(); await rm(home, { recursive: true, force: true }) }
})
