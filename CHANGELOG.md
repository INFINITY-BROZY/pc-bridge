# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.0] — 2026-10-26

### Added

- **Dashboard AI platforms card.** Add, list, open, and remove custom chat
  sites. Custom sites are stored as exact `http(s)` origins in
  `config.customPlatforms` (up to 50) and persisted across restarts.
- `GET/POST /api/platforms` with `add`, `remove`, and `clear` actions, origin
  validation, duplicate/built-in detection, and dynamic CORS approval for
  custom origins.
- **Extension options page** with server/token testing, the full site list,
  per-site access status, and grant/revoke controls.
- **Any-site support.** A toolbar click on an unlisted chat site requests
  access for that origin, adds it to the server list, registers a dynamic
  content script, and shows the panel. A generic DOM adapter plus manual
  selector overrides handle custom site layouts.
- Eight new server tools: `edit`, `grep`, `find`, `copy`, `hash`, `download`,
  `fetch`, and `system` (17 tools total).
- Substantial upgrades to existing tools: append mode and 8 MB guard for
  `write`; line ranges, byte caps, and binary detection for `read`; recursive
  depth/limit controls for `list`; overwrite/type/self-nesting guards for
  `move`; symlink and timestamp detail for `stat`.
- **Batched operations.** Up to 8 independent bridge blocks in one AI reply are
  executed in order, with all results returned together.
- Adaptive `MutationObserver` watching, faster settling/polling, and an
  assistant-result cache for quicker reactions and less DOM churn.
- Richer result formatting (HTTP status, path, truncation, duration) and
  clearer stop conditions for token, offline, and repeated failures.
- Expanded dependency-free smoke coverage for platforms, custom CORS, all new
  tools, file guards, fetch/download limits, system info, workspace changes,
  full PC access, and pause.

### Changed

- Manifest is now `1.3.0` and adds `scripting` plus optional `http(s)` host
  permissions. Built-in sites still load through static content scripts.
- Prime message documents the full 17-tool catalog, batching, and current file
  access mode.
- Dashboard subtitle, setup steps, and platform guidance no longer assume
  Chrome-only or DeepSeek-only use.
- README, protocol, architecture, install, troubleshooting, and security docs
  describe custom sites, the new tools, and batching.

### Fixed

- Built-in chat sites no longer trigger unnecessary per-site permission
  prompts or injection failures.
- The options page marks built-in sites as ready and shows custom access as
  allowed or needing access.
- A failed “add site” now rolls back browser access when the server rejects the
  origin.
- Options saves merge with existing storage, so tokens and custom sites are not
  lost when saving settings from different tabs.
- Open chat tabs apply settings changes live, including server/token changes.
- `download` refuses to overwrite a folder destination.
- `copy`, `move`, `remove`, `read`, `edit`, `grep`, `find`, `hash`, and
  `download` now fail with specific messages for missing, binary, oversized,
  ambiguous, or unsafe inputs.

### Security

- Custom origins are accepted only after explicit addition and exact-origin
  validation; no wildcard remote origin is added to CORS.
- Browser access remains opt-in per site through Chrome's optional host
  permissions. Revoking access unregisters the dynamic content script.
- The localhost-only server, token authentication, workspace confinement, and
  optional full-PC access model are unchanged.

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
