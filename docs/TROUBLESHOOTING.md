# Troubleshooting

Start here before opening an issue. Most problems are one of: server not
running, wrong token, extension not reloaded, or the AI not seeing the protocol.

---

## The panel does not appear

- Reload the chat tab.
- Check `chrome://extensions` and confirm PC Bridge is **enabled**.
- Confirm the URL is supported: `chat.deepseek.com`, `chatgpt.com`,
  `chat.openai.com`, `claude.ai`, `gemini.google.com`, or `grok.com`.
- If you just updated the files, click **Reload** on the extension card, then
  refresh the chat tab.
- If the site has strict CSP, the panel should still render in a shadow root.
  Check the DevTools console for errors starting with `PC Bridge`.

## The dashboard does not open or shows "offline"

- Is the black `START-BRIDGE.bat` window still open?
- Open `http://127.0.0.1:8787` manually.
- If the port is busy, change `"port"` in `server\config.json`, restart, and
  update the server field in the panel.
- Start the batch file from PowerShell to see the error:

```powershell
.\START-BRIDGE.bat
```

## "Token rejected"

- Copy the token again from the dashboard: **Reveal → Copy token**.
- If `server\token.txt` was regenerated or replaced, paste the new one.
- Tokens are case-sensitive and 48 hex characters.
- Never paste your token into an AI chat or a GitHub issue.

## Connected, but the AI just talks

The AI is not emitting a `bridge` block.

1. Click **Re-send protocol** in the panel.
2. Wait for **BRIDGE READY**.
3. If it still refuses, start a **new chat** and turn the bridge on again.
4. Ask explicitly: “Use the PC Bridge protocol and run `node -v`.”

## "Found a bridge block but could not read its JSON"

The site or model mangled the fence.

- Click **Copy raw** in the notice and inspect it.
- Ask the AI to resend the operation as a single valid JSON object.
- The parser tolerates smart quotes and trailing commas but not truncated JSON.

## The chat box has text in it / could not send

PC Bridge never overwrites a draft. Clear your typed message, then click
**Retry send** or **Retry**. Results can also be copied with **Copy result**.

## It used to work; now it finds nothing

A site update probably changed the DOM.

1. Open **Advanced · selectors**.
2. Click **Test finders**.
3. DeepSeek defaults: answer `.ds-markdown`, composer `textarea`, send
   auto-detect.
4. Update the selectors and save.
5. Open an issue with the site name, date, and the new selector.

## Commands time out

- Default is 180 seconds; max is 900 per command.
- Split long installs/builds into smaller steps.
- The server kills the whole process tree on timeout.
- Check `<workspace>/.bridge/exec-*.log` for full output.

## The AI cannot find a file it just wrote

- Confirm the file tool reported success and the path is workspace-relative.
- Click **Open folder** to see the actual workspace.
- If you changed the project location mid-chat, click **Update this chat** (or
  start a new chat). The old conversation still has the old path in its protocol.
- Absolute paths outside the current workspace are rejected with `403`.

## "That folder is reserved" when changing the project location

Choose a dedicated project folder such as:

```text
C:\Users\YourName\Projects
```

The following are rejected on purpose:

- drive roots (`C:\`, `D:\`),
- `Windows`, `Program Files`, `Program Files (x86)`,
- the Bridge `server`, `extension`, `dev`, and `logs` folders,
- any folder that contains the Bridge app (for example, the Desktop root).

## Node isn't installed

Install the LTS from [nodejs.org](https://nodejs.org/), reopen PowerShell, and
verify:

```powershell
node -v
npm -v
```

## PowerShell blocks the .bat file

Use the manual command:

```powershell
node server\server.js --open
```

If script execution is restricted, that does not affect `node` itself.

## Chrome will not load the extension

- Use **Load unpacked**, not “Load from store”.
- Select the `extension` folder itself, not the repository root.
- The folder must contain `manifest.json`.
- Remove any previous PC Bridge entry before loading a moved copy.

## Antivirus or SmartScreen warning

PC Bridge is an unpacked local extension plus a Node script. It is not signed.
If your policy blocks it, allow the folder or run from a trusted location. Never
disable antivirus globally for this project.

## Resetting everything

1. Stop the server.
2. Delete `server\config.json`, `server\token.txt`, `logs\`, and optionally
   `workspace\`.
3. Start the server again. A new token and config are generated.
4. Paste the new token into the panel.

This does not remove projects you moved elsewhere.

---

Still stuck? Open an issue with:

- Windows version and Chrome version,
- the bridge version from the panel,
- the exact error text,
- the relevant lines from the server console,
- **no token and no private file contents**.
