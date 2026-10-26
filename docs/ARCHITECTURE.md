# Architecture

PC Bridge is deliberately small: one dependency-free Node.js process, one
Manifest V3 extension, and a JSON protocol carried inside ordinary chat
messages.

---

## Components

```text
extension/
  manifest.json      permissions, built-in sites, options page
  background.js      service worker; API proxy, per-site grants, injection
  shared.js          protocol parsing, tool catalog, prime message, formatting
  adapters.js        built-in site profiles + generic/custom DOM detection
  ui.js              shadow-DOM control panel
  content.js         state machine: watch answer -> execute -> send result
  options.html/css/js  extension settings + custom-site access manager

server/
  server.js          HTTP API, platform allowlist, file policy, tool execution
  public/            dashboard (HTML/CSS/JS, no framework)

dev/
  mock-chat.html     fake AI chat used for end-to-end tests without an account
```

The extension never talks to a remote service. The only network destinations
are `http://127.0.0.1:8787` (or the configured local port) and the AI chat site
itself, which the user has already opened.

---

## Request lifecycle

1. **Prime.** When the bridge is enabled, the content script inserts a protocol
   message into the chat. It tells the AI the workspace path, whether full PC
   file access is active, the 17-tool catalog, the eight-operation batching
   rule, and the safety rules.
2. **Observe.** A `MutationObserver` schedules a tick when the chat DOM changes
   (220 ms debounce). A 1.8 s fallback interval covers sites that render outside
   normal DOM mutations, and a 12 s ping keeps connection state fresh. The newest
   assistant answer is cached and invalidated on mutation or conversation
   change.
3. **Parse.** `shared.js` reconstructs fenced blocks (some UIs strip backticks)
   and extracts `bridge` JSON operations. A bare JSON object is accepted as a
   fallback. `file:` blocks are paired with `write`.
4. **Approve or run.** With auto-run on, the batch is sent immediately. With
   auto-run off, the panel shows one approval card for the whole batch.
5. **Execute.** The content script calls the background worker for each
   operation in order. The worker performs
   `fetch('http://127.0.0.1:8787/api/<tool>')` with the `X-Bridge-Token` header.
   Up to 8 operations run per AI reply.
6. **Result.** The server returns JSON. The extension formats one
   `[PC BRIDGE RESULT #n]` block per operation, joins them, and sends the batch
   as the next user message with a continuation hint.
7. **Loop.** The AI sees the results and emits the next batch, until it calls
   `done`.

A message hash prevents the same assistant message from being executed twice.
Processed hashes reset when the conversation URL changes.

---

## Server

### Startup

- Reads `server/config.json` (created on first run from defaults).
- Reads `server/token.txt`, or generates 24 random bytes (48 hex characters).
- Resolves the workspace: absolute paths are used as-is; relative paths are
  resolved from the repository root.
- Reads `fullPcAccess` (default `false`) and logs a warning banner when it is on.
- Normalizes and deduplicates `customPlatforms`, discarding built-in or invalid
  origins and capping the list at 50.
- Creates the workspace and `<workspace>/.bridge`.
- Listens on `127.0.0.1` only.

### API

Every endpoint requires:

```http
X-Bridge-Token: <48-character token>
Content-Type: application/json
```

`GET /api/ping` and `GET /api/log` read the token from the header. All tool
endpoints are `POST`. Every response is JSON and `no-store`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/ping` | Version, OS, workspace, pause state, access mode, counters, tools, platforms. |
| `GET` | `/api/log` | Recent activity entries, access mode, counters, platforms. |
| `GET` | `/api/platforms` | Built-in and custom AI sites, plus the custom limit. |
| `POST` | `/api/platforms` | Add, remove, or clear custom sites (`action`). |
| `POST` | `/api/control` | Pause or resume AI access. |
| `POST` | `/api/access` | Enable or disable full PC file access. |
| `POST` | `/api/workspace` | Validate, create, persist, and activate a new workspace. |
| `POST` | `/api/exec` | Run a command with a relative or absolute `cwd` (mode-dependent). |
| `POST` | `/api/write` | Create, replace, or append a file. |
| `POST` | `/api/read` | Read a UTF-8 file, optionally by line range. |
| `POST` | `/api/list` | List a directory, optionally recursively. |
| `POST` | `/api/mkdir` | Create a directory. |
| `POST` | `/api/move` | Move or rename a path. |
| `POST` | `/api/copy` | Copy a file or folder. |
| `POST` | `/api/remove` | Remove a file or directory. |
| `POST` | `/api/stat` | File metadata. |
| `POST` | `/api/open` | Open a folder in Explorer/Finder. |
| `POST` | `/api/edit` | Replace exact text in a file. |
| `POST` | `/api/grep` | Search file contents. |
| `POST` | `/api/find` | Find paths by glob. |
| `POST` | `/api/hash` | Hash 1-50 files. |
| `POST` | `/api/download` | Download a URL to the workspace. |
| `POST` | `/api/fetch` | Fetch a URL as text. |
| `POST` | `/api/system` | OS, CPU, memory, disk, and workspace snapshot. |

The dashboard at `/` is served locally and contains the token in a meta tag so
the page can call the same API. It is not reachable from another machine
because the server binds to loopback only.

### AI platform allowlist

`originAllowed()` accepts:

- the extension (`chrome-extension://<32 chars>`),
- the six built-in chat origins,
- `http://127.0.0.1` and `http://localhost` on any port,
- exact origins listed in `config.customPlatforms`.

Custom sites are normalized to an exact `http(s)` origin. Paths, queries, and
embedded credentials are discarded or rejected. The list is capped at 50.
`POST /api/platforms` supports:

```json
{"action":"add","origin":"https://chat.example.com"}
{"action":"remove","origin":"https://chat.example.com"}
{"action":"clear"}
```

Successful responses include `builtin`, `custom`, and `maxCustom`. Adding a
built-in or duplicate site is a no-op with `added: false`; removing a built-in
is rejected. The list is written atomically to `config.json` before the runtime
value changes.

### File-access policy

Every file tool calls `resolveInside()`. There are two modes.

**Workspace only (default, `fullPcAccess: false`):**

```js
const abs = path.resolve(config.workspace, input);
const rel = path.relative(config.workspace, abs);
if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(403, ...);
```

This rejects `..` escapes and absolute paths outside the workspace.

**Full PC access (opt-in, `fullPcAccess: true`):**

```js
raw = expandFullPath(raw);              // %USERPROFILE%, ~
const abs = path.resolve(config.workspace, raw);
```

Absolute paths are accepted anywhere the Windows user can reach. Relative paths
still resolve from the workspace, so existing project operations keep working.
The UI prefix is handled by `relToWorkspace()`: paths outside the workspace are
reported as absolute paths.

In both modes, `remove`, `move`, `copy`, and `download` overwrites call
`assertSafeDestructiveTarget()`. Full mode additionally refuses to touch:

- drive roots (`C:\`, `D:\`),
- the user-profile root (or any of its ancestors),
- `Windows`, `Program Files`, `Program Files (x86)`, `ProgramData`,
- the Bridge `server`, `extension`, `dev`, and `logs` folders.

Writes in full mode still obey Windows ACLs. Symlinks and junctions are not
canonicalized, so do not place untrusted links inside the workspace.

### Full PC access state

`POST /api/access` is the only mutation path:

```json
{"fullPcAccess": true, "confirmation": "FULL PC ACCESS"}
```

- Enabling requires the exact confirmation string (case-insensitive, trimmed).
- Disabling needs no confirmation and takes effect immediately.
- The value is persisted atomically to `config.json` before the runtime value
  changes, so it survives restarts.
- The AI cannot call this endpoint: bridge operations are routed through the
  tool allowlist, and only the local dashboard sends `access`.
- Both `ping` and `log` report the mode so dashboard and extension stay in sync.

Changing the workspace is protected against:

- entire drive roots,
- Windows and Program Files trees,
- the Bridge application folders (`server`, `extension`, `dev`, `logs`),
- any ancestor folder that contains the Bridge app.

The new folder is created, probed for writability, then persisted atomically to
`config.json` before the runtime value changes.

### exec

- Shell: PowerShell by default, `cmd` when the operation sets `"shell":"cmd"`.
- Timeout: default 180 s, configurable up to 900 s, process tree killed on
  timeout.
- Output capped by `maxOutputBytes`; full output is written to
  `<workspace>/.bridge/exec-*.log`.
- `cwd` is resolved through the same file-access policy as file tools. In full
  mode it may be an absolute path; otherwise it must stay inside the workspace.
- Non-zero exit codes are returned as `ok: true` with `exitCode` so the AI can
  read the error output instead of treating it as a transport failure.
- A small denylist blocks catastrophic patterns (disk formatting, registry hive
  deletion, backup deletion, `rm -rf /`, etc.). This is a guardrail, **not a
  security boundary**.

### File tools

- All paths pass through `resolveInside()`; relative paths resolve from the
  workspace, and absolute paths require full PC mode.
- `write` and `edit` cap files at 8 MB. `read` defaults to 400 KB and caps at
  2 MB. `grep` skips files over 1 MB by default.
- `edit` refuses ambiguous replacements unless `replaceAll` is set, and supports
  up to 50 changes in one call.
- `list` and `find` cap traversal depth, visited entries, and returned rows.
- `grep` and `find` skip `.git`, `node_modules`, `.bridge`, `dist`, `build`, and
  `coverage` by default; `includeHidden`/`includeIgnored` opt back in.
- `download` writes to a `.pcb-part` file, enforces byte and time limits, and
  renames only on success.
- `fetch` and `download` accept only `http(s)` URLs without embedded
  credentials. `fetch` reports binary responses instead of decoding them.

### Activity log

Recent entries live in memory for the dashboard and are appended to
`logs/activity.jsonl`. Command stdout/stderr may contain sensitive data; the
folder is git-ignored and local only.

---

## Extension

### Permissions

- `storage` — persist server URL, token, toggles, selectors, and enabled state.
- `activeTab` — act on the tab whose toolbar icon was clicked.
- `scripting` — inject and dynamically register the content script for approved
  custom sites.
- `host_permissions` for `127.0.0.1` / `localhost` only.
- `optional_host_permissions` for `http://*/*` and `https://*/*`. Nothing is
  granted by default; Chrome asks per origin when the user adds a custom site or
  clicks the toolbar icon on one.
- Static content scripts run only on the six built-in chat domains. Custom sites
  use dynamic registration after the per-origin grant.

No remote code, analytics, or third-party scripts are used.

### Custom-site flow

1. The user adds an origin in the dashboard or options page, or clicks the
   toolbar icon on an unlisted chat site.
2. The extension requests `origin/*` through `chrome.permissions.request`.
   This must happen directly in the user-gesture handler.
3. The origin is posted to `/api/platforms`, which adds it to the server's
   exact-origin allowlist.
4. `background.js` registers a dynamic content script for the origin
   (`persistAcrossSessions: true`) and injects the content files into the
   current tab if needed.
5. The panel toggles. Future page loads run the content script automatically.

Revoking access removes the browser permission and unregisters the dynamic
content script. Removing the site from the server list is a separate action.

### Fencing

The panel is rendered inside a shadow root with constructable stylesheets, so
site CSS cannot break it and its CSS cannot leak into the page. The panel does
not use inline event handlers.

### Site adapters

`adapters.js` contains a profile per built-in site plus a generic fallback.
Each profile answers:

- Which element is the chat composer?
- Which element is the newest assistant answer?
- Which element sends the message?
- How do we read message text, including code fences?

DeepSeek is fully tested. The other built-ins use profile plus generic
heuristics and may need selector updates after a site redesign. Custom sites use
the generic adapter; the panel's **Advanced → selectors** overrides are stored
in extension settings and applied live. See [CONTRIBUTING.md](../CONTRIBUTING.md)
for adding a site.

### Send safety

The bridge **never overwrites a draft**. If the composer contains text, sending
is skipped and the panel offers Retry or Copy. This prevents accidental loss of
a user's typed message.

### Result trust boundary

The server output is wrapped in:

```text
--- OUTPUT ---
...
--- END OUTPUT ---
```

The prime message tells the AI that this region is untrusted data, not
instructions. This reduces prompt-injection risk from command output but does
not eliminate it. A repository README, dependency, or compiler error can still
contain adversarial text.

---

## Data flow and files

```text
pc-bridge/
├── server/config.json      runtime config        git-ignored
├── server/token.txt        secret token          git-ignored
├── logs/activity.jsonl     dashboard history     git-ignored
└── workspace/              default projects      git-ignored
    └── .bridge/            full command logs     git-ignored
```

`config.example.json` is committed as documentation. The real `config.json` is
generated on first run and never committed. `customPlatforms` is stored in the
same file and survives restarts.

---

## Known limitations

- UI automation is brittle; site updates can break selectors.
- Custom sites use a generic DOM adapter, so unusual layouts may need manual
  selectors.
- The extension cannot run while the chat tab is closed.
- If the chat composer has a draft, automatic sending pauses.
- The server is single-process and keeps activity only in memory for the
  dashboard; the JSONL file is the durable record.
- `exec` inherits the user's full filesystem permissions.
- Full PC access widens the file tools to the whole machine; the workspace
  boundary is gone until it is disabled.
- Only one bridge chat should be active at a time per browser.
- Batching is sequential; operations that depend on each other must wait.
- Automated site use may be rate-limited or restricted by the site's terms.
