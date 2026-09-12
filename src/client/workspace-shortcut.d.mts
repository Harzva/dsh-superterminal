export function workspaceShortcut(event: {
  key: string; altKey: boolean; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean;
  defaultPrevented?: boolean; isComposing?: boolean; keyCode?: number;
}, scope: 'terminal' | 'editor' | 'blocked'): 'zoom' | 'left' | 'right' | 'up' | 'down' | null;
