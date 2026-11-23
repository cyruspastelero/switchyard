---
name: switchyard-install
description: Install Switchyard on a Mac, from the release .dmg or from source - check Node (and the Xcode tools for a source build), start the server as a login service, open the menu bar app, grant Accessibility and open the dashboard. Use when someone asks to install, set up or reinstall Switchyard.
---

# Install Switchyard

Two ways in. Use the `.dmg` when the user just wants the app; build from source when they want to change it. Stop and report the exact error if a step fails.

## From the .dmg

1. `node --version` must print v22.18.0 or newer. If not, ask the user to install it (for example `brew install node`); don't change their Node setup yourself.
2. The user downloads `Switchyard-<version>.dmg` from https://github.com/cyruspastelero/switchyard/releases, opens it and drags Switchyard to Applications.
3. Start the server bundled in the app, and add the Claude Code hooks if they use Claude Code:

   ```bash
   SERVER="/Applications/Switchyard.app/Contents/Resources/server/src/index.ts"
   node "$SERVER" install-service
   node "$SERVER" install          # only if they use Claude Code
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4280/login.html   # expect 200
   ```

4. `open /Applications/Switchyard.app`, then continue at step 5 below (Accessibility) and step 6 (dashboard).

To uninstall, run the same two commands with `uninstall-service` and `uninstall`, then move the app to the Trash.

## From source

Run every command from the repository root.

## 1. Check the tools

```bash
node --version          # needs v22.18.0 or newer
xcode-select -p         # prints a path when Xcode or the Command Line Tools are installed
swiftc --version
```

- Node too old or missing: ask the user to install Node 22.18+ (for example `brew install node`). Don't change their Node setup yourself.
- `xcode-select -p` fails: run `xcode-select --install` and wait for the user to finish the installer.

## 2. Run the tests

```bash
npm test
```

No `npm install` is needed: the server has no runtime dependencies. All tests should pass.

## 3. Start the server

Ask whether the user uses Claude Code. If they do, add the hooks (this edits `~/.claude/settings.json` and saves a backup next to it):

```bash
node src/index.ts install
```

Then install the login service, which keeps the server running on `127.0.0.1:4280`:

```bash
node src/index.ts install-service
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4280/login.html   # expect 200
```

If the user doesn't want a background service, run `node src/index.ts` in a terminal they keep open instead.

## 4. Build and open the Mac app

```bash
bash macos/build-app.sh
open macos/build/Switchyard.app
```

Signing is optional. With `SWITCHYARD_SIGN_IDENTITY` set to a code-signing identity from the keychain (`security find-identity -v -p codesigning` lists them; a self-signed one works), macOS keeps the Accessibility grant across rebuilds. Without it the build is signed ad hoc and macOS asks again after every rebuild.

## 5. Grant Accessibility

The user has to do this by hand: System Settings > Privacy & Security > Accessibility, turn on **Switchyard**. The app's menu bar panel has an "Allow in Accessibility settings" button that opens the right page. The first time the app reads Chrome or Arc, macOS asks for Automation access; tell the user to allow it.

## 6. Open the dashboard

```bash
open http://localhost:4280
grep 'Access Code' ~/.switchyard/server.log | tail -1
```

The 6-digit code in that line (it changes on every server start) signs the user in. The menu bar icon also has "Copy code". Then tell the user: ⌥1 to ⌥9 switch projects, ⌥Space searches them, ⌥T tidies the current desktop, and **Sort windows** in the dashboard puts every window on its project's desktop.

## Uninstall

```bash
node src/index.ts uninstall-service
node src/index.ts uninstall      # removes the Claude Code hooks
```

Then quit the app from its menu and delete `macos/build/Switchyard.app`. Data lives in `~/.switchyard`; delete it only if the user asks.
