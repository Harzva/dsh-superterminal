/** Derive availability without changing the user's selected recipients or author. */
export function memberReadiness(member, terminals, candidates) {
  const terminal = terminals.find(terminal => terminal.id === member.terminalId)
  if (!terminal) return { available: false, canOpen: false, label: '终端已关闭', detail: '终端已关闭，历史发言仍保留。' }
  if (terminal.execution?.kind === 'ssh') return {available: false, canOpen: true, label: '远端暂不支持参会', detail: 'DSH AI 尚未连接远端工作区，请使用远端 Agent CLI。'}
  const candidate = candidates.find(item => item.terminalId === member.terminalId)
  const mode = candidate?.modes.find(item => item.mode === member.mode)
  if (!mode) return { available: false, canOpen: true, label: '等待检查', detail: '尚未确认当前参会身份是否可用，请刷新后重试。' }
  return { available: mode.available === true, canOpen: true, label: mode.available ? '可参会' : '暂不可用', detail: mode.detail || (mode.available ? '当前参会身份可用。' : '当前参会身份暂不可用。') }
}
export function groupReadiness(members, terminals, candidates, targets, author) {
  const byId = new Map(members.map(member => [member.id, memberReadiness(member, terminals, candidates)]))
  const invalidTargets = targets.filter(id => !byId.get(id)?.available)
  return { byId, targets: [...targets], author, invalidTargets, canSend: targets.length > 0 && invalidTargets.length === 0, canConclude: byId.get(author)?.available === true }
}
