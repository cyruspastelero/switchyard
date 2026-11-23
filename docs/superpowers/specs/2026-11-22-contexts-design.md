# Contexts: sort every window by project — design

Date: 2026-11-22 · Status: approved by owner (clickable preview: https://claude.ai/artifact/G59Zr392A1fWY8ade76c15)

## Why

The owner runs several projects at once. Each has a browser window (Chrome or Arc) and a few Ghostty terminals running Claude Code or Cursor CLI, plus editors. Getting back to a project means hunting through windows and tabs. Mission Control already tracks agents; it should also sort windows by project, give each project its own desktop, and switch to it in one keystroke.

The product is renamed **Switchyard** (the yard where trains are sorted onto tracks). It is no longer Claude-only, and "Mission Control" collides with the macOS feature of the same name, which is confusing for a tool that manages macOS desktops.

## Goals

1. **Contexts.** A context is a project folder (git root of an agent's cwd) or a named topic. Contexts appear automatically when an agent starts in a new folder.
2. **Sort.** Assign every open browser, terminal and editor window to a context and place it on that context's virtual desktop. Name Chrome windows after the context.
3. **Switch.** ⌥Space opens a search switcher; ⌥1–⌥9 jump straight to a context. Switching shows that context's windows and hides the others.
4. **Status.** Each context shows working / waiting on you / idle / parked, from its agents. One notification when an agent starts waiting.
5. **Park / restore.** Park closes a context's browser windows and saves their tabs and names; restore reopens them on that context's desktop.
6. **Dashboard.** A Contexts tab in the existing dashboard: rows per context, agents and last action, windows (with rename), cost today, Unsorted, tab-move suggestions.

## Non-goals

- No tiling. Windows keep the size and position the owner gave them.
- No separate browser profiles.
- No automatic tab moves. Moving tabs always waits for a click.
- No Windows/Linux window control. The server stays cross-platform; window control lives only in the macOS app.

## Anti-goals (failure even if it "works")

- Windows jumping around while the owner works. Sorting runs on request, plus once for a newly seen window; a window the owner assigned by hand is never re-sorted.
- Overwriting a window name the owner set.
- Losing tabs. Park saves before it closes anything.
- Windows stranded off-screen. Quitting the app, or "Show all windows", always brings every hidden window back.

## Constraint: fewer dependencies

Owner's rule: if we can do it ourselves, don't add a dependency. So **no AeroSpace** (tried, then removed on 2026-11-22) and no third-party Swift packages. The server has no runtime dependencies (since 2026-11-23: `node:sqlite`, a built-in WebSocket server, no QR code).

## Verified facts (spike, 2026-11-22)

- Chrome AppleScript `given name` on a window is read-write (`Google Chrome.app/Contents/Resources/scripting.sdef:36`). Setting and reading it back worked.
- Chrome AppleScript `move tab … to window …` **does not work**: the tab is dropped and a blank tab appears in the target. Moving a tab = open its URL as a new tab in the target window, then close the source tab. That loses in-page state, so it only happens on click.
- Arc answers AppleScript for tabs: `tell application "Arc" to get {name, URL} of tabs of window 1` works. Arc has no window naming.
- Ghostty 1.3.1 has no AppleScript dictionary. Its window title is Claude Code's topic (e.g. "◑ Multi-project workspace workflow design"), not the folder.
- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` exists in the Claude Code binary.
- Hooks and tool subprocesses have no controlling terminal (`/dev/tty`: "device not configured"), so a hook cannot set the terminal title.
- macOS has no public API to move windows between native Spaces. Virtual desktops are done the way AeroSpace does it: hidden windows are moved off-screen with the Accessibility API and moved back on switch.
- Accessibility permission is per binary. The app must be granted it once (System Settings › Privacy & Security › Accessibility).

## Approaches considered

1. **Switchyard server (brain) + Switchyard.app (macOS window agent) — picked.** The server already knows agents and folders; the app owns everything that needs macOS permissions.
2. AeroSpace for desktops. Works, but it is a whole tiling window manager to install and configure, and the owner wants fewer dependencies.
3. Web dashboard only. Another browser tab to manage browser tabs, and no hotkey.

## Architecture

```
Claude Code / Cursor hooks ─► Switchyard server (Node/TS, SQLite) ◄─► dashboard (localhost:4280, Contexts tab)
                                   ▲  contexts module (matching, state, API)
                                   │  HTTP + bearer token (loopback)
                              Switchyard.app (Swift, menu bar)
                               ├─ window layer (Accessibility): list, hide off-screen, restore, raise
                               ├─ browser layer (AppleScript): Chrome + Arc tabs, Chrome window names, open/close tabs
                               └─ ⌥Space switcher, ⌥1–9 hotkeys, notifications, badge
```

The server never calls macOS APIs. The app reports what is on screen and carries out what the server decides.

### Server: `src/contexts/`

- `matcher.ts` — pure functions. Given contexts with their signals and learned rules, return the context for a URL, then for a window:
  - Every match returns `{ contextId, reason, strong }`. A window walks a fixed ladder of signals; the first rung that names exactly one context wins, a rung naming two unrelated contexts leaves the window unsorted, and a context whose folder contains another candidate's folder steps aside (child beats parent). The reason is stored with the assignment and shown as `why` on each window ("assigned by you" for manual ones).
  - Browser window: majority of matched tabs; unmatched tabs (Gmail, search, YouTube) don't vote; a tie → unsorted. When no tab matches or the tabs cannot be read (no Automation grant, so `browser` is null and the browser is recognised by bundle id), the page title decides, with the " - Google Chrome - Profile" suffix removed: repo `owner/name`, Vercel project name on a Vercel page, or `localhost:port` first; then the context name, folder basename or an alias (package name, Vercel project, Supabase `project_id`) as a whole word of 4+ letters that is not an everyday word (test, work, docs…).
  - Terminal/editor window, in order: title equals the title of exactly one known Claude session → title contains a context folder path → a title part equals a project name ("file — folder", the editor's workspace) → `document` path (AXDocument; for Ghostty the shell's folder) inside a context folder → a project name as a word in the title (the only weak rung) → unsorted. The session comes first because sessions are usually started in the parent folder of all repos: a session belongs to the project root of its latest hook cwd, or to a project nested inside it when at least 5 and 60% of its last 300 tool calls (subagents included) touch that project (`workfolder.ts`). Contexts are created for that folder, not for the parent.
  - Re-sorting: owner assignments never move. On each snapshot an already auto-sorted window moves only on a strong signal for another context, and a browser window never does (its title follows the active tab). "Sort" re-matches every non-owner window.
  - Learned rules: host + first path segment on ordinary sites; on shared hosts as deep as it takes to name one project (`github.com/owner/repo`, `vercel.com/team/project`, `supabase.com/dashboard/project/ref`, `docs.google.com/document/d/id`); `localhost:port` for local servers. Stored rules broader than that are ignored.
- `signals.ts` — per context folder: `git remote get-url origin` (→ `github.com/owner/repo`), `.vercel/project.json` `projectName` (→ `vercel.com/*/projectName`), `supabase/.temp/project-ref` (→ `supabase.com/dashboard/project/<ref>`), listening ports whose process cwd is inside the folder (`lsof -iTCP -sTCP:LISTEN -nP`, then `lsof -a -p <pid> -d cwd`) (→ `localhost:<port>` / `127.0.0.1:<port>`). Use `execFile` with argument arrays, never a shell string. Cache for 60 s.
- `store.ts` — new tables in the existing DB: `contexts` (id, name, folder, key 1–9, color, parked, created_at, last_active_at), `context_rules` (pattern, context_id, source learned|manual), `window_assignments` (window key, context_id, source auto|owner), `window_names` (window key, name, set_by owner|switchyard), `parked_windows` (context_id, browser, name, urls JSON, saved_at).
- Window key: `bundleId|w<pid>.<window number>` (the window server's id, read through Accessibility). It stays the same while the window is open, across title changes and app restarts. Changed 2026-11-22: the first version used the title, and a terminal running an agent retitles itself every second, so assignments kept getting lost. Title + document is only the fallback when the window number is unavailable.
- `service.ts` — status roll-up from agents (waiting = the agent's latest event is a permission prompt or question: a Notification typed `permission_prompt`/`elicitation_dialog`, or by message, or untyped in the middle of a turn. The idle reminder (`idle_prompt`, "waiting for your input", or any untyped Notification straight after a Stop) counts as finished. The hook stores the notification's `message` and `notification_type` in `tool_input`; working = tool activity in the last 2 minutes; idle otherwise), sort, switch, park, restore, rename, assign (learns a rule, see matcher), accept suggestion.

### API (session cookie, or `Authorization: Bearer <hook-token>` from loopback only)

Read by dashboard and app:
- `GET /api/contexts` → `{ windowControl, activeContextId, contexts: Context[], unsorted: Window[], suggestions: Suggestion[], waitingCount }`
  - `Context { id, name, folder|null, key, color, status: "working"|"waiting"|"idle"|"parked", agents: [{ id, name, status, lastAction, costToday|null }], windows: Window[], parkedWindowCount, lastActiveAt }`
  - `Window { key, app, bundleId, title, name|null, tabCount|null }`
  - `Suggestion { id, url, title, fromWindowKey, toContextId }`
- `POST /api/contexts` `{ name }` → new topic context
- `PATCH /api/contexts/:id` `{ name?, color?, key? }`
- `POST /api/contexts/:id/switch | /park | /restore`
- `POST /api/contexts/sort`
- `POST /api/contexts/show-all` — bring every hidden window back and clear the active context
- `switch`, `park`, `restore`, `sort` and `accept` answer 409 while the app is not reporting windows (no snapshot in 15 s). The view also has `lastFailure: { action, error, at } | null`.
- `POST /api/contexts/assign` `{ windowKey, contextId }`
- `POST /api/contexts/windows/name` `{ windowKey, name }`
- `POST /api/contexts/suggestions/:id/accept`

App-only (bearer token):
- `GET /api/contexts/access-code` → `{ accessCode }` for the menu's "Copy dashboard access code" (the code changes on every server start).
- `PUT /api/contexts/snapshot` — the app's full view of the screen: `{ windows: [{ key, app, bundleId, pid, title, document|null, browser: { windowId, name|null, tabs: [{ id, url, title }] } | null }] }`. Sent on change and every 5 s.
- `GET /api/contexts/commands?since=<seq>` (long-poll up to 25 s) → ordered commands for the app: `show { contextId, windowKeys, hideKeys, focus }` (show `windowKeys`, hide `hideKeys` = the windows of other contexts, leave the rest alone; `focus: false` re-applies without raising anything), `nameWindow { windowKey, name }`, `openWindow { browser, name, urls, contextId }`, `closeWindow { windowKey }`, `openTab { windowKey, url }`, `closeTab { windowKey, tabId }`, `showAll`. The app posts `POST /api/contexts/commands/:seq/ack` `{ ok, error? }`.
- Live updates to the dashboard: a `contexts` message on the existing WebSocket.

All request bodies are validated into typed DTOs at the edge; reject unknown fields and oversized payloads (snapshot ≤ 1 MB).

### Dashboard

New "Contexts" tab in `src/dashboard/`, same vanilla JS and CSS conventions as the existing tabs. Layout follows the preview: summary line, "Needs you" strip, one row per context (name + desktop number, agents with status pill and last action, windows with Chrome names and Rename, cost today, Park/Restore + Switch), Unsorted row with Assign, suggestions ("2 tabs look like Tala · Move"). When `windowControl` is false, show a one-line note that the macOS app isn't connected.

### Switchyard.app: `macos/`

Swift Package (executable) + a script that wraps it into `Switchyard.app` (Info.plist with `LSUIElement`, `NSAppleEventsUsageDescription`), ad-hoc signed. macOS 14+. No third-party packages.
- Reads the server URL and `hook-token` from the data dir.
- Window layer (AX): enumerate windows of regular apps; report title, AXDocument, frame. Virtual desktops: on `show`, save each other managed window's frame, move it off-screen (bottom-right corner, 1 px visible, as AeroSpace does), restore and raise the shown windows, focus the first. Unmanaged/unsorted windows are left alone. On quit, SIGTERM, or "Show all windows", restore everything.
- Browser layer: `NSAppleScript`/`osascript` for Chrome (tabs, `given name`, make window/tab, close) and Arc (tabs, make tab, close). Values are passed as script arguments, never interpolated into script text.
- Menu bar: icon with `waitingCount` badge; menu lists contexts with status and key, then "Open dashboard", "Sort open windows", "Show all windows", "Quit".
- Hotkeys via Carbon `RegisterEventHotKey`: ⌥Space opens a floating search panel (type to filter, ↑↓, Enter); ⌥1–⌥9 switch to that context's key.
- `UNUserNotificationCenter`: one notification when a context enters waiting; clicking it switches there.
- First run: explain and request Accessibility; show a clear state in the menu until granted.

### Rename

Package and CLI `switchyard`, UI "Switchyard", data dir `~/.switchyard` (on first run, move `~/.claude-mission-control` there if the new dir doesn't exist). Env vars `SWITCHYARD_*`, with old `MC_*` still read. Hook script name updated and `install` rewrites old hook entries. GitHub repo rename is the owner's call (outward-facing).

## Left to the builder

Colors, polling intervals within the stated bounds, how cost-today is computed from existing token data, test fixtures.

## Real desktops (Spaces)

Added 2026-11-22 · Status: plan, not built · Probed on macOS 15.5 (24F74), SIP on, one built-in display, 6 desktops.

This section replaces "virtual desktops by off-screen hiding" as the default. Where it disagrees with the text above (the "no public API" line in Verified facts, the window layer bullet, "once for a newly seen window"), this section wins.

### Decision

1. **Move a window:** carry it. Synthetic mouse-down on its title bar, switch desktop with a synthetic Ctrl+N, mouse-up. This is the only way that works with SIP on and no extra software.
2. **Switch desktop:** post the system "Switch to Desktop N" shortcut (Ctrl+N). The shortcuts are off on this machine, so the app turns shortcut N on for the moment it posts, then puts it back.
3. **See other desktops:** `CGWindowListCopyWindowInfo(.optionAll)` for which windows exist, `CGSCopySpacesForWindows` for which desktop each is on, and Accessibility elements we already hold for titles. No Screen Recording.
4. **Mapping:** context key N goes to Desktop N. The last desktop is shared: unsorted windows and any context whose key has no desktop of its own. With 6 desktops that is keys 1 to 5 on Desktops 1 to 5, and keys 6 to 9 on Desktop 6.
5. **Off-screen hiding stays**, in two places only: between contexts that share the last desktop, and as the whole mode when real desktops can't be used.

The carry is not yet proven on this machine (the probe binary has no Accessibility grant). Step 1 of the plan is a go/no-go test in the signed app. Reports for macOS 15 are mixed, so do not build the rest before that test passes.

### Evidence

Probes: `/private/tmp/claude-501/-Users-cyruspastelero-side-project/2c580490-62ac-42d7-a86f-88bd06c16abe/scratchpad/spaces-probe/` (`read.swift`, `move.swift`, `hk.swift`). The move probe used its own throwaway window in a second process, never the owner's windows.

| Question | Result on 15.5 |
|---|---|
| Are Ctrl+1 to Ctrl+6 on? | No. Ids 118 to 123 are missing from `com.apple.symbolichotkeys`, and `CGSIsSymbolicHotKeyEnabled` says false for all six. Ctrl+Left/Right (79, 81) are on. |
| What keys are they? | `CGSGetSymbolicHotKeyValue(118…123)` returns key codes 18, 19, 20, 21, 23, 22 with modifier `0x40000` (Control), even while off. |
| Can we turn one on without System Settings? | Yes. `CGSSetSymbolicHotKeyEnabled(118, true)` returned 0 and the state read back true; setting it back worked. The plist did not change, so it lasts for the login session at most. |
| Private move calls on another process's window | All fail without an error. `SLSMoveWindowsToManagedSpace`, `SLSAddWindowsToSpaces` + `SLSRemoveWindowsFromSpaces`, `SLSSpaceAddWindowsAndRemoveFromSpaces`: window stayed on space 914. yabai's compat-id trick: `SLSSetWindowListWorkspace` returned 1006 (not implemented). |
| Same call on our own window | Works: `SLSMoveWindowsToManagedSpace` moved it from space 914 to 6. So the block is for other processes' windows only. |
| List desktops | `CGSCopyManagedDisplaySpaces` returned 6 type-0 spaces in Mission Control order (ids 1, 4, 3, 5, 6, 914). The `com.apple.spaces` plist was stale (5 spaces), so never read the plist. |
| Window to desktop | `CGSCopySpacesForWindows(conn, 7, [wid])` worked for every window with no permission. Junk windows return an empty list. |
| Titles from CGWindowList | 0 of 11 windows had `kCGWindowName`. It needs Screen Recording. |
| Linking | The `CGS*` names link with plain AppKit. No `-F PrivateFrameworks` flag, so `Package.swift` needs no unsafe flags. |
| Posting events from an untrusted binary | `CGPreflightPostEventAccess()` false. Same grant as Accessibility, so only the signed app can test the carry. |

From the web (not re-verified here):
- Hammerspoon #3636: `SLSMoveWindowsToManagedSpace` stopped working for other apps' windows in 14.5; on 15 "they nuked the implementation in the WindowServer" (yabai's author). It still works for an app's own windows. This matches the probe. A user confirmed "click the title bar, press Control-arrow, release" on 15.0.1. https://github.com/Hammerspoon/hammerspoon/issues/3636
- yabai needs SIP off to move windows between spaces on Sequoia. https://github.com/koekeishiya/yabai/wiki/Disabling-System-Integrity-Protection
- Amethyst called space throwing at risk on macOS 15, reworked its mouse drag in 0.23.0, and a user still reported it broken on 15.7.7. https://github.com/ianyh/Amethyst/discussions/1682

### Rejected options

| Option | Why not |
|---|---|
| Private CGS/SLS move calls | Fail for other apps' windows on 15.5 (probe above). |
| yabai scripting addition, or injecting into Dock | Needs SIP off. Owner won't. |
| AeroSpace / yabai / Amethyst / Hammerspoon | Dependencies. Owner's rule. |
| `CGSManagedDisplaySetCurrentSpace` to switch | Private, skips the Dock, known to leave the old desktop's windows drawn. Ctrl+N is the system's own path. |
| Ask the owner to tick six shortcuts in System Settings | Works, but it is setup we can do ourselves. If the owner has them on, we use them as they are. |
| Switch by activating a window on the target desktop | Fails for an empty desktop and depends on "switch to a Space with open windows". Used only as the last step (raise), not to navigate. |
| Dragging the window onto a desktop thumbnail in Mission Control | Opens Mission Control for every move: more flicker and more fragile than the carry. |
| Screen Recording for titles | A second scary permission for something Accessibility already gives us. |
| `_AXUIElementCreateWithRemoteToken` brute force to find windows on other desktops | Another private call, slow, misses windows of long-lived apps. Sort visits those desktops anyway. |
| Dock "Assign to Desktop" (`app-bindings`) | Per app, not per window. Two Chrome windows can't go to two desktops. |
| Creating more desktops for keys 6 to 9 | No API without SIP. The shared desktop covers it. |
| Dropping off-screen hiding | It is built and tested, and it is the only fallback if Apple breaks the carry. |

### Permissions

- **Accessibility**: already required. It also allows posting mouse and key events. Nothing new to grant.
- **No Screen Recording, no new Automation prompts, no Info.plist change.**
- Private calls used (all read-only except the last): `CGSMainConnectionID`, `CGSCopyManagedDisplaySpaces`, `CGSGetActiveSpace`, `CGSCopySpacesForWindows`, `CGSIsSymbolicHotKeyEnabled`, `CGSGetSymbolicHotKeyValue`, `CGSSetSymbolicHotKeyEnabled`. Plus `_AXUIElementGetWindow`, already in use.
- The app is ad-hoc signed, so a rebuild can drop the Accessibility grant. Re-grant before each live test.

### What the owner sees

- **Switch (⌥N, switcher, dashboard):** the normal macOS desktop slide to Desktop N (a cross-fade with Reduce Motion), then that context's windows are raised. About 0.5 s. No windows move.
- **Swiping desktops by hand:** the active context follows the desktop you land on.
- **Sort:** only on request. For each window on the wrong desktop: the screen slides to that window's desktop if needed, the pointer jumps to the title bar, the screen slides to the target with the window attached, the pointer goes back. Up to two slides and about 1 s per window, then one slide back to where you started. Ten misplaced windows is roughly 10 s of sliding. Keep hands off the mouse while it runs. The menu shows "Sorting 3 of 10".
- **New window on the wrong desktop:** it is assigned to its context but **not** moved. The menu and dashboard show "3 windows to sort". This drops "sort once for a newly seen window": a carry takes the screen away, which is the "windows jumping around" anti-goal.
- **Restore a parked context:** the app goes to the context's desktop first, then opens the windows there. No carry.
- **Unsorted windows:** never moved. The last desktop is where they belong, but the owner puts them there.
- **Contexts on the shared desktop (keys 6 to 9 today):** same as now. Switching between them hides the others off-screen on that desktop.
- **Quit / Show all windows:** off-screen windows come back. Windows stay on their desktops; nothing can be stranded on a real desktop.
- **Not touched:** fullscreen windows, minimized windows, windows set to "All Desktops", windows on a second display.

### Mapping rules

- Desktops are the type-0 entries of `CGSCopyManagedDisplaySpaces`, numbered 1…n in order across displays (the same numbers Mission Control and Ctrl+N use). Fullscreen and tiled spaces are skipped. Only the main display's desktops are managed in v1.
- `desktopFor(key, count)`: `count < 2` → none (off-screen mode). `key ≤ count − 1` → `key`. Otherwise → `count` (shared).
- The mapping is fixed by key, not packed. Parking a context leaves its desktop empty; windows never reshuffle because another context went away. The owner changes a key with the existing `PATCH /api/contexts/:id`.
- The count is read live for every command. If the owner adds or removes a desktop, the next Sort puts things right.
- `show` hides only windows of **other contexts mapped to the same desktop**. For keys with their own desktop that list is empty.

### Failure modes

| Failure | Handling |
|---|---|
| Carry does nothing (window still on the old desktop after mouse-up) | Verify with `CGSCopySpacesForWindows`. Retry once with doubled delays. Then mark the window failed, keep going, and report "moved 7, could not move 2: …" in the ack and `lastFailure`. |
| Carry fails for every window in a Sort | The app reports `canCarry: false`; the server falls back to off-screen mode and says so in the dashboard. |
| Desktop switch does not happen within 1.5 s | Post mouse-up, restore the pointer, fail that command. Never retry a switch blindly. |
| Mouse button left "down" after an error or cancel | Mouse-up and pointer restore sit in a `defer`. Also posted on quit and SIGTERM. |
| Owner is holding a mouse button or moves during a carry | Check the real button state before each carry; wait up to 2 s, then skip that window. Sort is capped at 30 carries or 45 s; the rest is reported as left to sort. |
| App crashes while a shortcut is turned on | Ctrl+N stays on until logout. Harmless; the next launch restores the saved state from a small file. |
| No title bar to grab (Ghostty with hidden title bar, odd windows) | No zoom button found → skip with a clear error. Never click blind. |
| Chrome tab strip tears a tab off | Grab point is 5 px below the top edge, just right of the zoom button (Amethyst's point). Covered by live test 1; if it tears, Chrome gets its own offset. |
| Sequoia edge tiling triggers | The drag moves 2 px and never nears an edge. Live test 6. |
| Window on another desktop never seen by Accessibility | It has no title yet, so it is not in the snapshot. Sort visits every desktop that has unknown windows before planning. |
| Cached Accessibility element goes stale | Drop any element whose window id is gone from the CG list. |
| Displays share one Space set, or only one desktop | `desktops: null` in the snapshot → off-screen mode. |
| Second display | Its windows report `desktop: null` and are left alone. |
| Owner already uses Ctrl+N shortcuts | We post the key the system reports and change nothing. |
| A context window is fullscreen | Left on its fullscreen space; switching just activates it. |

### Implementation plan

Order matters. Stop after step 1 if it fails. Build and test one heavy job at a time: `bash ~/side-project/.heavy-lock.sh swift test --package-path macos`.

**Step 1: go/no-go spike (throwaway, in the signed app).** Add a hidden launch argument `--carry-spike <desktop>` that opens a small window owned by a helper process (copy `move.swift helper`), carries it to that desktop, prints the before/after space ids, and comes back. Then run it by hand against one real window each of Chrome, Arc, Ghostty, VS Code and Finder, restoring each afterwards.
- Pass: 5 of 5 land on the target desktop, three runs in a row, no torn tab, pointer restored.
- Fail: stop. Keep off-screen mode as the default and tell the owner; the only remaining options need SIP off.
- Record the working delays in `personal_docs/gotchas.md`. Remove the spike argument before the feature ships.

**Step 2: `Spaces.swift` (read-only).** `enum Spaces` with `desktops() -> [Desktop]` (`id`, `number`, `displayId`, `isMain`), `activeDesktopNumber()`, `desktopNumber(ofWindow:)` (nil for none, several, or a non-desktop space). Keep parsing pure: `DesktopList.parse(_ managedDisplaySpaces: [[String: Any]])`.
- Tests: six type-0 spaces → numbers 1…6 in order; a type-4 space in the middle is skipped and numbering continues; two displays number across both; empty input → empty; window on two spaces → nil.

**Step 3: `DesktopKeys.swift`.** `shortcut(for number:) -> (keyCode, flags)?` from `CGSGetSymbolicHotKeyValue(117 + number)`; `press(number)` enables the shortcut if off, posts key down and up with exactly those flags, and restores the old state after the switch. Persist "we turned these on" to Application Support so a crash is undone at next launch.
- Tests (pure parts): modifier mask `0x40000` → `.maskControl`; `0x840000` → control + fn + numeric pad; number 0 or > 16 → nil; restore list round-trips through the file.

**Step 4: all-desktop window list.** In `WindowLayer`, keep `elements: [CGWindowID: AXUIElement]` filled by `enumerate`. `refresh()` returns current-desktop windows from Accessibility as today, plus cached windows whose id is still in the CG list and on another desktop (title and frame read from the cached element). Add `desktop: Int?` to `ManagedWindow` and `WindowSnapshot`, and `desktops: { count, active } | null` plus `canCarry` to `SnapshotBody`. Observe `NSWorkspace.activeSpaceDidChangeNotification` and nudge the snapshot loop.
- Tests (pure merge function): a cached window missing from the CG list is dropped; a cached window on Desktop 3 is kept with `desktop: 3`; a window in both lists appears once; keys stay the same when a window changes desktop.

**Step 5: `WindowCarrier.swift`.** `carry(window, to number) async throws`: check post-event access, real button up, window on the active desktop, not fullscreen or minimized → raise → grab point from the zoom button frame → save pointer → mouse-down → two 1 px drags → `DesktopKeys.press` → poll `activeDesktopNumber()` until it matches (20 ms steps, 1.5 s limit) → settle → mouse-up and pointer restore in `defer` → verify the window's desktop. One retry with doubled delays. All delays are named constants from step 1.
- Tests (pure parts): grab point for a given zoom-button frame and window frame; no zoom button → `noTitleBar`; verification result maps to moved / notMoved; the retry runs at most once.

**Step 6: `CarryPlan.swift` (pure).** Input: moves `[(key, from, to)]` and the starting desktop. Output: ordered steps `goTo(n)` / `carry(key, to)` / `goTo(start)`. Greedy: after a drop on desktop T, take a pending window that is on T first.
- Tests: nothing to move → no steps; one window on the current desktop → carry, then return; a swap between desktops 2 and 3 costs 2 carries and 1 return, with no wasted `goTo`; windows already in place are left out; more than 30 moves → the first 30 and a count of the rest; the plan always ends on the starting desktop.

**Step 7: server mapping.** New pure module `src/contexts/desktops.ts`: `desktopFor(key, count)` and `misplaced(windows, contexts, count)`. `service.ts`: `show` adds `desktop` and limits `hideKeys` to contexts on the same desktop; `sort` assigns as today, then enqueues `moveWindows { moves: [{ windowKey, desktop }] }`; `restore` enqueues a `show` with `focus: false` before `openWindow`; when the snapshot's active desktop changes and one context owns that desktop, it becomes `activeContextId`. Validate the new snapshot fields in `dto.ts` (integers 1…16, reject unknown fields). `desktops: null` or `canCarry: false` → today's behaviour, unchanged.
- Tests: `desktopFor(1,6)=1`, `(5,6)=5`, `(6,6)=6`, `(9,6)=6`, `(1,1)=null`, `(3,2)=2`; hide list is empty for a context alone on its desktop; two contexts with keys 6 and 7 hide each other; unsorted windows never appear in `moves` or `hideKeys`; a window already on its desktop is not in `moves`; an owner-assigned window is moved to its owner's desktop, never re-matched; snapshot with `desktop: 0` or `"2"` is rejected; null `desktops` produces the same commands as before this change.

**Step 8: app commands.** `CommandRunner`: `show` → if `desktop` is set and not active, `DesktopKeys.press` and wait, then the existing `WindowLayer.show`. New `moveWindows` → `CarryPlan` → `WindowCarrier`, with progress to the menu, ack `{ ok, error }` naming failed keys. `openWindow` needs no change. First `show` in desktop mode un-hides everything that is not in the new, smaller hide list (the current `show` already does this).
- Tests: `AppCommand` decodes `desktop` and `moves`; missing `desktop` decodes to nil and takes the old path; `moveWindows` with an unknown key acks an error and still moves the others.

**Step 9: dashboard and menu.** Row label "Desktop N" from the mapping ("Desktop 6 · shared" for overflow); "N windows to sort" beside the Sort button and in the menu; a one-line note when the app is in off-screen mode and why.
- Tests: `contexts-logic.js` label for keys 1, 5, 6 and 9 with 6 desktops; the count hides at zero.

**Step 10: live test in the signed app, then update `personal_docs/`.** Run the list below, fix delays, write the results into `gotchas.md` and `decisions.md`.

### Needs a live test in the signed app

1. The carry itself on 15.5, per app: Chrome, Arc, Ghostty, VS Code, Finder (step 1 gate).
2. Synthetic Ctrl+N switches desktops when the shortcut was off a moment before, and while ⌥ is physically held (the ⌥N hotkey path).
3. `kAXWindows` leaves out windows on other desktops, and a cached element still answers title, frame and raise from there.
4. The delays, with Reduce Motion off and on.
5. Chrome's grab point does not tear a tab; Arc has a usable grab point; Ghostty with a hidden title bar fails cleanly.
6. Sequoia edge tiling stays quiet during a carry.
7. `CGPreflightPostEventAccess()` is true once Accessibility is granted.
8. With an external display: desktop numbering and that second-display windows are left alone.
9. Turning a shortcut on and off does not change what System Settings shows.

## Arranging (layout) — v2

Added 2026-11-23 · Status: plan, not built · Audited live on macOS 15.5, one display 1470 × 956 (usable 1470 × 919: 37 px menu bar, Dock auto-hides), 6 desktops, app pid 75688.

This section replaces the non-goal "No tiling. Windows keep the size and position the owner gave them", the line "Unsorted windows: never moved", and the rule that `assign` only changes data. Where it disagrees with the text above, this section wins. Nothing here adds a dependency.

Owner's verdict after the carry shipped: "it didn't arrange it properly", "it's just messy desktop still", "when I switch a chrome or file etc to another context, it stays on the same desktop of the old and was not moved", "when I go to the moved context, it switches there and goes back to the other context again".

### Audit: what makes it feel messy or untrustworthy

Ranked. Evidence is from the code on `feat/contexts`, `GET /api/contexts` at 01:52, window frames read with `CGWindowListCopyWindowInfo` (read-only), and 1,206 log lines from 20:17 to 01:51. No window was moved for this audit, so findings 1 and 2 are proven in code and supported by logs, not reproduced on screen.

| # | Finding | Evidence |
|---|---|---|
| 1 | **Move does not move.** Moving a window to another context (or to Unsorted) only rewrites the assignment. The window stays on the old desktop until the owner presses Sort. | `service.ts` `assign()` and `unassign()` call `setAssignment`/`unsortWindow`, `refresh()` and `reshowActive()`. Neither enqueues `moveWindows`; only `sort()` does. The API reports `toSort: 1` right now: one window is sitting on the wrong desktop after a Move. |
| 2 | **Switching to a context with a misplaced window bounces back.** `show` goes to the target desktop, then raises and activates every window of the context, including one that still sits on another desktop. macOS follows the activated window to its Space, so the screen returns to the old desktop. The server then sees the active desktop change and sets `activeContextId` to the old context too. | `LocalSwitch.plan` uses `context.windows.map(\.key)` for the raise order, with no desktop check. `enqueueShow` puts every assigned window in `windowKeys`, whatever its desktop. `WindowLayer.raise` runs `kAXRaiseAction` + `NSRunningApplication.activate()` for each; windows on other desktops are in `latest` through the `seen` cache, so the raise reaches them. `AppleSpacesSwitchOnActivate` is unset (default: on). `followDesktop()` then flips the active context. Log: 6 of 46 raising shows took 100 ms or more in the raise phase (mean 46 ms), e.g. `01:51:15 raise=226 raised=4`, right after a Move. Neither `WindowView` nor `WindowDTO` carries the window's desktop, so the app cannot filter today. Findings 1 and 2 are one bug seen twice: fix 1 and most of 2 goes away; fix 2 anyway. |
| 3 | **Nothing arranges windows.** The carry drops a window where it was. Windows overlap and one hangs off the screen. | Desktop 1 frames: Ghostty `0,38 1115×918`, Arc `302,37 1145×879`, Chrome `74,513 1470×919`. Ghostty and Arc overlap by 813 px of width. Chrome is 74 px past the right edge and 476 px below the bottom of a 956 px screen. There is no layout code: `WindowLayer` only sets a position to hide and restore. `currentScreenFrames()` uses `NSScreen.frame`, not `visibleFrame`, so nothing knows about the menu bar or Dock. |
| 4 | **Strangers stay on project desktops.** Unsorted windows are never moved, so a Finder window stays on aral's desktop. Hand-assigned odd windows stick forever. | Spec line "Unsorted windows: never moved"; `misplaced()` skips windows with no target. Discord is `assigned by you` to aral. Finder "Documents" and VS Code are `assigned by you` to `side-project`. |
| 5 | **Desktops are spent on contexts that are not projects.** | `test` (no folder, 0 windows) holds Desktop 4. `side-project` (the parent folder of every repo) holds Desktop 3. `repo-explainer` has a real session and is pushed to the shared Desktop 6. |
| 6 | **The stated reason for a window is stale or wrong.** | Chrome window titled "Meta Business Suite - Part of group Akawntant social media manager", named "test", sits in `claude-mission-control` with `why: title mentions "switchyard"`. A browser window is never re-matched on a snapshot, so the reason outlives the tab that earned it. |
| 7 | **Tab reading has been dead for hours, so browser sorting runs on window titles only.** | 877 of 1,206 log lines are `list windows failed`: Chrome `osascript timed out`, Arc `Can't get every window. (-1728)`, backed off to one try per 300 s. Arc's `tabCount` is null. |
| 8 | **Sort takes the screen for a long time and tells the owner little.** | `sort carried=7 … total=17266ms perWindow=2466ms`; `carried=2 … 6665ms`; `carried=4 … 11100ms`. 1.5 to 3.3 s per window. The dashboard shows a count ("to sort: 1") but not which window or where it is. |
| 9 | **Failures surface as noise, or not at all.** | `Switch failed: the switch to Desktop 1 did not happen within 1.5 s` (00:37:40). `nameWindow` failed twice with "window is not a Chrome or Arc window" (01:36, 01:37) and became `lastFailure`. `notification authorization failed: Notifications are not allowed` on all 14 launches, so "waiting on you" notifications never arrive. |
| 10 | **Nothing says where you are.** Desktops have no names and a swipe gives no feedback. macOS may also reorder desktops by recent use. | No HUD or label code. `com.apple.dock mru-spaces` is unset (default: on). The Spaces probe above already saw ids out of creation order (1, 4, 3, 5, 6, 914). Desktop numbers are read live, so a reorder silently moves a project to another number. |

Out of scope for this plan, listed so they are not lost: 6 and 7 (matching), the notification grant in 9.

### Decisions

1. **Move carries, at once.** `assign` and `unassign` enqueue a one-window `moveWindows` when the window is on the wrong desktop: to the new context's desktop, or to the shared (last) desktop for Unsorted. A Move is the owner's explicit act, so it is not a surprise move. It costs one carry (1.5 to 3.3 s of sliding).
2. **The owner stays where they are.** After a Move the screen returns to the desktop it started on (the carry already ends with `goTo(start)`). Why: Move is triage, done from the dashboard, usually several in a row; following each window would pull the owner away from the list they are working through, and the window that holds the dashboard would take them somewhere they did not ask to go. The dashboard row and the menu show "Moved to aral · Desktop 2" with a **Go** button for the one case where they want to follow. Focus on the current desktop falls to the next window, as macOS does when a window leaves.
3. **`show` never touches a window on another desktop.** Raise and activate only windows whose desktop equals the target. Misplaced windows are skipped and named in a hint: "1 window still on Desktop 1 · Sort". `show` does not carry: a switch must stay a 0.3 s action.
4. **Layout exists, and is automatic only where the owner just asked for a rearrangement.** Tidy runs (a) on Sort and on Move, for each desktop whose set of windows changed, and (b) on an explicit Tidy (⌥T, menu panel button, dashboard button) for the current desktop. It never runs on a switch, a snapshot, a new window or a timer. Why automatic on Sort: Sort is the request "arrange my windows", and the owner's complaint is that Sort left a mess; an extra opt-in click would repeat that disappointment. Why not everywhere: a desktop Sort did not change keeps the frames the owner gave it, which is the old anti-goal "windows jumping around while the owner works", still in force. One setting, `autoTidy` (default on), turns (a) off for an owner who wants only the explicit Tidy.
5. **Manual tweaks last until the next Tidy of that desktop.** Because nothing lays out on its own, a resize after Tidy simply stays. No frame memory is needed for this. The app keeps one thing per desktop: the frames from before the last Tidy, for **Undo tidy**.
6. **Sort sweeps unsorted windows off project desktops.** On Sort (never on a snapshot), an unsorted window that sits on a desktop owned by a context is carried to the shared desktop. Why: the owner's own example is the Finder window left on aral's desktop; and a project desktop that holds only project windows is what lets Tidy use the whole screen without laying out strangers or leaving them on top. Windows on the shared desktop are left where they are. A window the owner wants everywhere uses the Dock's own "Assign To: All Desktops"; those report no desktop and are never touched. The Sort button says what it will do before the click: "Sort · 2 to move · 1 unsorted to Desktop 6".
7. **One layout, by window count. No modes to pick.** See below.

### Layout

Pure function: `Layout.frames(count:area:gap:) -> [Rect]`, slot 0 is the main window. `area` is the screen's `visibleFrame` in Accessibility coordinates, so the menu bar and the Dock (any edge, hidden or not) are already excluded. `gap` is 8 px, outside and between.

| Windows | Result |
|---|---|
| 1 | Fills the area. |
| 2 | Main left 60%, the other right 40%, full height. |
| 3 | Main left 60%; two stacked right, equal heights. |
| 4 | Main left 60%; three stacked right, equal heights. |
| 5 or more | Main left 60%; the rest form a deck in the right column: same width, each 30 px lower than the one before so every title bar shows, the bottom edge fixed. Order is kept, so the same window is always on top. |

- **Main window:** the context's browser window (Chrome or Arc). Several browsers, or none: the front-most by window-server order. **Right column order:** front to back, ties by window number. Same input gives the same output.
- **Which windows:** windows of the context(s) that own the desktop, that are really on that desktop, not minimized, not fullscreen, not hidden off-screen. On the shared desktop only the active context's shown windows are laid out; hidden ones keep their saved frames. Unsorted windows are not laid out (after decision 6 they are on the shared desktop anyway).
- **Screens:** each window is laid out on the screen that holds its centre, using that screen's `visibleFrame`. v1 manages the main display's desktops only, so windows on a second display are not touched, as in "Real desktops".
- **Apps that refuse a size:** set size, then position, then size again; read the frame back. A window that stays larger than its slot (Discord's minimum width, Ghostty's cell grid) keeps its own size with its origin on the slot. A window that cannot be resized at all gets position only. Logged, never retried.
- **Never while the owner is moving something:** Tidy starts only from the triggers in decision 4. Before applying, check the real mouse-button state; if a button is down, wait up to 2 s, then skip and say "Tidy skipped: mouse button held". Tidy never runs during a carry session.
- **Other desktops:** Tidy sets frames through the cached Accessibility elements without going there. If the frames do not read back (live test 2), the desktop is marked pending and tidied once, on the owner's next arrival, before the raise.
- **Undo:** "Undo tidy" in the menu panel puts back the frames saved before the last Tidy of the current desktop. One level, cleared by the next Tidy.

### What the owner sees

- **Move (dashboard):** the row says "Moving…"; the screen slides to the target and back (about 2 s); the row says "Moved to aral · Desktop 2 · Go". Both desktops are tidied if `autoTidy` is on. Carry refused (fullscreen, minimized, no title bar): the assignment stands and the row says "Still on Desktop 1 · Sort".
- **Switch:** slide to the desktop, raise only what is there. If something is elsewhere: HUD and menu line "1 window still on Desktop 1 · Sort". No bounce.
- **Sort:** carries as today, plus unsorted windows off project desktops, then tidies each desktop it changed. Progress: "Sorting 3 of 10 · Esc stops", then "Tidying".
- **⌥T / "Tidy this desktop":** the current desktop snaps into the layout in one step. "Undo tidy" appears in the panel.
- **Landing on a desktop** (hotkey, switcher, swipe): a small HUD for 0.9 s: "aral · Desktop 2", with the hint line when it applies.

### Small additions (keep it lean)

1. **Arrival HUD.** Non-activating borderless `NSPanel`, centred near the top, ignores the mouse, `.canJoinAllSpaces`, fades after 0.9 s (no fade with Reduce Motion). Fired by `activeSpaceDidChangeNotification`, so swipes get it too. Text: context name · Desktop N; the shared desktop says "Shared · Desktop 6". This stands in for naming desktops, which macOS has no API for.
2. **Menu bar title** shows the current context's name beside the icon (`MenuLabel` already exists).
3. **Stray hint, not a prompt.** One line in the HUD, the menu panel and the dashboard row: "1 window still on Desktop 1 · Sort" or "2 windows here are unsorted · Sort moves them to Desktop 6". No dialog.
4. **Window desktop in the dashboard.** Each window row shows "on Desktop 1" in the muted style when it is not on its context's desktop, so "to sort: 1" names the window.
5. **Desktop reorder note.** When `mru-spaces` is on, one line in the dashboard footer: "macOS may reorder desktops by recent use. Turn off 'Automatically rearrange Spaces' in System Settings › Desktop & Dock." The app reads the setting; it does not change it.

Not doing: named layouts, per-app rules, saved layouts per context, auto-tidy on new windows, drag-to-snap zones, more than one Undo level.

### API and command changes

- `Window` gains `desktop: number | null` (server `WindowView`, app `WindowDTO`). Null: off-screen mode, minimized, fullscreen, all desktops, second display.
- `Context` gains `strays: number` (its windows whose `desktop` is known and differs from the context's).
- View gains `unsortedToMove: number` and `autoTidy: boolean`.
- `POST /api/contexts/assign` and `/unassign` answer `{ moving: boolean, desktop: number | null }`.
- `POST /api/contexts/tidy` `{ contextId? }` → tidy that context's desktop, or the active desktop. 409 without the app, like Sort.
- `PATCH /api/contexts/settings` `{ autoTidy }`.
- `show` command: `windowKeys` holds only windows on the target desktop (all of them in off-screen mode); new `strayKeys` lists the skipped ones (for the hint only; the app never raises, hides or moves them).
- `moveWindows` command: optional `tidy: number[]`, the desktops to tidy after the carries.
- New command `tidy { desktops: [{ desktop, windowKeys }], force }`, in the `windows` lane. `force: false` (from Sort/Move) skips a desktop whose window set equals the set of its last Tidy; `force: true` is the explicit Tidy.
- All new fields are validated in `dto.ts` (integers 1…16, unknown fields rejected), as today.

#### Contract (server ⇄ app, fixed 2026-11-23)

Where this differs from the list above, this wins. The server builds every window list; the app only filters (on that desktop, not minimized, not hidden) and orders (`Layout.pickMain`).

- `Window.desktop: number | null` and `Context.strays: number` as above. `strays` counts only in desktop mode; off-screen mode is always 0.
- `show`: in desktop mode (`desktop` set) the server always sends `strayKeys: string[]` (may be empty). `windowKeys` = the context's windows whose `desktop` equals the target. A window of the context with `desktop: null` or another desktop is in `strayKeys`, never in `windowKeys` or `hideKeys`. Off-screen mode: no `strayKeys` field, `windowKeys` as before. The app never raises, hides or moves a stray.
- `moveWindows { moves }`: unchanged. The server does **not** send `moveWindows.tidy`; the app may decode it leniently and ignore it. Instead, when a Sort or Move changes desktops and `autoTidy` is on, the server enqueues a separate `tidy` command (`force: false`) after the `moveWindows` (a `show` with `focus: false` may sit between them). Both are in the `windows` lane, so the tidy runs after the carries.
- `tidy { desktops: [{ desktop: 1…16, windowKeys: string[] }], force: boolean }`, lane `windows`. `windowKeys` are the windows the server expects on that desktop once the carries are done: windows of the unparked contexts mapped to it, not hidden by the last `show`, unsorted windows never. Desktops with no windows are left out; a `tidy` with an empty `desktops` is never sent. The app drops keys that are not on that desktop when it runs. Ack `{ ok, error? }`.
- `undoTidy { desktop: 1…16 }`, lane `windows`: puts back the frames saved before the last Tidy of that desktop. Nothing saved → ack ok, no-op.
- `POST /api/contexts/tidy` body `{}` | `{ contextId }` | `{ desktop }` (not both). No field → the active desktop. Answers `{ ok, desktop, windows }` (`windows` = keys sent; 0 → nothing enqueued). 409 without the app, 409 in off-screen mode, 404 unknown context. Always `force: true`.
- `POST /api/contexts/tidy/undo` body `{}` | `{ desktop }` → `undoTidy`. Answers `{ ok, desktop }`. 409 as above.
- `POST /api/contexts/assign` and `/unassign` answer `{ ok, moving, desktop }`. `desktop` is the target desktop (the context's, or the last desktop for Unsorted), null in off-screen mode. `moving` is true only when a `moveWindows` was enqueued (the window's `desktop` is known and differs). No `show` with `focus: true`, no change to `activeContextId`.
- Sort: `moves` lists project moves first, then unsorted sweeps (unsorted windows on a desktop some unparked context maps to, other than the last, go to the last desktop). The 30-carry cap is the app's, unchanged.
- View: `unsortedToMove: number`, `autoTidy: boolean`. `PATCH /api/contexts/settings { autoTidy: boolean }` → `{ ok, autoTidy }`. Stored in `context_settings`, default true.

### Failure modes

| Failure | Handling |
|---|---|
| A window changes desktop between the snapshot and the raise | `WindowLayer.raise` re-reads each window's desktop (`Spaces.desktopNumber(ofWindow:)`) just before raising and drops any that is not on the active desktop. |
| The screen still leaves the target after a `show` | 300 ms after the raise, compare the active desktop with the target. If different: log `show bounced target=N landed=M keys=…`, go back once with `goTo` and no raise. Never twice. |
| Move's carry fails | Assignment stands, `carryFailed` as today, row says "Still on Desktop N · Sort". `show` skips it (decision 3) instead of hiding it. |
| Owner presses ⌥N during a Move's carry | Already refused while `sortProgress` is set ("Press Esc to stop it first"). Unchanged. |
| Several Moves clicked quickly | Each is its own `moveWindows`; the `windows` lane runs them one after another. Each returns to the desktop the owner was on when it began. |
| Tidy on a desktop with one context window and it is the dashboard's own browser window | Laid out like any other. No special case. |
| A window refuses the size or position | Keep what it accepted, log `tidy refused key=… wanted=… got=…`, carry on. |
| Screen changes (display plugged in) after Tidy | Nothing re-lays out. The next Tidy uses the new `visibleFrame`. Undo frames pass through `FrameMath.restorableFrame`. |
| Sort would sweep more than 30 windows | The existing cap applies to project moves first, then unsorted sweeps; the rest is reported as left to sort. |
| ⌥T is already taken, or the owner types † | Registration failure is logged and the menu panel button still works. The key is a constant in one place. |

### Implementation plan

Another agent is editing `src/dashboard/` and the focus code in `CommandRunner.swift` / `WindowLayer.swift`. Start steps 3, 6 and 9 only after that work is merged, and rebase first. Steps 1, 2, 4 and 5 touch other files and can start now. Failing test first for every step. One heavy job at a time (`bash ~/side-project/.heavy-lock.sh …`); Swift tests run through the scratchpad shim (see `personal_docs/README.md`), server tests with `npm test`.

**Step 1: window desktop in the view (server + DTO).** `view.ts`: `toWindowView` copies `desktop` from the snapshot window; `Context.strays`; `unsortedToMove`. `DTOs.swift`: `WindowDTO.desktop: Int?`, decoded leniently (missing → nil).
- Tests (`test/contexts/service-desktops.test.ts`, `DTOTests.swift`): a window on Desktop 1 assigned to a key-2 context has `desktop: 1` and its context has `strays: 1`; off-screen mode gives `desktop: null`, `strays: 0`; a view JSON without `desktop` decodes to nil.

**Step 2: `show` targets only windows on the target desktop (bug 2, server and pure Swift).** `service.ts` `enqueueShow`: with a desktop, a window of the context goes to `windowKeys` only when `w.desktop === desktop`, otherwise to `strayKeys`; `desktop === null` keeps today's behaviour. `SwitchLogic.swift`: `LocalSwitch.plan` filters `order` and `shown` the same way and returns `strays`. New pure `RaiseFilter.onDesktop(_ targets: [(key, desktop: Int?)], active: Int?) -> [String]`.
- Tests: context on Desktop 2 with windows on 2, 2 and 1 → `windowKeys` has two, `strayKeys` has one; the stray is in neither `hideKeys` nor `windowKeys`; a window with `desktop: null` in desktop mode is a stray; off-screen mode (`desktop` null on the context) raises all three, as before; `LocalSwitch.plan` for the same case gives `order.count == 2`, `strays == ["k3"]`; `RaiseFilter` with `active: nil` returns everything; `RaisePlan.steps` over the filtered list never contains `.activate` for a pid whose only windows were filtered out (two Chrome pids, one with only a stray).

**Step 3: guard in the window layer (bug 2, app).** `WindowLayer.raise`: re-read each target's desktop and pass through `RaiseFilter` before any Accessibility call. `CommandRunner.show` and `AppModel.switchTo`: after the show, the bounce check from the failure table (`ShowBounce.decide(target:landed:alreadyCorrected:) -> .ok | .goBack | .giveUp`, pure). Log line `show bounced …`.
- Tests: `ShowBounce.decide(2, 2, false) == .ok`; `(2, 1, false) == .goBack`; `(2, 1, true) == .giveUp`; `landed: nil` (fullscreen space) → `.ok`.

**Step 4: Move carries (bug 1, server).** `service.ts`: after `setAssignment` in `assign` and `unsortWindow` in `unassign`, compute the window's target (`contextDesktop`, or `desktopCount()` for Unsorted) and, when the snapshot says it is on another known desktop, enqueue `moveWindows { moves: [one], tidy: autoTidy ? [from, to] : [] }`. Return `{ moving, desktop }`. No `switchTo`, no change to `activeContextId`. `api.ts` returns the new body.
- Tests: assign a window on Desktop 1 to a key-2 context → exactly one `moveWindows` with `{ windowKey, desktop: 2 }` and `tidy: [1, 2]`; already on Desktop 2 → no command, `moving: false`; unassign on Desktop 2 with 6 desktops → move to 6; unassign on Desktop 6 → no command; off-screen mode → no command; `desktop: null` window (minimized) → no command, `moving: false`; `activeContextId` is the same before and after; `autoTidy: false` → `tidy: []`; a failed ack leaves the assignment in place and the window counted in `strays`.

**Step 5: Sort sweeps unsorted windows (server).** `desktops.ts`: `unsortedSweep(windows, assignments, ownedDesktops, shared) -> WindowMove[]`. `sort()` appends it after `misplaced()` and adds the changed desktops as `tidy`. `view.ts` reports `unsortedToMove`.
- Tests: unsorted window on Desktop 2 (owned by a context) → move to 6; unsorted on Desktop 6 → none; unsorted on Desktop 4 that no context maps to → none; `desktop: null` → none; never produced in off-screen mode; project moves come before sweeps in the list; `tidy` lists each source and target desktop once.

**Step 6: `Layout.swift` (pure) and `WindowLayer.tidy` (app).** `Layout.frames(count:area:gap:)`; `Layout.pickMain(_ windows: [(key, bundleId, zIndex)]) -> ordered keys`; `Layout.area(visibleFrame:primaryHeight:)`. Add `currentVisibleFrames()` beside `currentScreenFrames()`. `WindowLayer.tidy(desktop:keys:force:)`: filter (on that desktop, not minimized, not hidden), button-state check, save the before-frames (small JSON in Application Support, like `HiddenStore`), size/position/size, read back, log `tidy desktop=N windows=N applied=N refused=N ms=N`. `undoTidy(desktop:)`. `CommandRunner`: `tidy` command; `moveWindows` runs `tidy` for its `tidy` desktops after the carries.
- Tests (`LayoutTests.swift`): area `0,37 1470×919`, gap 8 → 1 window is `8,45 1454×903`; 2 windows: widths split 60/40 of 1446 with one 8 px gap, same y and height, no overlap; 3 and 4 windows: right slots equal height, gaps 8, bottom edges inside the area; 5 and 7 windows: deck slots step 30 px, share one bottom edge, every slot inside the area; every count 1…12: all frames inside the area and slot 0 is the left one; a Dock on the left (`visibleFrame.x = 70`) shifts everything by 70; a second screen with negative x works; `pickMain` puts Chrome first among Ghostty, Chrome, Ghostty; with two browsers the front-most wins; with none the front-most window wins; the same input twice gives the same order. `TidyTests.swift`: `force: false` with an unchanged key set → skipped; changed set → runs; `force: true` always runs; before-frames round-trip through the file; Undo with nothing saved is a no-op; `AppCommand` decodes `tidy` and `moveWindows.tidy`, and a `moveWindows` without `tidy` decodes to an empty list.

**Step 7: Tidy endpoints (server).** `POST /api/contexts/tidy`, `PATCH /api/contexts/settings`; `autoTidy` stored in a new one-row `context_settings` table in `store.ts` (there is no settings table today); `CommandLane.of("tidy") == .windows`.
- Tests: tidy with no `contextId` targets the active desktop and sends only windows whose `desktop` matches; 409 when the app is silent; unknown field rejected; `autoTidy` defaults to true and survives a restart; on the shared desktop only the active context's windows are sent.

**Step 8: hotkey, HUD, menu.** `Hotkeys.swift`: ⌥T (key code 17) → local tidy of the active desktop from `AppModel.contexts` (works with the server down), then nudge the snapshot. `DesktopHUD.swift`: the panel from "Small additions" 1, text from pure `HUDText.make(contextName:desktop:shared:strays:unsortedHere:)`. `MenuContent`: "Tidy" button, "Undo tidy" when available, the stray line. `MenuLabel`: context name.
- Tests (`MenuPanelTests.swift`): `HUDText` gives "aral · Desktop 2"; with one stray adds "1 window still on Desktop 1 · Sort"; shared desktop gives "Shared · Desktop 6"; no context on the desktop gives "Desktop 4"; a 40-character name is truncated with an ellipsis; plural forms.

**Step 9: dashboard.** Window row: "on Desktop N" when stray; Move shows "Moving…" then "Moved to aral · Desktop 2 · Go" (Go calls the existing switch); Sort label and tooltip from `toSort` and `unsortedToMove`; "Tidy" button per context row; `autoTidy` toggle; `mru-spaces` note. Logic in `contexts-logic.js`, copy through the humanizer skill.
- Tests (`test/dashboard`): label for a stray window; Sort label for (0, 0), (2, 0), (0, 1), (2, 1); Move result text for `moving: true` and `moving: false`; the note hides when the flag is false.

**Step 10: live test in the signed app, then notes.** Run the list below on a throwaway context with two test windows first, then with the owner present on their real windows. Write delays, refused sizes and anything surprising into `personal_docs/gotchas.md`, the decisions above into `decisions.md`.

### Needs a live test in the signed app

1. **Bounce, before the fix (to confirm the cause):** context on Desktop 2 with one window still on Desktop 1; ⌥2. Expected today: slide to 2, then back to 1. After steps 2 and 3: stays on 2, HUD shows the stray hint, no `show bounced` line in the log.
2. Setting size and position through a cached element on a window that is on another desktop: do the frames read back? If not, use the pending-on-arrival path.
3. Move from the dashboard: window lands on the target desktop, the screen ends on the desktop it started on, `activeContextId` unchanged, both desktops tidied.
4. Move to Unsorted: lands on the last desktop.
5. Activating an app (Chrome) that has windows on Desktops 1 and 2 while on 2, with the Desktop 2 window raised first: the screen stays on 2.
6. Tidy with 1, 2, 3, 4 and 6 windows; Dock shown at the bottom, at the left, and hidden; a Ghostty window and a Discord window (minimum sizes).
7. Tidy while a mouse button is held: skipped with the message. Tidy during a carry: refused.
8. Resize a window after Tidy, switch away and back, run Sort with nothing to move: the resize is still there. Then ⌥T: layout returns. Undo: the resize returns.
9. Sort with an unsorted Finder window on a project desktop: it goes to the last desktop; a window set to "All Desktops" is left alone.
10. HUD on ⌥N, on a trackpad swipe, and with Reduce Motion; it never takes focus from the terminal.
