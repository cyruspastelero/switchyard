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
| `PATCH` | `/api/contexts/:id` | `{ name?, color?, key?, layoutId? }` (`layoutId`: a preset id, or `null` for the default) |
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

Used by the Mac app (bearer token):

| Method | Endpoint | Description |
|---|---|---|
| `PUT` | `/api/contexts/snapshot` | Full view of windows and browser tabs (max 1 MB) |
| `GET` | `/api/contexts/commands?since=<seq>` | Long-poll for commands to carry out |
| `POST` | `/api/contexts/commands/:seq/ack` | `{ ok, error? }` |
| `GET` | `/api/contexts/access-code` | `{ accessCode }` for the menu bar's "Copy dashboard access code". Bearer token from loopback only |

`switch`, `park`, `restore`, `sort` and `suggestions/:id/accept` answer `409` when the Mac app has not sent a window snapshot in the last 15 seconds. `GET /api/contexts` also carries `lastFailure` (`{ action, error, at }` or `null`): the last command the app could not carry out.
