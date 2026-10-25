# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] — 2026-10-25

### Added

- Dashboard **File access** card with a typed-confirmation switch for full PC
  file access.
- `POST /api/access` to persist the mode; enabling requires typing
  `FULL PC ACCESS`, disabling is immediate.
- Absolute paths, `%ENV%` variables, and `~` are accepted by file tools while
  full access is on.
- Persistent red dashboard banner, status-pill state, and extension-panel
  warning while the mode is active.
- The prime message tells the AI which file-access mode is active.
- Delete/move guards for drive roots, the user-profile root, Windows, Program
  Files, ProgramData, and Bridge application folders.
- Smoke coverage for confirmation, enabling, outside-workspace reads/writes,
  guarded moves/removes, disabling, and restored confinement.

### Changed

- `ping` and `log` report `fullPcAccess` and `fileAccess`.
- Server startup banner shows the active file-access mode and warns when full
  access is on.
- `config.example.json` documents `fullPcAccess` (default `false`).
- README, installation manual, security policy, architecture, protocol, and
  troubleshooting guides describe the new mode.

### Fixed

- Path containment now handles folder names that begin with `..` (such as
  `..notes`) correctly while still rejecting real `..` escapes.

### Security

- Full PC access is off by default, cannot be toggled by the AI, and is
  persisted locally in `server/config.json`.

## [1.1.0] — 2026-10-25

### Added

- Change the project location from the dashboard or the bridge panel.
- `POST /api/workspace`: validate, create, probe, persist, and activate a new
  workspace at runtime.
- Workspace guardrails: drive roots, Windows/Program Files, Bridge app folders,
  and ancestor folders are rejected.
- One-click `SETUP.bat` that starts the server and opens the right extension
  page for Chrome or Edge.
- Documented support for Chrome, Edge, Brave, Opera, and Vivaldi.
- Detailed installation manual, architecture guide, protocol reference,
  troubleshooting guide, security policy, and contribution guide.
- Dependency-free smoke tests and GitHub Actions CI.
- Mock-chat development mode documented in one place.

### Changed

- Dashboard workspace card is now **Project location** with an inline editor.
- Extension panel includes workspace save + “Update this chat”.
- Server no longer prints the token in its console banner.
- Runtime files are explicitly git-ignored; `config.example.json` is committed.

### Fixed

- Workspace headers, diagnostics, and the AI prime message always use the active
  workspace after a change.
- Command working directories and file tools follow the new workspace
  immediately.

## [1.0.2] — 2026-10-25

### Fixed

- Bridge power state survives page reloads.
- Bare JSON bridge blocks are accepted when the chat UI strips code fences.

## [1.0.1] — 2026-10-25

### Fixed

- Reconstructed missing code fences in DeepSeek answers.
- Removed the temporary injection probe.

## [1.0.0] — 2026-10-25

### Added

- Initial local server, dashboard, Manifest V3 extension, protocol, token auth,
  workspace confinement, command screening, activity log, and Windows launchers.
- Verified end-to-end builds of a React todo app and a Snake game.
