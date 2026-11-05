// Minimal inline SVG icon set (stroke icons, 24x24).
const s = (d: string) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const ICON = {
  file: s('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
  open: s('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  save: s('<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>'),
  undo: s('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  redo: s('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
  select: s('<path d="M5 3l14 8-6 2-2 6z"/>'),
  move: s('<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/>'),
  scale: s('<path d="M4 20L20 4M14 4h6v6M10 20H4v-6"/>'),
  rotate: s('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>'),
  part: s('<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/>'),
  script: s('<path d="M8 6l-6 6 6 6M16 6l6 6-6 6M14 4l-4 16"/>'),
  play: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  learn: s('<path d="M2 7l10-4 10 4-10 4z"/><path d="M6 9v5c0 2 3 3 6 3s6-1 6-3V9"/>'),
  panel: s('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>'),
  trash: s('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  copy: s('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  group: s('<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M13 7h4v4M11 17H7v-4"/>'),
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  focus: s('<circle cx="12" cy="12" r="3"/><path d="M3 8V4h4M21 8V4h-4M3 16v4h4M21 16v4h-4"/>'),
  magnet: s('<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/>'),
  output: s('<path d="M4 17l6-6-6-6M12 19h8"/>'),
  close: s('<path d="M6 6l12 12M18 6L6 18"/>'),
  chevron: s('<path d="M9 6l6 6-6 6"/>'),
  cut: s('<circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8 16L20 4M16 16L4 4"/>'),
  paste: s('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2"/>'),
  video: s('<rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3"/>'),
  check: s('<path d="M5 12l5 5L20 7"/>'),
  menu: s('<path d="M4 6h16M4 12h16M4 18h16"/>'),
};

const CLASS_COLORS: Record<string, string> = {
  Workspace: '#4aa3ff', Players: '#ff8c42', Lighting: '#ffd23f', ReplicatedStorage: '#9b5de5', ServerScriptService: '#00bbf9',
  ServerStorage: '#8d99ae', StarterGui: '#f15bb5', StarterPack: '#8338ec', StarterPlayer: '#ff8c42', Teams: '#3a86ff', SoundService: '#06d6a0',
  Part: '#9aa4b1', SpawnLocation: '#2ec4b6', Model: '#e9c46a', Folder: '#f4a261', Script: '#4cc9f0', LocalScript: '#80ed99', ModuleScript: '#c77dff',
  PointLight: '#ffe066', SpotLight: '#ffe066', Humanoid: '#ef476f', ClickDetector: '#ff70a6', WedgePart: '#9aa4b1', Camera: '#adb5bd',
};
export function classBadge(cls: string): string {
  const c = CLASS_COLORS[cls] ?? (/(Value)$/.test(cls) ? '#90be6d' : /Part|Operation/.test(cls) ? '#9aa4b1' : '#6c757d');
  const letter = cls === 'LocalScript' ? 'L' : cls === 'ModuleScript' ? 'M' : cls.replace(/[^A-Z]/g, '').slice(0, 2) || cls[0];
  return `<span class="badge" style="--bc:${c}">${letter}</span>`;
}
