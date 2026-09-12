export function filterAgents(agents, query, filter = 'installed') {
  const needle = query.trim().toLowerCase()
  return agents.filter(agent => {
    if (filter === 'installed' && !agent.available) return false
    const executable = agent.executable ?? ''
    const command = executable.split(/[\\/]/).at(-1) ?? ''
    return [agent.label, agent.id, command, executable].some(value => value.toLowerCase().includes(needle))
  })
}
