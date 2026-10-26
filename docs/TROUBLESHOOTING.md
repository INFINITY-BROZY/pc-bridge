# Troubleshooting

Start here before opening an issue. Most problems are one of: server not
running, wrong token, extension not reloaded, or the AI not seeing the protocol.

---

## The panel does not appear

- Reload the chat tab.
- Check `chrome://extensions` and confirm PC Bridge is **enabled**.
- Confirm the URL is supported: `chat.deepseek.com`, `chatgpt.com`,
  `chat.openai.com`, `claude.ai`, `gemini.google.com`, or `grok.com`.
- For any other site, use the custom-site steps below.
- If you just updated the files, click **Reload** on the extension card, then
  refresh the chat tab.
- If the site has strict CSP, the panel should still render in a shadow root.
  Check the DevTools console for errors starting with `PC Bridge`.

## The panel does not appear on a custom site

1. Add the site in **Dashboard → AI platforms** or in the extension
   **Options → AI sites**.
2. Open the extension options page and find the site. It should say **allowed**.
   If it says **needs access**, click **Grant access** and approve the prompt.
3. Reload the chat tab.
4. Click the **PC Bridge toolbar icon** once. This both grants access and
   injects the panel into the current tab.
5. If the panel still does not appear, open DevTools → Console and look for
   messages starting with `PC Bridge`.

Chrome only grants access per origin, and it remembers a denial. Granting from
the options page is the most reliable way to recover.

Custom-site automation works on normal `http(s)` pages. It does not work on
`chrome://` pages, the Chrome Web Store, the PDF viewer, `file://` pages, or
sites that render the chat inside a cross-origin iframe.

## A custom site is listed but every request fails

- The server stores an exact origin. `https://chat.example.com` and
  `https://www.chat.example.com` are different sites, and `http` is not `https`.
- Re-add the exact address shown in the browser's address bar.
- Confirm the extension options page says **connected** with the same server and
  token used by the dashboard.
- If the dashboard refuses to add the site, the address is invalid, already
  built in, or the 50-site limit was reached.
- Removing a site from the dashboard does not revoke browser access. Use
  **Revoke** in the options page as well.

## "Access was rolled back" when adding a site

The browser grant succeeded, but the local server rejected the add request. The
extension removes the browser permission so the two lists do not drift.

1. Confirm `START-BRIDGE.bat` is running.
2. Save and test the token in the extension options page.
3. Add the site again.

If the site is already in the server list but registration failed, the message
says so; click **Grant access** to retry without adding it twice.

## A custom site needs manual selectors

1. Open the panel → **Advanced → selectors**.
2. Set **Answer**, **Composer**, and **Send** selectors for the site.
3. Click **Test finders** and check the Activity output.
4. Save. The overrides apply immediately and persist in extension storage.

If the site changes its markup later, repeat this check.

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

The AI may batch up to 8 independent operations per reply. If it sends a later
step before the earlier result arrives, tell it to use one batch only for
independent work and wait for dependent results.

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

- Confirm the file tool reported success and the path is workspace-relative
  (or a correct absolute path when full PC access is on).
- Click **Open folder** to see the actual workspace.
- If you changed the project location mid-chat, click **Update this chat** (or
  start a new chat). The old conversation still has the old path in its protocol.
- Absolute paths outside the current workspace are rejected with `403` unless
  full PC access is on.

## The AI cannot access a file outside the workspace

This is the default and expected behavior. File tools are confined to the
project location.

If the task genuinely needs another folder:

1. Open **http://127.0.0.1:8787**.
2. Find the **File access** card.
3. Click **Enable full PC access**, type **`FULL PC ACCESS`**, and confirm.
4. Click **Re-send protocol** in the bridge panel. An open chat still has the old
   rules in its context and may keep refusing to use absolute paths.
5. Ask again with the exact path.

If it still fails:

- The server console and activity log show the real error.
- `Path is outside the workspace` means the mode is still off (or the server was
  restarted with an old config).
- `EPERM` / `EACCES` means Windows permissions, not PC Bridge.
- `Refusing to remove ...` / `Refusing to move ...` is the destructive-target
  guard. Those system locations are blocked on purpose.
- `Destination already exists` means the operation must pass `overwrite: true`
  or choose a new path.
- `oldText appears N times` means the edit was ambiguous. Add surrounding
  context or set `replaceAll`.
- `oldText was not found` means the file changed. Read it again and copy the
  exact text.

Turn it back off with **Return to workspace only** as soon as the task is done.

## I enabled full PC access but the AI still says it cannot leave the workspace

The server is already in full mode only if the dashboard banner is visible and
`ping` reports it. The AI learns the mode from the prime message.

1. Confirm the red **FULL PC ACCESS** banner is shown in the dashboard.
2. Click **Re-send protocol** in the bridge panel.
3. If the chat still insists, start a new chat and enable the bridge again.
4. Do not paste a fake "full access granted" instruction; the server enforces
   the mode regardless of what the chat says.

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
3. Start the server again. A new token and config are generated. Full PC access
   returns to off and the custom-site list is empty because both live in
   `config.json`.
4. Paste the new token into the panel.
5. Re-add any custom sites and grant browser access again. Browser permissions
   survive a server reset, but the server no longer knows the origins until you
   add them.

This does not remove projects you moved elsewhere.

---

Still stuck? Open an issue with:

- Windows version and Chrome version,
- the bridge version from the panel,
- the exact error text,
- the relevant lines from the server console,
- **no token and no private file contents**.
