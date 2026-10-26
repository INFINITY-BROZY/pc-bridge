# Contributing

Thanks for improving PC Bridge. The project is intentionally dependency-free and
small enough to audit in one sitting.

## Ground rules

- Keep the server limited to Node.js built-ins.
- Keep the extension Manifest V3 and dependency-free.
- Never weaken token authentication, localhost binding, CORS, or workspace
  confinement.
- Never add analytics, remote code, or third-party CDNs.
- Preserve the “never overwrite a draft” behavior.
- Treat AI output and command output as untrusted.

## Local development

```powershell
git clone https://github.com/INFINITY-BROZY/pc-bridge.git
cd pc-bridge
npm run check
npm test
```

`npm test` copies the server into a temporary folder, starts it on an isolated
port with a test token, and exercises platform management, custom CORS, every
tool, file guards, downloads/fetches, workspace changes, full PC access, pause,
and traversal rejection. It does not touch your real config, token, or projects.

### Mock chat

To develop the extension without a live AI account:

```powershell
$env:PC_BRIDGE_DEV = "1"
$env:PC_BRIDGE_PORT = "8788"
npm run dev
```

Open `http://127.0.0.1:8788/mock`. The page loads the real extension scripts and
stubs `chrome.runtime`/`chrome.storage`, then scripts an AI that runs a command,
writes a file, and finishes.

## Repository layout

| Path | Purpose |
| --- | --- |
| `server/server.js` | HTTP API, tools, path checks, safety policy. |
| `server/public/` | Dashboard, no build step. |
| `extension/` | Unpacked Chromium extension, including the options page. |
| `docs/` | Install, architecture, protocol, troubleshooting. |
| `tests/` | Dependency-free smoke tests. |
| `scripts/` | Maintenance scripts. |
| `dev/` | Mock chat + icon generator. |

## Code style

- 2-space indentation, semicolons, single quotes in JavaScript.
- Prefer small, named functions.
- New server endpoints must authenticate and validate input.
- New file operations must go through `resolveInside()`.
- Extension UI stays inside the shadow root; no inline event handlers.
- Update docs and `CHANGELOG.md` with user-visible changes.

Run `npm run check` before committing.

## Adding a chat site

Custom sites need no code: add them in the dashboard or options page and grant
per-site access. Use the built-in path only when a site deserves a tuned adapter.

1. Add the domain to `matches` in `extension/manifest.json`.
2. Add the origin to `BUILTIN_ORIGINS` in `extension/background.js`, the server's
   `BUILTIN_PLATFORMS`/CORS list, and `FALLBACK_BUILTIN` in `options.js`.
3. Add a profile in `extension/adapters.js`:
   - assistant selector,
   - composer selector,
   - send-button selector or Enter fallback,
   - text extraction behavior.
4. Reload the unpacked extension and refresh the site.
5. Test with **Advanced → Test finders**.
6. Update the supported-site table in `README.md`.

Automatic UI automation is fragile. Prefer resilient selectors and keep the
generic fallback working.

## Adding a tool

1. Add the handler and route in `server/server.js`, then add the name to
   `TOOL_NAMES`.
2. Add it to `allowed` in `shared.js`, `PCB.opSummary`, and `SAFE_TOOLS` in
   `background.js`.
3. Keep path work inside `resolveInside()`.
4. Document it in `docs/PROTOCOL.md` and the prime message if the AI needs it.
5. Add smoke coverage in `tests/smoke.test.js`.

## Pull requests

- One focused change per PR.
- Include a short “what changed / why / how tested” section.
- Include screenshots for panel or dashboard changes.
- Do not include runtime files, tokens, personal paths, or AI-generated binaries.
- Ensure CI passes on Windows and Linux.

Use the PR template. By contributing, you agree that your work is licensed under
the MIT license.
