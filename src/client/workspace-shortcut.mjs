const directions = {ArrowLeft:'left',ArrowRight:'right',ArrowUp:'up',ArrowDown:'down'};

export function workspaceShortcut(event, scope) {
  if (scope !== 'terminal' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null;
  return event.key === 'Enter' ? 'zoom' : directions[event.key] ?? null;
}
