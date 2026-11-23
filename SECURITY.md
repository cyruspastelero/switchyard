# Security

## Security checks

Last full review: 2026-11-23. Each check below is backed by tests in `test/security/`, `test/ws.test.ts` or the Swift tests.

- **Dependencies.** No runtime dependencies. The server uses only Node built-ins (`node:sqlite`, `node:http`, a built-in WebSocket server). `npm audit` reports 0 vulnerabilities; the two dev dependencies are the TypeScript compiler and Node's type definitions.
- **Authentication and sessions.** Access code from a CSPRNG, kept in memory, compared in constant time, with a lockout after 5 wrong tries. Session cookie is `HttpOnly`, `SameSite=Strict` and expires on the server after 24 hours. The hook token file is mode `0600` and the token is accepted from loopback only (also with `--lan`), never from a browser.
- **Cross-site requests and DNS rebinding.** The server listens on `127.0.0.1`, answers only for its own host names, accepts only same-origin browser requests (HTTP and WebSocket), sends no CORS headers, and requires `application/json` for request bodies.
- **Input validation.** Every request body is parsed into a typed value with size limits and unknown fields rejected. All SQL uses bound parameters. Static files are served by fixed name only.
- **XSS.** The dashboard writes window titles, tab titles and URLs with `textContent` only. The Content Security Policy allows scripts from the server itself and nothing inline.
- **Script injection in the Mac app.** AppleScript and JXA sources are static; values are passed as arguments. Server commands are a fixed set, URLs are limited to an allow-list of schemes, and no command carries screen coordinates. Child processes get argument arrays, never a shell string.
- **Data at rest.** Tool calls are stored as a short summary (path or command, 200-character output preview) with keys, tokens and passwords redacted. File contents are never stored. Events are deleted after 7 days. The data folder is `0700` and its files `0600`.
- **No outbound network.** The server and dashboard make no requests to other hosts and load no fonts, scripts or analytics from elsewhere. The Mac app talks to the local server only.
- **Mac app hardening.** Signed with the hardened runtime and one entitlement (Apple Events).
- **Secrets scan.** Source and git history were searched for keys, tokens and private keys; none found.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: the **Security** tab of this repository, then **Report a vulnerability**. Don't open a public issue for it.
