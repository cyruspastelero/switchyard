# Switchyard

Switchyard gives each of your projects its own macOS desktop. A small menu bar app reads your Chrome, Arc, Ghostty and editor windows, a local server works out which project each one belongs to, and Sort puts every window on its project's desktop. You switch projects with one key. The same server runs a dashboard for your Claude Code agents: what each one is doing, what it costs, and which ones are waiting on you.

Everything runs on your Mac. Nothing is sent anywhere.

## Requirements

- macOS 14 or newer.
- Node.js 22.18 or newer. The server has no runtime dependencies.
- Xcode or the Xcode Command Line Tools, to build the Mac app.
- [Claude Code](https://docs.claude.com/en/docs/claude-code), if you want the agent dashboard. Window sorting works without it.

## Install

There's no download yet (a signed `.dmg` is coming soon). Build from source:

```bash
git clone https://github.com/cyruspastelero/switchyard.git
cd switchyard
npm test                                 # optional; needs no npm install
node src/index.ts install                # add the Claude Code hooks (skip if you don't use Claude Code)
node src/index.ts install-service        # run the server at login, on 127.0.0.1:4280
bash macos/build-app.sh                  # build macos/build/Switchyard.app
open macos/build/Switchyard.app
```

`install` edits `~/.claude/settings.json` and keeps a backup next to it. To undo the steps, run `node src/index.ts uninstall` and `node src/index.ts uninstall-service`.

If you'd rather not run a background service, start the server by hand with `node src/index.ts` and leave the terminal open.

The app is signed ad hoc, so macOS asks for Accessibility again after every rebuild. To keep the grant, set `SWITCHYARD_SIGN_IDENTITY` to a code-signing identity from your keychain (a self-signed one works) before running `build-app.sh`.

## Use

| Key or place | What it does |
|---|---|
| <kbd>⌥</kbd><kbd>1</kbd> to <kbd>⌥</kbd><kbd>9</kbd> | Switch to the project on that desktop. |
| <kbd>⌥</kbd><kbd>Space</kbd> | Search your projects and switch. |
| <kbd>⌥</kbd><kbd>T</kbd> | Tidy the current desktop: lay its windows out side by side. |
| Menu bar icon | Sort windows, tidy, open the dashboard, copy the access code. |
| <http://localhost:4280> | The dashboard. |

The dashboard has two views. **Contexts** shows one card per project with its desktop, windows and agents. From there you can Sort, move a window to another project, rename Chrome windows, or park a project (close its browser windows and save the tabs for later). **Activity** shows your agents live, a timeline of their tool calls, alerts for stuck or looping agents, and token costs. See [docs/dashboard.md](docs/dashboard.md) for the panels, alerts, shortcuts and environment variables.

The dashboard asks for a 6-digit access code. It changes every time the server starts. Copy it from the menu bar icon, or find it in `~/.switchyard/server.log`.

Windows Switchyard can't place go to the last desktop as Unsorted, and you can assign them by hand. It never re-sorts a window you placed yourself.

## Permissions

| Permission | Why |
|---|---|
| Accessibility | To read window titles, and to move and resize windows. macOS has no public API for moving a window to another desktop, so Sort drags it there: you'll see the pointer grab each window's title bar for about a second. |
| Automation (Chrome, Arc) | To read tab titles and URLs, and to name Chrome windows. Asked the first time the app talks to each browser. |
| Notifications | One notice when an agent starts waiting on you. Optional. |

The keyboard shortcuts need no permission. The app never records the screen.

## Security

The server listens on `127.0.0.1` only, refuses requests from other websites, and keeps its data in `~/.switchyard` with owner-only file modes. Tool calls are stored as short summaries with secrets redacted, and deleted after 7 days. See [SECURITY.md](SECURITY.md) for the full list of checks and how to report a problem. The HTTP API is in [docs/API.md](docs/API.md).

## Limitations

- Only the main display's desktops are managed.
- Ghostty has no scripting interface, so its windows are matched by title (the folder or the Claude session name).
- Chrome can't move a tab between windows through AppleScript. Moving a tab reopens its URL, so page state is lost.
- Arc windows can't be named.

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Switchyard was called Claude Mission Control before; data in `~/.claude-mission-control` and old `MC_*` environment variables are picked up automatically.
