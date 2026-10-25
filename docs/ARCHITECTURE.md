# Architecture

PC Bridge is deliberately small: one dependency-free Node.js process, one
Manifest V3 extension, and a JSON protocol carried inside ordinary chat
messages.

---

## Components

```text
extension/
  manifest.json      permissions + supported sites
  background.js      service worker; proxies fetch() to localhost
  shared.js          protocol parsing, prime message, result formatting
  adapters.js        site-specific DOM detection and message sending
  ui.js              shadow-DOM control panel
  content.js         state machine: watch answer -> execute -> send result

server/
  server.js          HTTP API, path confinement, tool execution, logging
  public/            dashboard (HTML/CSS/JS, no framework)

dev/
  mock-chat.html     fake AI chat used for end-to-end tests without an account
```

The extension never talks to a remote service. The only network destination is
`http://127.0.0.1:8787` (or the configured local port).

---

## Request lifecycle

1. **Prime.** When the bridge is enabled, the content script inserts a protocol
   message into the chat. It tells the AI the workspace path, the tool format,
   the one-operation-per-reply rule, and the safety rules.
2. **Observe.** A 900 ms loop reads the newest assistant message from the DOM.
   It waits until the text is stable and the site is no longer generating.
3. **Parse.** `shared.js` reconstructs fenced blocks (some UIs strip backticks)
   and extracts `bridge` JSON operations. A bare JSON object is accepted as a
   fallback.
4. **Approve or run.** With auto-run on, the operation is sent immediately.
   With auto-run off, the panel shows an approval card.
5. **Execute.** The content script calls the background worker, which performs
   `fetch('http://127.0.0.1:8787/api/<tool>')` with the `X-Bridge-Token` header.
6. **Result.** The server returns JSON. The extension formats it with
   `[PC BRIDGE RESULT #n]` markers and sends it as the next user message.
7. **Loop.** The AI sees the result and emits the next operation, until it calls
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
- Creates the workspace and `<workspace>/.bridge`.
- Listens on `127.0.0.1` only.

### API

Every endpoint returns JSON. Mutating tool endpoints require:

```http
X-Bridge-Token: <48-character token>
Content-Type: application/json
```

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/ping` | Version, OS, workspace, pause state, counters. |
| `GET` | `/api/log` | Recent activity entries. |
| `POST` | `/api/control` | Pause or resume AI access. |
| `POST` | `/api/workspace` | Validate, create, persist, and activate a new workspace. |
| `POST` | `/api/exec` | Run a command with a workspace-relative `cwd`. |
| `POST` | `/api/write` | Create or replace a file. |
| `POST` | `/api/read` | Read a UTF-8 file. |
| `POST` | `/api/list` | List a directory. |
| `POST` | `/api/mkdir` | Create a directory. |
| `POST` | `/api/move` | Move or rename a path. |
| `POST` | `/api/remove` | Remove a file or directory. |
| `POST` | `/api/stat` | File metadata. |
| `POST` | `/api/open` | Open a folder in Explorer/Finder. |

### Path confinement

Every file tool calls `resolveInside()`:

```js
const abs = path.resolve(config.workspace, input);
const rel = path.relative(config.workspace, abs);
if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(403, ...);
```

This rejects `..` escapes and absolute paths outside the workspace. Symlinks and
junctions are not canonicalized, so do not place untrusted links inside the
workspace.

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
- `cwd` is resolved through the same workspace confinement as file tools.
- A small denylist blocks catastrophic patterns (disk formatting, registry hive
  deletion, backup deletion, `rm -rf /`, etc.). This is a guardrail, **not a
  security boundary**.

### Activity log

Recent entries live in memory for the dashboard and are appended to
`logs/activity.jsonl`. Command stdout/stderr may contain sensitive data; the
folder is git-ignored and local only.

---

## Extension

### Permissions

- `storage` — persist server URL, token, toggles, and selectors.
- `activeTab` — open the dashboard when the user clicks the action.
- `host_permissions` for `127.0.0.1` / `localhost` only.
- Content scripts run only on the five supported chat domains.

No remote code, analytics, or third-party scripts are used.

### Fencing

The panel is rendered inside a shadow root with constructable stylesheets, so
site CSS cannot break it and its CSS cannot leak into the page. The panel does
not use inline event handlers.

### Site adapters

`adapters.js` contains a profile per site. Each profile answers:

- Which element is the chat composer?
- Which element is the newest assistant answer?
- Which element sends the message?
- How do we read message text, including code fences?

DeepSeek is fully tested. The other adapters use generic textarea/button
heuristics and may need selector updates after a site redesign. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for adding a site.

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

`config.example.json` is committed as documentation. The real `config.json`
is generated on first run and never committed.

---

## Known limitations

- UI automation is brittle; site updates can break selectors.
- The extension cannot run while the chat tab is closed.
- If the chat composer has a draft, automatic sending pauses.
- The server is single-process and keeps activity only in memory for the
  dashboard; the JSONL file is the durable record.
- `exec` inherits the user's full filesystem permissions.
- Only one bridge chat should be active at a time per browser.
- Automated site use may be rate-limited or restricted by the site's terms.
