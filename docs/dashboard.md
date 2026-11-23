# Dashboard guide

Open <http://localhost:4280> and enter the access code shown in the terminal.

## Panels

| Panel | What it shows |
|---|---|
| Agents | Live status with All/Active/Idle filters, current tool and target file, diff stats, files touched, session duration, alert badges. Click an agent to filter the timeline and usage. |
| Missions | Created from agent activity. Expand one to mark it done, reopen it or delete it. |
| Usage & Costs | Token costs from Claude Code's JSONL logs, context window health, daily, model and session breakdowns, and a 24h/7d/30d/All selector. |
| Timeline | Every tool call as it happens. Click a row for the full input and output. |
| Instruct | Send an instruction to the selected agent and see whether it was delivered. |
| Contexts | One card per project: its desktop (a select: pick another desktop and the two projects swap), windows, agents and cost today, with Park, Tidy and Switch. Unsorted windows are listed below with a picker to assign them. With real desktops, a Desktops strip shows one tile per desktop with its owner and window count: click to go, drag the project onto another tile to swap, Select to close several, and a tile to add a desktop. |

Agent status dots: active (pulsing), idle after 60 seconds, disconnected after 5 minutes.

## Missions

Every session gets a mission named after its project folder, and every subagent gets one named after its description. A mission is completed when its session ends. Titles that look like shell commands, file paths or URLs are rejected, and the same title never creates a duplicate. Use `clear done`, `clear all` and `clear old` (disconnected agents) for cleanup.

## Sending instructions

1. Click an agent.
2. Type in the `>_` box (press `i` to focus it) and press Enter.
3. The instruction shows as `pending` until the agent's next tool call, then `delivered`.

Claude Code's hooks can't push a message, only add one when a hook fires. An idle or stuck agent won't see the instruction until it resumes.

## Alerts

| Alert | Trigger |
|---|---|
| STUCK | No events for 2 minutes. |
| LOOP | 3 identical write-type tool calls in a row (Edit, Write, Bash). Read-only tools are ignored. |
| SPIRAL | The same file edited 3 or more times in the last 6 tool calls. |
| ERRORS | 5 or more tool failures in a session. |
| MARATHON | A session running for 30 minutes or more. |

Alerts also raise browser notifications if you allow them.

## Costs

Costs come from the token counts in `~/.claude/projects/*.jsonl` and the model's price (Opus $15/$75, Sonnet $3/$15, Haiku $0.80/$4 per million tokens in/out). When logs aren't available the dashboard estimates from `SWITCHYARD_COST_PER_TOOL_CALL`. Daily totals are kept after raw events are purged.

## Security panel

Press `s` for the security panel. It lists the request checks the server applies (origin, path traversal, WebSocket origin, connection and payload limits, field limits) and a scan of tool calls for dangerous commands, sensitive file access and leaked secrets.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Tab` | Cycle focus: Agents, Missions, Usage, Timeline |
| `j` / `k` | Move up and down in the focused panel |
| `Enter` | Select an agent |
| `i` | Focus the instruction box |
| `/` | Clear the timeline filter |
| `s` | Toggle the security panel |
| `?` | Show help |
| `Esc` | Cancel or unfocus |

## Configuration

Each variable can also be set with its old `MC_` name. `SWITCHYARD_` wins if both are set.

| Variable | Default | What it does |
|---|---|---|
| `SWITCHYARD_DATA_DIR` | `~/.switchyard` | Where the database, hook token and server log live. |
| `SWITCHYARD_EVENT_RETENTION_DAYS` | `7` | Days to keep events. Daily totals are kept longer. |
| `SWITCHYARD_COST_PER_TOOL_CALL` | `0.003` | Cost estimate per tool call when session logs aren't available. |
| `SWITCHYARD_HOST`, `SWITCHYARD_PORT` | `localhost`, `4280` | Where the hook script sends events. Old names: `CLAUDE_MC_HOST`, `CLAUDE_MC_PORT`. |
| `SWITCHYARD_URL` | `http://127.0.0.1:4280` | Server address the Mac app uses. Must be a loopback address. Old name: `MC_URL`. |

Command line: `--port <n>` changes the port and `--open` opens the browser. `--lan` also opens the server to your local network over plain HTTP; use it only on a network you trust.
