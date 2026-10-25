# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
