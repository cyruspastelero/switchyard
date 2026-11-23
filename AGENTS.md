# Agent guide

Switchyard is a local Node server (`src/`) with a plain-JS dashboard (`src/dashboard/`) and a SwiftUI menu bar app (`macos/`). The server decides; the app only reads windows and carries out commands.

## Build, test, run

| Task | Command |
|---|---|
| Server tests | `npm test` (node:test, no install needed) |
| Type check | `npm install` once, then `npm run typecheck` |
| Run the server | `node src/index.ts` (prints the access code), or `node src/index.ts install-service` for a LaunchAgent on port 4280 |
| Restart the service | `launchctl kickstart -k gui/$(id -u)/ph.pastelero.switchyard.server` |
| Build the Mac app | `bash macos/build-app.sh` → `macos/build/Switchyard.app`. Set `SWITCHYARD_SIGN_IDENTITY` to keep macOS grants across rebuilds. |
| Swift tests | `swift test --package-path macos` (needs full Xcode; the Command Line Tools have no XCTest) |

Run heavy jobs (tests, Swift builds) one at a time.

## Conventions

- Zero runtime dependencies. Use Node built-ins (`node:sqlite`, `node:http`, `node:test`). Dev dependencies stay limited to TypeScript and `@types/node`.
- TypeScript runs directly in Node, so only erasable syntax: no enums, no namespaces, no parameter properties. Use `import type` for types and `.ts` in relative imports.
- Dashboard files are classic scripts sharing one global scope, loaded in the order in `src/dashboard/index.html`. A new file needs a route in `src/server.ts` and entries in `test/dashboard-cache.test.ts` and `test/security/browser-attacks.test.ts`.
- Test names describe behavior in snake_case: `it('owner_assignment_is_never_resorted', ...)`, `func test_nothing_to_lay_out_never_runs()`. Write the failing test first.
- Keep pure logic (matching, layout, carry plans) in testable functions; the Accessibility and AppleScript calls stay thin.
- Validate every request body into a typed value; bind all SQL parameters; write untrusted text with `textContent`.
- Commits follow Conventional Commits (`feat`, `fix`, `docs`, `chore`, `refactor`, `test`), one logical change each.

## Docs

- `README.md`: what it is, install, use, permissions.
- `docs/API.md`: HTTP routes. `docs/dashboard.md`: panels, alerts, shortcuts, environment variables.
- `docs/superpowers/specs/2026-11-22-contexts-design.md`: the contexts design and why the window carry works the way it does.
- `SECURITY.md`: security checks and how to report a problem.
- `skills/switchyard-install/SKILL.md`: step-by-step install for an agent.
