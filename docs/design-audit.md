# Switchyard dashboard: design audit and reorganisation

Date: 2026-11-22. Scope: `src/dashboard/` (vanilla JS/CSS, no build step).
Owner's ask: "organize the UI/UX".

## Design read

A local, single-user ops console for one developer running many coding agents.
The job (see `docs/superpowers/specs/2026-11-22-contexts-design.md`): work on
many projects at once, and know instantly what each project is doing and what
needs you. So the product is organised by context (project), with the raw
agent/mission/usage/timeline panels as the supporting view.

Identity kept: dark only, JetBrains Mono, uppercase micro-labels, square
corners, hairline borders, the existing tokens in `styles.css`. Light mode
rendering dark is a deliberate single-theme choice; no light theme was added.

## Findings

Severity: blocker (hides or misleads), paper-cut (works but costs attention),
nitpick (polish). "Before" shots are in the session scratchpad `shots/`;
"after" shots are in `shots-after/` (same scratchpad).

| # | Severity | Finding | Evidence (before) | Status |
|---|---|---|---|---|
| 1 | blocker | Contexts, the point of the product, was the second tab and not the default | desk-dark-overview.png | Fixed: Contexts is default, first in the header switch and mobile tab bar, "Overview" renamed "Activity", last view remembered in `localStorage` (`switchyard_view`) |
| 2 | blocker | Stale data drowned live data: agents seen "5549h ago", durations like "5553:28:44", header "54 agents", subagents listed as siblings | desk-dark-overview.png | Fixed: filter defaults to ACTIVE (seen in last 24 h), older only under ALL; header and mobile counts use active agents; subagents collapsed under their parent (subagent-only groups get a toggle row); ages over a week show a date ("3 Apr"), over a day show "3d ago"; long durations show "3d 4h" |
| 3 | blocker | Mission list was a wall of struck-through items from months ago | desk-dark-overview.png | Fixed: open missions by default, completed behind "Show N completed"; header and badge count open missions |
| 4 | blocker | Context health bars all red at 100% (240K to 344K tokens): the percentage assumed a 200K window | desk-dark-overview.png | Fixed: percentage recomputed client side against the model's real window. 1,000,000 for ids containing `opus-5`, `sonnet-5` or `[1m]`; 200,000 for `opus/sonnet/haiku-3|4`; any other id shows the token count and "window size unknown" with no bar. Red only at 85% or more, amber from 60% |
| 5 | paper-cut | "SWITCHYARD - INTERNAL USE ONLY" banner and `{ }` around the logo, in an open-source tool | all desk shots | Fixed in `index.html`, `login.html`, `styles.css` (layout height calcs now use `--header-h`) |
| 6 | paper-cut | Contexts table: headers did not line up with cells (the actions column was `auto`, so it sized per row), long names wrapped mid-word | desk-dark-contexts.png | Fixed: one grid template (`--ctx-cols`) for header and rows with a fixed actions column; names truncate with ellipsis and a `title`; text columns left, cost column right with tabular numbers |
| 7 | paper-cut | Unsorted row: native selects unstyled, windows in one flat list, system windows mixed in | desk-dark-contexts.png | Fixed: selects use the input styles (square, mono, custom caret, dark `color-scheme`); windows grouped by app; windows with bundle ids starting `com.apple.systempreferences`, `com.apple.finder`, `ph.pastelero.switchyard` sit behind "Show N system windows" |
| 8 | blocker | Dim text near invisible (muted `#454549` on `#0a0a0c` is 2.07:1) | desk-dark-overview.png | Fixed in `:root`, see numbers below |
| 9 | nitpick | Empty context rows read "No agents" plus two dashes | desk-dark-contexts.png | Fixed: one line, "No agents running · no windows yet", actions stay right |
| 10 | blocker | Mobile bottom tabs cut off ("USAGE $695.21 ...") | phone-dark-contexts.png | Fixed: five equal tabs (icon over short label, 58px tall, each at least 44px wide and tall); the cost and event counts are dropped from the bar, counts are small badges |
| 11 | paper-cut | Two unrelated components shared the class `.ctx-row` (context health bars and the contexts table), so the later CSS rule bent the health rows into a grid | code | Fixed: health rows renamed `.health-row` |
| 12 | nitpick | Keyboard focus was only styled inside the Contexts view; no reduced-motion handling for the radar and transitions | code | Fixed: one global `:focus-visible` rule, one global `prefers-reduced-motion` rule |

Verification: real data on 1440x900 and 390x844, plus a mocked `/api/contexts`
payload (long name, waiting, parked, quiet, system windows) to exercise states
the live data did not have. The live Activity view had no parent agent rows, so
the nested subagent rows were checked only as groups.

## Contrast (WCAG, small text needs 4.5:1)

Tokens changed in `:root` only; nothing was fixed per element.

| Token | Before | After | On `--bg-base` #0a0a0c | On `--bg-panel` #161619 | On `--bg-hover` #222226 |
|---|---|---|---|---|---|
| `--text-muted` | #454549 | #8a8a92 | 2.07 to 5.78 | 1.89 to 5.27 | 1.66 to 4.63 |
| `--text-secondary` | #7a7a80 | #a2a2aa | 4.64 to 7.80 | 4.23 to 7.12 | 3.72 to 6.25 |

Hierarchy kept: bright `#ededf0`, primary `#c8c8cc`, secondary, muted. Muted on
`--bg-active` (#2a2a2e, selected rows) is 4.17:1, just under 4.5. Left alone;
see below.

## What changed, by file

- `index.html`: banner and braces removed, Contexts first, "Activity", filter order ACTIVE / IDLE / ALL, mobile tab bar rebuilt.
- `contexts.js`: view persistence, system-window toggle, app grouping, quiet-row, name titles.
- `app.js`: 24 h active filter and counts, collapsed subagents, open-missions filter, date/age formatting, context window sizing.
- `styles.css`: tokens, `--header-h` and `--tabs-h`, table grid, select style, mobile tabs, focus and reduced motion.
- `login.html`: braces and duplicate subtitle removed.

## Left for the owner to decide

1. (Done 2026-11-23, see the session below.) `app.js` is 2,100+ lines (already over the 800 limit before this work; this
   change added about 100). Splitting needs `src/server.ts` to serve a new file.
   Suggested: move the agents panel to `activity.js` and add the route
   `GET /activity.js` next to the existing `/contexts.js` route. Not done here
   because `server.ts` was off limits.
2. Order of contexts: still by desktop number, which is a stable mental map.
   Sorting "waiting on you" to the top is an option; the "Needs you" strip
   already covers it.
3. Muted text on the selected-row background is 4.17:1. Raising it further
   would collapse the muted/secondary difference.
4. The server's `contextWindowPercent` still assumes 200K. The dashboard now
   ignores it. The server should report the window size (`contextWindowSize`)
   so the client does not need to guess from the model id.
5. The access-code login allows 5 attempts per 15 minutes per IP and counts
   successful ones, so automated screenshot runs can lock themselves out.

## Session 2026-11-23: Contexts cards, assign picker, app.js split

Owner's screenshot of the Contexts view. Shots (1440x900 and 390x844, live
server, plus a mocked `/api/contexts` payload for agents, waiting, parked and
long titles) are in the parent session's scratchpad `ui-v3/`: `before-*`,
`after-*`, `after-*-mock*`.

| # | Severity | Finding | Status |
|---|---|---|---|
| 13 | blocker | Header clipped "CONNECTED" and "Sort open windows" at laptop width (`#header` is `overflow: hidden`, nothing gave way) | Fixed: header stats hidden in the Contexts view, hidden at 641-1100px, "? HELP" hidden below 1180px; Contexts panel header wraps; button now "Sort windows · N" |
| 14 | paper-cut | Table with a wide "Agents · last action" column reading "No agents running" on every row | Fixed: one card per context in desktop order (`byDesktop`), header row = dot, name, Park/Switch; second row = Desktop N · ⌥N · status; agents only when present; windows as app letter + short title |
| 15 | blocker | Browser titles carried " - Google Chrome - <profile name>" (owner's name) | Fixed: `shortTitle` in `contexts-logic.js` strips browser + profile suffix and leading dashes; the "why" line moved to the hover title |
| 16 | paper-cut | Header "37 agents" (seen in 24 h) vs summary "0 agents" (in contexts) | Fixed by dropping the duplicate: header stats belong to Activity and are hidden in Contexts |
| 17 | paper-cut | Native "Assign to…" selects, uppercase app section headers in Unsorted | Fixed: `picker.js` (combobox + listbox, suggested context first, "New context…", filter, ↑↓/Enter/Esc, outside click, flips up near the bottom); Unsorted is one list of app letter + title + picker, all pickers 200px (150px on phones) in one column |
| 18 | nitpick | Idle status pill on every card | Fixed: idle is plain text in the meta line; pills only for working, waiting, parked |

Also: `app.js` (2,228 lines) split into `core.js`, `activity.js`, `usage.js`,
`app.js` (all under 800), served by `src/server.ts` like `/contexts.js`.

Left: the pre-existing `e.target.closest is not a function` console error from
the tooltip's capture-phase `mouseenter` on `document` (target can be the
document). Harmless; not touched to keep the split behaviour-identical.
