<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="PC Bridge logo">
</p>

<h1 align="center">PC Bridge</h1>
<h3 align="center">Chat with AI. Build on your real PC.</h3>

<p align="center">
  A local-only bridge between an AI chat in your browser and your computer.<br>
  Built-in adapters cover DeepSeek, ChatGPT, Claude, Gemini, and Grok — and you can
  add any other chat site from the dashboard. The AI writes commands or files inside
  fenced <code>bridge</code> blocks; the extension runs them through a token-protected
  localhost server and posts the results back into the chat automatically.
</p>

<p align="center">
  <a href="https://www.microsoft.com/windows"><img src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4?logo=windows" alt="Windows 10/11"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white" alt="Node 20+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e" alt="MIT license"></a>
  <a href="#security"><img src="https://img.shields.io/badge/network-127.0.0.1%20only-22d3ee" alt="Local network only"></a>
  <a href="https://github.com/INFINITY-BROZY/pc-bridge/actions/workflows/ci.yml"><img src="https://github.com/INFINITY-BROZY/pc-bridge/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/INFINITY-BROZY/pc-bridge/stargazers"><img src="https://img.shields.io/github/stars/INFINITY-BROZY/pc-bridge?color=f5c542" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="docs/INSTALL.md"><strong>Install guide</strong></a>
  ·
  <a href="docs/ARCHITECTURE.md">How it works</a>
  ·
  <a href="docs/PROTOCOL.md">Protocol</a>
  ·
  <a href="docs/TROUBLESHOOTING.md">Troubleshooting</a>
</p>

<p align="center">
  <img src="docs/assets/dashboard.png" alt="PC Bridge dashboard showing server status, access token, project location, file access, AI platforms, and activity log" width="920">
</p>

---

## What it does

You talk to an AI chat like normal. When the AI needs your PC, it emits a
structured block:

```bridge
{"tool":"exec","command":"npm install","cwd":"my-app","timeout":300}
```

PC Bridge runs it, captures stdout/stderr, and sends the result back as the next
chat message. The model keeps working until the project is built, tested, and
finished.

```text
┌─────────────────────────┐
│  Chromium: AI chat tab  │
│  built-in or custom     │
└────────────┬────────────┘
             │ fenced bridge command
             ▼
┌─────────────────────────┐        token + CORS        ┌──────────────────────┐
│  PC Bridge extension    │ ─────────────────────────► │  127.0.0.1:8787      │
│  content script + UI    │ ◄───────────────────────── │  Node.js server      │
└────────────┬────────────┘        JSON result         └──────────┬───────────┘
             │                                                    │
             └──────── result posted into chat ──────────  PowerShell / files
```

**No cloud relay. No account. No open port.** Everything stays on your machine.

## Why PC Bridge

Chats can write code. They cannot install it, run it, read the error, and fix it.
PC Bridge gives the model hands on the machine that actually does the work:

- **It finishes the job.** Installs dependencies, runs builds, reads compiler
  errors, patches them, and keeps going until the app runs.
- **Your files stay yours.** Projects are written to your disk. No cloud
  sandbox, no file upload, no hosted workspace.
- **Nothing is exposed.** The server listens on loopback only, requires a random
  token, and accepts only built-in chat origins plus the custom sites you approve.
- **You keep the keys.** Approve each batch, pause everything with one click, or
  point the bridge at a different project folder at any time.
- **Tiny and auditable.** One Node.js file with zero runtime dependencies, one
  readable Manifest V3 extension, and a local dashboard.

## Features

- **Real local execution** — PowerShell commands, npm/npx, git, builds, tests.
- **17 tools** — `exec`, `write`, `read`, `edit`, `list`, `mkdir`, `move`,
  `copy`, `remove`, `stat`, `open`, `grep`, `find`, `hash`, `download`, `fetch`,
  and `system`.
- **Any AI chat site** — DeepSeek, ChatGPT, Claude, Gemini, and Grok work out of
  the box. Add any other `http(s)` chat site from the dashboard or the extension
  options page, then grant browser access to that site once.
- **Faster, smoother loop** — a DOM-change watcher reacts as soon as an answer
  settles, and the AI can run up to 8 independent operations per reply.
- **Clearer failures** — tool errors include the exact path or reason, and the
  bridge stops with an actionable notice on token, offline, or repeated failures.
- **Optional full-PC file access** — unlock the file tools outside the workspace
  from the dashboard with a typed confirmation. Off by default.
- **Automatic loop** — results are posted back to the chat without copy/paste.
- **Changeable project location** — choose any folder from the dashboard or panel.
- **Approval mode** — optionally approve every command before it runs.
- **Pause switch** — stop AI access instantly from the panel or dashboard.
- **Command log** — full output stored under the workspace for inspection.
- **Zero dependencies** — the server uses only Node.js built-ins.

## Supported chat sites

| Site | Status | Notes |
| --- | --- | --- |
| [DeepSeek](https://chat.deepseek.com) | Primary, tested | `.ds-markdown`, `textarea` |
| [ChatGPT](https://chatgpt.com) | Best effort | auto |
| [Claude](https://claude.ai) | Best effort | auto |
| [Gemini](https://gemini.google.com) | Best effort | auto |
| [Grok](https://grok.com) | Best effort | auto |
| Any other `http(s)` chat site | Custom | Add it in the dashboard or options page, then grant access once |

Site redesigns can break UI automation. Use **Advanced → selectors** in the
panel, or open an issue with the new selectors. Custom sites use a generic DOM
adapter first; manual selectors are available when a site needs them.

## Any AI chat site

There are three equivalent ways to add a site:

1. **Dashboard → AI platforms** — type the site address, click **Add site**.
2. **Extension options → AI sites** — click **Add & grant access**.
3. **Toolbar icon on the site** — click the PC Bridge icon once. It grants
   access for that origin and adds the site to both lists automatically.

The server stores only the exact origin (for example `https://chat.example.com`,
never a path or query string). Up to 50 custom sites can be configured. Removing
a site from the server list does not remove the browser permission; revoke that
separately in the extension options page.

Browser access is intentionally separate from the server list:

- The dashboard tells the server which origins may send requests.
- Chrome's optional site permission lets the extension read and type into that
  page.
- You approve each site once. Nothing is granted globally, and built-in sites
  need no extra prompt.

## Requirements

- Windows 10 or 11
- A Chromium browser: Chrome, Edge, Brave, Opera, or Vivaldi
- [Node.js](https://nodejs.org/) **20 or newer**
- A logged-in AI chat account — a built-in site or any site you add

## Browser support

The extension is Manifest V3 and loads unpacked in any Chromium browser. The
dashboard itself works in every modern browser.

| Browser | Status |
| --- | --- |
| Google Chrome | ✅ Fully supported and tested |
| Microsoft Edge | ✅ Supported — use `edge://extensions` |
| Brave, Opera, Vivaldi | ✅ Supported — same Chromium engine |
| Firefox | 🚧 On the roadmap — needs a Firefox manifest |
| Safari | ❌ Not supported |

## Quick start

```text
1. Install Node.js 20+ and download this repository.
2. Double-click SETUP.bat.
3. In the extension page: Developer mode → Load unpacked → extension folder.
4. Open a built-in chat, or add your own site in the dashboard and click the
   PC Bridge toolbar icon on it once.
5. Click the bridge bubble, paste the token, Connect.
6. Flip Bridge on and ask for a project.
```

`SETUP.bat` starts the server, opens the correct extension page for Chrome or
Edge, and opens the `extension` folder for you. After the first run, just use
`START-BRIDGE.bat`.

The dashboard opens at **http://127.0.0.1:8787**. The first server start creates
`server/config.json`, `server/token.txt`, and `workspace/`.

> **Read the full [installation manual](docs/INSTALL.md) before your first run.**
> It covers token setup, folder loading, the first verified command, changing
> the project location, updating, and uninstalling.

## First project prompt

```text
Build me a modern React todo app in a folder called todo-app.
Use dark mode, make it responsive, install everything, and run a production
build to verify it works. Do not stop until the build passes.
```

The AI should reply with **BRIDGE READY** after the initial verification, then
start emitting bridge blocks. It can batch up to 8 independent operations per
reply; dependent steps wait for their result.

## Project location

Projects are created in `workspace/` by default. Change it from either place:

- **Dashboard → Project location → Change location**
- **Bridge panel → Project location → Save location**

The folder is created if missing, stored in `server/config.json`, and all file
tools plus command working directories move with it. Existing projects are not
moved. Use **Update this chat** in the panel so an already-open conversation
learns the new path.

## Full PC access (optional)

File tools stay inside the project location by default. If a task genuinely
needs files somewhere else, you can unlock the whole PC from the dashboard:

1. Open **File access**.
2. Click **Enable full PC access**.
3. Type **`FULL PC ACCESS`** and confirm.

While it is on:

- All file tools, including `read`, `write`, `edit`, `list`, `move`, `copy`,
  `remove`, `grep`, `find`, `hash`, and `download`, accept absolute paths
  anywhere your Windows user can reach.
- Relative paths still resolve from the project location.
- Drive roots, your user-profile root, Windows, Program Files, ProgramData, and
  the Bridge app folders are still protected from **delete, move, copy-over,
  and download-overwrite** operations.
- Windows permissions still apply.
- The setting persists in `server/config.json` until you turn it off.

> **This is a real security boundary change.** Shell commands already run as your
> Windows user, but full PC access also removes the file-tool confinement. Enable
> it only for a chat you trust, and click **Return to workspace only** when you
> are done. Re-send the protocol so the AI knows which mode is active.

## Security

PC Bridge is a **power tool**, not a sandbox.

- The server binds to `127.0.0.1` only and requires a 48-character token.
- File tools are confined to the configured workspace **by default**; full PC
  access is an explicit, typed-confirmation opt-in.
- CORS accepts known built-in origins, extension pages, localhost, and only the
  exact custom origins you add (maximum 50).
- Custom sites use Chrome's per-site optional permissions. The extension does
  not receive broad host access at install time, and you can revoke a site at
  any time.
- The token is generated locally and stored in `server/token.txt` (git-ignored).
- Shell commands are screened for a small set of catastrophic patterns, but the
  AI still runs with **your Windows permissions**.
- Use **Auto-run off** to approve each batch, and **Pause AI access** as a kill
  switch.
- Treat AI output as untrusted. Prompt injection in a webpage, repository, or
  dependency can try to turn a trusted chat into an attacker.

**Never expose port 8787 to the internet and never commit `server/token.txt`.**
Full PC access is covered in [SECURITY.md](SECURITY.md) and the
[installation manual](docs/INSTALL.md).

## Repository layout

```text
pc-bridge/
├── SETUP.bat                 # first-run: server + extension page + folder
├── START-BRIDGE.bat          # start the local server
├── INSTALL-EXTENSION.bat     # open chrome://extensions + extension folder
├── extension/                # load this folder as an unpacked extension
│   ├── manifest.json
│   ├── background.js         # API proxy + per-site grants and injection
│   ├── content.js            # chat watcher + execution loop
│   ├── adapters.js           # built-in and generic/custom DOM adapters
│   ├── shared.js             # protocol parser, tool catalog, prime message
│   ├── ui.js                 # in-page control panel
│   └── options.html/.css/.js # extension settings + custom-site access
├── server/
│   ├── server.js             # HTTP API, tools, platform allowlist, safety checks
│   ├── config.example.json   # documented defaults
│   └── public/               # local dashboard
├── dev/                      # mock chat page for offline testing
├── docs/                     # install, architecture, protocol, help
├── scripts/                  # repository maintenance scripts
└── tests/                    # dependency-free smoke tests
```

Runtime-only files (`server/config.json`, `server/token.txt`, `logs/`,
`workspace/`) are deliberately git-ignored.

## Development

```powershell
npm run check     # syntax-check every JavaScript file
npm test          # start an isolated server and exercise the API
npm run dev       # start the server without opening a browser
```

Mock-chat mode (no AI account needed):

```powershell
$env:PC_BRIDGE_DEV = "1"
$env:PC_BRIDGE_PORT = "8788"
npm run dev
# open http://127.0.0.1:8788/mock
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture notes and pull-request
guidelines.

## Troubleshooting

The short version: restart `START-BRIDGE.bat`, click **Connect**, then
**Re-send protocol**. For a custom site that shows no panel, add it in the
dashboard, grant access in the extension options page, reload the tab, and
click the PC Bridge toolbar icon. For everything else, see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Star the project

If PC Bridge saves you an evening of copy-pasting, a ⭐ helps other people find
it. That is the whole marketing budget.

## Disclaimer

PC Bridge is an independent project, not affiliated with DeepSeek, OpenAI,
Anthropic, Google, or xAI. Automating a website may be subject to that site's
terms of service. Use your own account, your own machine, and your own
judgement. You are responsible for commands you allow the AI to run.

## License

[MIT](LICENSE) © 2026 PC Bridge contributors
