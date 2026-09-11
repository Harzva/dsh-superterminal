/** Derive availability without changing the user's selected recipients or author. */
export function memberReadiness(member, terminals, candidates) {
  if (!terminals.some(terminal => terminal.id === member.terminalId)) return { available: false, canOpen: false, label: '终端已关闭', detail: '终端已关闭，历史发言仍保留。' }
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
