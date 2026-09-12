import test from 'node:test'
import assert from 'node:assert/strict'
import { filterAgents } from '../src/client/agent-library-query.mjs'

const agents = [
  { id: 'shell', label: 'Shell', available: true, executable: '/bin/zsh' },
  { id: 'codex', label: 'Codex', available: true, executable: '/opt/tools/bin/codex' },
  { id: 'piagent', label: 'Pi Agent', available: false, executable: null },
  { id: 'custom', label: 'Local Agent', available: true, executable: 'C:\\Tools\\agent-cli.EXE' },
]

test('pasted names ignore surrounding whitespace and case', () => {
  assert.deepEqual(filterAgents(agents, '  CODEX\n').map(agent => agent.id), ['codex'])
  assert.deepEqual(filterAgents(agents, '\u3000Pi AgEnT\u3000', 'all').map(agent => agent.id), ['piagent'])
})

test('search finds the actual Shell command and executable path', () => {
  assert.deepEqual(filterAgents(agents, 'zsh').map(agent => agent.id), ['shell'])
  assert.deepEqual(filterAgents(agents, '/opt/tools/bin/codex').map(agent => agent.id), ['codex'])
})

test('executable command search also accepts Windows paths', () => {
  assert.deepEqual(filterAgents(agents, 'AGENT-CLI.exe').map(agent => agent.id), ['custom'])
  assert.deepEqual(filterAgents(agents, 'c:\\tools\\agent-cli.exe').map(agent => agent.id), ['custom'])
})

test('search preserves the selected installation filter and original records', () => {
  const before = structuredClone(agents)
  assert.deepEqual(filterAgents(agents, 'piagent'), [])
  assert.deepEqual(filterAgents(agents, 'piagent', 'all'), [agents[2]])
  assert.deepEqual(filterAgents(agents, ' \n ').map(agent => agent.id), ['shell', 'codex', 'custom'])
  assert.deepEqual(filterAgents(agents, '', 'all'), agents)
  assert.deepEqual(agents, before)
})
