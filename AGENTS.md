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
| Release `.dmg` | `SWITCHYARD_SIGN_IDENTITY=<sha1> bash macos/release.sh` → `dist/macos/Switchyard-<version>.dmg` (see below) |

Run heavy jobs (tests, Swift builds, `release.sh`) one at a time.

CI (`.github/workflows/ci.yml`) runs `npm test`, the type check, `npm audit` and an unsigned `swift build` on macOS for every push to `main` and every pull request. It holds no signing secrets.

## Release

1. Bump `version` in `package.json`. The app's version is read from it.
2. One-time setup: a "Developer ID Application" identity in the keychain, and a notarytool profile: `xcrun notarytool store-credentials switchyard-notary --apple-id <Apple ID> --team-id <team id>` (it asks for an app-specific password and stores it in the keychain).
3. Run `SWITCHYARD_SIGN_IDENTITY=<sha1 from security find-identity -v -p codesigning> bash macos/release.sh`. It builds a universal app (arm64 and x86_64), bundles the server under `Contents/Resources/server`, signs with hardened runtime and a timestamp, packs and signs the `.dmg`, notarizes and staples it, and runs `spctl` on both. Set `SWITCHYARD_NOTARY_PROFILE` if your profile has another name. Without a profile it stops after signing and says so.
4. Upload `dist/macos/Switchyard-<version>.dmg` and its `.sha256` to a GitHub release tagged `v<version>`.

Never commit the identity hash, team id or Apple ID; they come from the environment.

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
