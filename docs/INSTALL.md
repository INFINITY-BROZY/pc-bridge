# Installation manual

This is the complete setup guide for **PC Bridge** on Windows. Read it once
before running anything. The short version is in the main [README](../README.md).

---

## 0. Before you start

### You need

| Requirement | Notes |
| --- | --- |
| Windows 10 or 11 | Windows 11 is recommended. |
| Google Chrome, Microsoft Edge, Brave, Opera, or Vivaldi | All Chromium and support unpacked extensions. |
| Node.js 20+ | Download the LTS installer from [nodejs.org](https://nodejs.org/). |
| An AI chat account | DeepSeek is the primary, tested target. |
| A folder for projects | `workspace/` is used until you change it. |

Verify Node in PowerShell:

```powershell
node -v
npm -v
```

You should see `v20.x` or newer and an npm version. If the window says
`node is not recognized`, install Node and reopen PowerShell.

### Security warning

PC Bridge runs commands as **your Windows user**. The file tools are confined to
the workspace, but `exec` is **not a sandbox**. Do not run it on a shared PC,
do not expose it to the internet, and do not share your token. Read
[SECURITY.md](../SECURITY.md) before use.

---

## 1. Get the files

### Option A — Git (recommended)

```powershell
cd "$env:USERPROFILE\Desktop"
git clone https://github.com/INFINITY-BROZY/pc-bridge.git
cd pc-bridge
```

### Option B — Download ZIP

1. Open the repository page on GitHub.
2. Click **Code → Download ZIP**.
3. Extract it so the folder looks like this:

```text
pc-bridge\
├── SETUP.bat
├── START-BRIDGE.bat
├── INSTALL-EXTENSION.bat
├── extension\
├── server\
└── ...
```

Do **not** extract only `server\` or only `extension\`; both are required.

---

## 2. Start the server

> **Fast path:** double-click **`SETUP.bat`** once. It starts the server, opens
> the correct extensions page for Chrome or Edge, and opens the `extension`
> folder. Then jump to step 3.

Otherwise, double-click **`START-BRIDGE.bat`**.

A console window opens and says `PC BRIDGE v1.1.0 - local server`. Your browser
opens the dashboard at:

**http://127.0.0.1:8787**

Keep this window open. Closing it stops the bridge. If the window flashes and
closes, run the batch file from PowerShell to see the error:

```powershell
.\START-BRIDGE.bat
```

### What the first run creates

| File / folder | Purpose |
| --- | --- |
| `server\config.json` | Port, workspace, timeouts, safety settings. |
| `server\token.txt` | Random 48-character access token. **Keep secret.** |
| `workspace\` | Default project folder. |
| `workspace\.bridge\` | Full command output logs. |
| `logs\activity.jsonl` | Activity history used by the dashboard. |

These runtime files are git-ignored. They are never uploaded to GitHub.

### Change the port (optional)

If port `8787` is already in use:

1. Stop the server with `Ctrl+C`.
2. Edit `server\config.json` and change `"port": 8787` to another port, e.g.
   `8788`.
3. Restart `START-BRIDGE.bat`.
4. In the extension panel, change the server URL to
   `http://127.0.0.1:8788` and click **Connect**.

---

## 3. Load the browser extension

Double-click **`INSTALL-EXTENSION.bat`**. It opens:

- `chrome://extensions`
- the `extension\` folder in File Explorer

Then:

1. Turn on **Developer mode** (top-right corner).
2. Click **Load unpacked**.
3. Select the **`extension`** folder inside `pc-bridge`.
4. Confirm that **PC Bridge — AI chat builds on your PC** appears in the list.
5. Pin the extension if you want quick access.

> Chrome does not allow unpacked extensions from the Web Store flow. Developer
> mode is expected and safe for a locally built extension.

### Edge, Brave, Opera, and Vivaldi

Open the browser's extension page, enable **Developer mode**, and use
**Load unpacked** the same way:

| Browser | Extension page |
| --- | --- |
| Edge | `edge://extensions` |
| Brave | `brave://extensions` |
| Opera | `opera://extensions` |
| Vivaldi | `vivaldi://extensions` |

Firefox and Safari are not supported yet.

---

## 4. Connect the extension

1. Open your AI chat and log in:
   - [chat.deepseek.com](https://chat.deepseek.com) (recommended)
   - [chatgpt.com](https://chatgpt.com)
   - [claude.ai](https://claude.ai)
   - [gemini.google.com](https://gemini.google.com)
   - [grok.com](https://grok.com)
2. Click the round **PC Bridge bubble** in the bottom-right corner.
3. In the dashboard, click **Reveal → Copy token** under **Access token**.
   Alternatively read `server\token.txt`.
4. Paste the token into the panel's **Token** field.
5. Keep the server field as `http://127.0.0.1:8787` unless you changed the port.
6. Click **Connect**.
7. Flip **Bridge on**.

The panel should show **connected · Windows** and **Bridge on**.

### First verification

When the bridge turns on, it sends a protocol message to the AI. The AI should
run a harmless check and answer:

```text
BRIDGE READY
```

If it does, the full loop works. If not, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## 5. Build your first project

Ask for something concrete:

```text
Build me a modern React todo app in a folder called todo-app.
Use dark mode, make it responsive, install dependencies, and run a production
build to verify it works. Do not stop until the build passes.
```

What you should see:

- The AI replies with one `bridge` command at a time.
- The panel logs each command and file write.
- `[PC BRIDGE RESULT #n]` messages appear in the chat automatically.
- Files appear under `workspace\todo-app`.
- The AI finishes with a `done` block and a run command.

Open the workspace from the dashboard with **Open folder**.

---

## 6. Change the project location

### From the dashboard

1. Open **http://127.0.0.1:8787**.
2. Find **Project location**.
3. Click **Change location**.
4. Enter an absolute path, for example:

   ```text
   C:\Users\YourName\Projects
   ```

5. Click **Save location**.

### From the extension panel

1. Open the bridge panel.
2. Find **Project location**.
3. Enter the new path.
4. Click **Save location**.
5. If a chat is already open, click **Update this chat** so the AI learns the
   new path.

The server will:

- create the folder if needed,
- verify it is writable,
- save it to `server\config.json`,
- move all file tools and command working directories to it.

Existing projects are not moved. Paths that point at a drive root, Windows,
Program Files, or the Bridge application folders are rejected for safety.

---

## 7. Recommended settings

| Setting | Recommendation |
| --- | --- |
| **Auto-run commands** | On for trusted personal projects. Off when exploring an unfamiliar model or repo. |
| **Auto-send results** | On for a hands-free loop. Off if you want to review each result. |
| **Auto-start in new chats** | On for convenience. The extension will send the protocol in a fresh chat. |
| **Bridge on/off** | Turn off when you are not using it. |
| **Pause AI access** | Dashboard kill switch; blocks all tools immediately. |

---

## 8. Updating

```powershell
cd "$env:USERPROFILE\Desktop\pc-bridge"
git pull
```

Then:

1. Stop the server (`Ctrl+C`) and run `START-BRIDGE.bat` again.
2. Open `chrome://extensions` and click **Reload** on PC Bridge.
3. Refresh the AI chat tab.

Your `server\config.json`, token, workspace, and projects are left untouched.

For a ZIP install, download and extract the new version over the old folder,
but keep your runtime files (`server\config.json`, `server\token.txt`, and
`workspace\`).

---

## 9. Uninstall

1. Remove the extension from `chrome://extensions`.
2. Close the server console window.
3. Move any projects you want to keep out of `workspace\`.
4. Delete the `pc-bridge` folder.
5. Optionally delete `logs\` and the workspace you selected.

There is no installer, service, or registry entry to remove.

---

## 10. Manual fallback

If double-clicking `.bat` files is blocked by policy, run the server directly:

```powershell
cd "$env:USERPROFILE\Desktop\pc-bridge"
node server\server.js --open
```

Load the extension from `chrome://extensions` → **Load unpacked** →
`pc-bridge\extension`.

If the port is busy:

```powershell
$env:PC_BRIDGE_PORT = "8788"
node server\server.js --open
```

---

## 11. Checklist

- [ ] Node 20+ installed (`node -v`)
- [ ] `START-BRIDGE.bat` running with no errors
- [ ] Dashboard opens at `127.0.0.1:8787`
- [ ] Extension loaded and enabled
- [ ] Token pasted, **Connect** succeeds
- [ ] **Bridge on**
- [ ] AI answers **BRIDGE READY**
- [ ] Workspace chosen and writable
- [ ] Token is **not** shared, committed, or posted online
