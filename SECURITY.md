# Security policy

## The short version

PC Bridge is a local power tool. It is designed for **one trusted person on one
trusted Windows machine**. It is not a sandbox, a multi-user service, or a way to
expose a computer to the internet.

- The server listens on `127.0.0.1` only.
- Every API call requires the local token.
- File tools are confined to the configured workspace.
- Shell commands run with the full permissions of your Windows account.
- Never commit `server/token.txt`, `server/config.json`, or logs.
- Never port-forward or reverse-proxy port 8787.

## Threat model

### Protected against

| Threat | Mitigation |
| --- | --- |
| Random websites calling the API | Localhost bind, CORS allowlist, token required. |
| Another user on the network | No network listener; loopback only. |
| File tools escaping into personal files | `resolveInside()` rejects `..` and outside absolute paths. |
| Accidental workspace selection of system folders | Drive roots, Windows, Program Files, and app folders are rejected. |
| Token leaked in a public repository | Runtime token is git-ignored; `config.json` is git-ignored. |
| Accidental destructive command | Denylist for formatting drives, deleting backups/hives, etc. |
| Runaway command | Timeout and process-tree kill. |
| AI acting without approval | Auto-run can be disabled; dashboard pause stops all tools. |

### Not protected against

- **A malicious or confused model.** It can still run arbitrary non-denylisted
  commands, read personal files through `exec`, install software, or delete
  project files.
- **Prompt injection.** Text from a webpage, repository, dependency, compiler,
  or command output can try to instruct the model. Result markers reduce but do
  not eliminate this.
- **A compromised browser profile or extension.** Malware with access to your
  Chrome profile or token can call the API.
- **Symlinks/junctions.** Path confinement does not canonicalize links placed
  inside the workspace.
- **Other local users or processes.** The token file is protected by filesystem
  permissions, but a process running as your user can read it.
- **Site terms violations or rate limits.** UI automation may be restricted.

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
attacker escape the workspace, steal tokens, or execute code without approval.

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
- [ ] Port 8787 is not exposed through a tunnel, proxy, or firewall rule.
- [ ] Dashboard is closed when not needed.
- [ ] Server is stopped when not in use.
