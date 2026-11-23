// A snapshot in the shapes the Mac app really sends, with names anonymized.
// Browser tabs cannot be read (no Automation grant), so browser windows carry `browser: null`
// and only the active tab's title. Terminals report the shell's folder as `document`.

import type { MatchableContext, TitleEntry } from '../../../src/contexts/matcher.ts';

export interface FixtureWindow {
  readonly key: string;
  readonly app: string;
  readonly bundleId: string;
  readonly pid: number;
  readonly title: string;
  readonly document: string | null;
  readonly browser: null;
  /** Context id the window belongs to; null means it must stay Unsorted. */
  readonly expected: string | null;
}

const ROOT = '/Users/dev/work';

export const liveContexts: readonly MatchableContext[] = [
  {
    id: 'yard', name: 'mission-control', folder: `${ROOT}/mission-control`, aliases: ['yardmaster'],
    patterns: ['github.com/devuser/mission-control', 'localhost:4280'],
  },
  { id: 'lesson', name: 'lesson', folder: `${ROOT}/lesson`, aliases: [], patterns: ['github.com/devuser/lesson', 'vercel.com/*/lesson-web'] },
  { id: 'root', name: 'work', folder: ROOT, aliases: [], patterns: [] },
  { id: 'topic', name: 'test', folder: null, aliases: [], patterns: [] },
  { id: 'coach', name: 'coach-app', folder: `${ROOT}/coach-app`, aliases: [], patterns: ['github.com/devuser/coach-app', 'localhost:3000'] },
  { id: 'explainer', name: 'repo-explainer', folder: `${ROOT}/repo-explainer`, aliases: [], patterns: ['github.com/devuser/repo-explainer'] },
];

/** Claude session titles, each tied to the folder the session works in (not the folder it started in). */
export const liveSessionTitles: readonly TitleEntry[] = [
  { title: 'Multi-project workspace workflow design', contextId: 'yard' },
  { title: 'Coach app', contextId: 'coach' },
  { title: 'Explainer repo', contextId: 'explainer' },
  { title: 'Pending changes push', contextId: 'lesson' },
];

const ghostty = (n: number, title: string, document: string | null, expected: string | null): FixtureWindow => ({
  key: `com.mitchellh.ghostty|w2589.${n}`, app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', pid: 2589, title, document, browser: null, expected,
});
const chrome = (n: number, title: string, expected: string | null): FixtureWindow => ({
  key: `com.google.Chrome|w20780.${n}`, app: 'Google Chrome', bundleId: 'com.google.Chrome', pid: 20780,
  title: `${title} - Google Chrome - Dev User`, document: null, browser: null, expected,
});
const arc = (n: number, title: string, expected: string | null): FixtureWindow => ({
  key: `company.thebrowser.Browser|w60262.${n}`, app: 'Arc', bundleId: 'company.thebrowser.Browser', pid: 60262, title, document: null, browser: null, expected,
});

export const liveWindows: readonly FixtureWindow[] = [
  // Terminals: every session was started in the parent folder, so `document` says "work".
  ghostty(18314, '◐ Multi-project workspace workflow design', ROOT, 'yard'),
  ghostty(18670, '✳ Coach app', ROOT, 'coach'),
  ghostty(18673, '✳ Explainer repo', ROOT, 'explainer'),
  ghostty(18700, '~', '/Users/dev', null),
  ghostty(18701, '✳ Claude Code', ROOT, 'root'),
  // Browsers, title only.
  chrome(18655, 'GitHub - devuser/mission-control: Real-time command center for coding agents. · GitHub', 'yard'),
  chrome(18656, 'GitHub - devuser/lesson · GitHub', 'lesson'),
  chrome(18662, 'Page not found · GitHub · GitHub', null),
  chrome(18665, 'Hacker News', null),
  chrome(18666, 'lesson-web – Deployments – Vercel', 'lesson'),
  chrome(18667, 'localhost:3000/dashboard', 'coach'),
  chrome(18668, 'Pull requests · devuser/lesson-extras · GitHub', null),
  chrome(18669, 'How to test a React app', null),
  arc(18829, 'Yardmaster', 'yard'),
  arc(18321, '(2) Facebook', null),
  // Editors and the rest.
  { key: 'com.microsoft.VSCode|w34584.18324', app: 'Code', bundleId: 'com.microsoft.VSCode', pid: 34584, title: 'Visual Studio Code', document: null, browser: null, expected: null },
  { key: 'com.microsoft.VSCode|w34584.18325', app: 'Code', bundleId: 'com.microsoft.VSCode', pid: 34584, title: 'lesson-plan.md — coach-app', document: `${ROOT}/lesson/lesson-plan.md`, browser: null, expected: 'coach' },
  { key: 'com.todesktop.230313mzl4w4u92|w400.1', app: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', pid: 400, title: 'matcher.ts — mission-control', document: null, browser: null, expected: 'yard' },
  { key: 'com.apple.finder|w642.18442', app: 'Finder', bundleId: 'com.apple.finder', pid: 642, title: 'Documents', document: null, browser: null, expected: null },
];
