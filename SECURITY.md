# Security policy

## The short version

PC Bridge is a local power tool. It is designed for **one trusted person on one
trusted Windows machine**. It is not a sandbox, a multi-user service, or a way to
expose a computer to the internet.

- The server listens on `127.0.0.1` only.
- Every API call requires the local token.
- CORS accepts built-in chat origins, extension pages, localhost, and only the
  exact custom origins you add (maximum 50).
- Browser access to a custom site is a separate per-origin grant. Nothing is
  granted globally at install time.
- File tools are confined to the configured workspace **by default**.
- Full PC file access is an explicit opt-in that requires typing a confirmation
  phrase in the dashboard.
- Shell commands run with the full permissions of your Windows account.
- Never commit `server/token.txt`, `server/config.json`, or logs.
- Never port-forward or reverse-proxy port 8787.

## Threat model

### Protected against

| Threat | Mitigation |
| --- | --- |
| Random websites calling the API | Localhost bind, exact-origin CORS allowlist, token required. |
| An unapproved chat site reading the page or calling the API | Extension host access is opt-in per origin; the server accepts only approved custom origins. |
| Another user on the network | No network listener; loopback only. |
| File tools escaping into personal files | By default `resolveInside()` rejects `..` and outside absolute paths. |
| Accidental full-PC enablement | Off by default; typed confirmation; persistent dashboard banner; delete/move guards for OS roots. |
| Accidental workspace selection of system folders | Drive roots, Windows, Program Files, and app folders are rejected. |
| Token leaked in a public repository | Runtime token is git-ignored; `config.json` is git-ignored. |
| Accidental destructive command | Denylist for formatting drives, deleting backups/hives, etc. |
| Runaway command | Timeout and process-tree kill. |
| AI acting without approval | Auto-run can be disabled; dashboard pause stops all tools. |

### Not protected against

- **A malicious or confused model.** It can still run arbitrary non-denylisted
  commands, read personal files through `exec`, install software, or delete
  project files.
- **Full PC access mode.** When enabled, file tools can read and write anywhere
  your Windows user can. The workspace boundary is gone; only OS permissions and
  the delete/move guards remain.
- **Prompt injection.** Text from a webpage, repository, dependency, compiler,
  or command output can try to instruct the model. Result markers reduce but do
  not eliminate this.
- **A compromised browser profile or extension.** Malware with access to your
  Chrome profile or token can call the API.
- **A malicious site you approve.** If you grant browser access to a site and add
  it to the server, its page can interact with the bridge like any supported
  chat. Only approve sites you trust.
- **Symlinks/junctions.** Path confinement does not canonicalize links placed
  inside the workspace.
- **Other local users or processes.** The token file is protected by filesystem
  permissions, but a process running as your user can read it.
- **Site terms violations or rate limits.** UI automation may be restricted.

## Full PC access mode

`POST /api/access` can disable workspace confinement for the file tools. It is
disabled by default and requires the exact confirmation string `FULL PC ACCESS`.

When enabled:

- All file tools (`read`, `write`, `edit`, `list`, `mkdir`, `move`, `copy`,
  `remove`, `stat`, `open`, `grep`, `find`, `hash`, and `download`) accept
  absolute paths anywhere the Windows user can reach.
- Relative paths still resolve from the workspace.
- Drive roots, the user-profile root, Windows, Program Files, ProgramData, and
  the Bridge application folders are refused for **delete, move, copy-over, and
  download-overwrite** operations.
- Writes still obey Windows ACLs, but the workspace boundary no longer applies.
- The setting is persisted in `server/config.json` across restarts.

The AI cannot enable this mode by emitting a bridge block; only the local
dashboard can call `/api/access`. The extension panel shows a red warning while
the mode is on. Turn it off with **Return to workspace only** and re-send the
protocol.

## Token handling

The token is generated on first run with 24 random bytes (48 hex characters) and
stored at `server/token.txt`. It is also stored in Chrome extension storage.

- Do not share it, screenshot it, or paste it into a chat.
- Do not commit it. It is in `.gitignore`.
- Rotate it by stopping the server, deleting `server/token.txt`, starting the
  server, and pasting the new token into the panel.
- If you believe it leaked, rotate it immediately.

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability that could let an
attacker escape the workspace, enable full PC access, steal tokens, or execute
code without approval.

Use GitHub's **Security → Advisories → Report a vulnerability** flow on the
repository. Include:

- affected version,
- steps to reproduce,
- impact,
- whether the server was running and the bridge enabled,
- any relevant logs with secrets removed.

You can expect an acknowledgement within a few days. This is a community project
without a bug bounty.

## Hardening checklist

- [ ] Windows account is not shared.
- [ ] Chrome is up to date.
- [ ] Token is not in screenshots, issues, or commits.
- [ ] Auto-run is off for unfamiliar models/repositories.
- [ ] Workspace points at a dedicated projects folder.
- [ ] Full PC access is off unless actively needed.
- [ ] Only chat sites you trust have custom-site browser access.
- [ ] Port 8787 is not exposed through a tunnel, proxy, or firewall rule.
- [ ] Dashboard is closed when not needed.
- [ ] Server is stopped when not in use.
