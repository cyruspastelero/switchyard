# API

All endpoints return JSON. Dashboard endpoints need the session cookie (`switchyard_session`, set by `POST /api/auth`; the old `mc_session` name is still accepted). Hook endpoints need `Authorization: Bearer <token>` where the token is in `~/.switchyard/hook-token`, and are answered only for requests from this machine (loopback), also with `--lan`; a valid token from another address gets 403. A WebSocket on the same port carries live updates.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth` | None | `{ code }`, sets the session cookie |
| `GET` | `/api/dashboard` | Cookie | Agent, mission and event counts |
| `GET` | `/api/agents` | Cookie | List agents |
| `PATCH` | `/api/agents/:id` | Cookie | Rename an agent |
| `DELETE` | `/api/agents/:id` | Cookie | Delete an agent |
| `DELETE` | `/api/agents/disconnected` | Cookie | Delete all disconnected agents |
| `GET` | `/api/agents/:id/events` | Cookie | Event history for an agent |
| `GET` | `/api/missions` | Cookie | List missions (`?status=`) |
| `POST` | `/api/missions` | Cookie | `{ title, description, depends_on?, priority? }` |
| `PATCH` | `/api/missions/:id` | Cookie | Update status, assign an agent, complete or fail |
| `DELETE` | `/api/missions/:id` | Cookie | Delete a mission |
| `POST` | `/api/events` | Hook token | Receive a hook event |
| `GET` | `/api/events` | Cookie | Query events (`?limit=&offset=`) |
| `POST` | `/api/instructions` | Cookie | `{ target_agent_id, message }` |
| `GET` | `/api/instructions/:agentId` | Hook token | Pending instructions for an agent |
| `GET` | `/api/usage?hours=24` | Cookie | Tool calls, sessions, daily costs. `hours=0` for all time |
| `GET` | `/api/tokens?hours=24` | Cookie | Token usage and costs from JSONL logs |

## Contexts

Cookie, or the bearer token from loopback.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/contexts` | Contexts, unsorted windows, suggestions, waiting count |
| `POST` | `/api/contexts` | `{ name }`, create a topic context |
| `PATCH` | `/api/contexts/:id` | `{ name?, color?, key?, layoutId? }` (`layoutId`: a preset id, `"auto"` for the automatic layout, or `null` to follow the default). See [Keys and desktops](#keys-and-desktops) |
| `PATCH` | `/api/contexts/settings` | `{ autoTidy?, defaultLayoutId? }` |
| `GET` | `/api/contexts/layouts` | Layout presets `[{ id, name, slots, createdAt }]` |
| `POST` | `/api/contexts/layouts` | `{ name, slots }`, save a preset (the Mac app posts captures here). Each slot: `{ bundleId, app, screen: { uuid, builtin }, frame: { x, y, w, h } }`, frame as fractions 0–1 of the screen's visible area |
| `POST` | `/api/contexts/layouts/capture` | `{ name? }`, ask the Mac app to save the desktop on screen as a preset |
| `PATCH` / `DELETE` | `/api/contexts/layouts/:id` | `{ name }` to rename; delete clears it from contexts and the default |
| `POST` | `/api/contexts/:id/switch`, `/park`, `/restore` | Switch to, park or restore a context |
| `POST` | `/api/contexts/show-all` | Bring every hidden window back; no context is active afterwards |
| `POST` | `/api/contexts/sort` | Sort open windows |
| `POST` | `/api/contexts/assign` | `{ windowKey, contextId }` |
| `POST` | `/api/contexts/windows/name` | `{ windowKey, name }` |
| `POST` | `/api/contexts/suggestions/:id/accept` | Move the suggested tab |
| `POST` | `/api/contexts/desktops` | `{ screen }`, add a desktop at the end of that screen's row |
| `POST` | `/api/contexts/desktops/:n/show` | `{}`, go to Desktop n |
| `POST` | `/api/contexts/desktops/:n/close` | `{}`, close Desktop n |

Used by the Mac app (bearer token):

| Method | Endpoint | Description |
|---|---|---|
| `PUT` | `/api/contexts/snapshot` | Full view of windows and browser tabs (max 1 MB) |
| `GET` | `/api/contexts/commands?since=<seq>` | Long-poll for commands to carry out |
| `POST` | `/api/contexts/commands/:seq/ack` | `{ ok, error? }` |
| `GET` | `/api/contexts/access-code` | `{ accessCode }` for the menu bar's "Copy dashboard access code". Bearer token from loopback only |

`switch`, `park`, `restore`, `sort` and `suggestions/:id/accept` answer `409` when the Mac app has not sent a window snapshot in the last 15 seconds. `GET /api/contexts` also carries `lastFailure` (`{ action, error, at }` or `null`): the last command the app could not carry out.

### Keys and desktops

A context's `key` (1–9 or `null`) is its ⌥N shortcut and its Desktop N. The last desktop is shared: a `null` key, or a key at or above the desktop count, puts the context there.

`PATCH /api/contexts/:id` with a `key` another context holds swaps the two keys in one transaction (it used to answer `409`). `null` frees the context's desktop. Keys outside 1–9 are a `400`. When the key changed and the Mac app is connected, the server then queues one `moveWindows` for both contexts' windows that now sit on the wrong desktop (the same carry Sort does; minimized and fullscreen windows stay put), a `tidy` of the desktops that changed when Auto-tidy is on, and a non-focusing `show` of the active context. No other window moves. Without the app the keys still change and nothing is queued. The response is the updated context, as before.

### Desktops list

In desktop mode, when the Mac app reports its desktops, `GET /api/contexts` carries `desktopList` (otherwise `null`):

```json
{
  "desktops": [
    { "number": 2, "screen": 1, "screenLabel": "Laptop", "showing": true, "shared": false,
      "owners": [{ "id": "…", "name": "aral" }], "windows": 3,
      "closeBlocked": "Desktop 2 belongs to aral. Give aral another desktop first." }
  ],
  "screens": [{ "screen": 1, "label": "Laptop", "addBlocked": null }]
}
```

`screenLabel` is `Laptop` or `Monitor` while each kind appears once, else `Screen N`. `owners` is empty for the shared desktop. `closeBlocked` and `addBlocked` are `null` when the action is allowed, else the reason.

The desktops routes take the same auth as the other dashboard routes. Each answers `{ ok: true }` once the command is queued; the Mac app carries it out, and a failure shows up as `lastFailure`.

| Status | When |
|---|---|
| `400` | `:n` or `screen` is not an integer 1–16, or the body has other fields |
| `404` | No such desktop or screen, or a non-numeric `:n` |
| `409` | The Mac app is not connected; desktops are not in use; the app is too old to report its desktops; or the rules refuse it |

Close is refused for a desktop a context owns, the shared (last) desktop while it holds windows (an empty one may close; the desktop before it becomes shared), the only desktop on its screen, and any desktop before a context's desktop (closing renumbers every later desktop). A desktop added after the last one becomes the new shared desktop. Add is refused for an unknown screen (`404`, checked first), at 16 desktops and on a screen whose new desktop would land before a context's desktop. The `409` body names the context to move, e.g. `"Desktop 3 belongs to aral. Give aral another desktop first."`

### Mac app snapshot and commands

`PUT /api/contexts/snapshot` may send `desktops.list`: one entry per usable desktop in Ctrl+N order, `{ number, space, screen, builtin, showing }`. `space` is the macOS space id, `screen` the 1-based display index (screens in order, never revisited), `builtin` whether that screen is the laptop's. The list must match `desktops.count`. Snapshots without `list` are still valid.

Commands for the desktops routes:

| Command | Fields | What the app does |
|---|---|---|
| `showDesktop` | `desktop` | Goes to that desktop |
| `addDesktop` | `screen` | Opens Mission Control and presses that screen's add button, then checks one more desktop exists |
| `closeDesktop` | `number`, `spaceCheck` | Re-reads the desktops and stops unless `number` is still space `spaceCheck`; steps to a neighbour if it is on screen; removes it in Mission Control; checks the space is gone |
