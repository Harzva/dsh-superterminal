import React from 'react';

const paths = {
  plus: <path d="M12 5v14M5 12h14" />,
  sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/><path d="M20 3v4M18 5h4"/></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/></>,
  chevronDown: <path d="m7 10 5 5 5-5"/>,
  chevronRight: <path d="m10 7 5 5-5 5"/>,
  arrowUpRight: <path d="M7 17 17 7M7 7h10v10"/>,
  arrowDown: <path d="M12 4v16m-6-6 6 6 6-6"/>,
  arrowUp: <path d="M12 20V4m-6 6 6-6 6 6"/>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  folder: <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>,
  chat: <path d="M21 11a8 8 0 0 1-8 8H8l-5 3V11a8 8 0 1 1 18 0Z"/>,
  group: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v2"/></>,
  link: <><path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 14a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1" transform="translate(1 0) scale(.92 1)"/></>,
  history: <><path d="M3 11a9 9 0 1 1 3 8M3 4v7h7M12 7v5l3 2"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>,
  command: <path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2Z"/>,
  monitor: <><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
  cloud: <path d="M7 18a5 5 0 1 1 1-10 7 7 0 0 1 13 4 3 3 0 0 1-2 6Z"/>,
  splitX: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></>,
  splitY: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/></>,
  expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>,
  collapse: <path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5"/>,
  minimize: <path d="M5 12h14"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>,
};

export type UiIconName = keyof typeof paths;
export function UiIcon({name, size = 16}: {name: UiIconName; size?: number}) {
  return <svg className="dt-ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
