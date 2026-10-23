# Changelog

All notable changes to open-eyes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-23

### Added

- **Use your everyday browser.** `open-eyes connect` attaches to the browser you already
  use, with your logins, once remote debugging is enabled at
  `chrome://inspect/#remote-debugging` (Chrome 144+, Chromium, Brave, Edge). A background
  daemon holds the single connection you approve, so the browser asks only once.
  `open-eyes disconnect` closes the agent window and stops it.
- **Guardrails against prompt injection.** `open-eyes policy` sets which sites the agent
  may use (allow and block lists). Risky actions (buying, sending, deleting, publishing,
  submitting a form with Enter, typing a password) wait for your Allow / Deny in the
  agent window; only real clicks answer. `open-eyes log` shows an audit log of every
  action, never the text typed.
- Releases are published automatically from version tags, with the package, a checksum
  and a signed build provenance attestation.

### Fixed

- `status` no longer opens an agent window when there is none.
- The connected browser is named correctly: Chromium-based browsers report themselves as
  "Chrome".

## [0.2.0] - 2026-10-23

### Added

- **Take control.** The agent window has a "Take control" button that pauses the agent
  and a "Hand back to agent" button that returns control. Agent actions fail with a
  clear message while the user is in control. Only real user clicks change control.
- `open-eyes handoff <message>` asks the user for help (a login, a captcha) and waits
  until they hand control back, even if they navigate meanwhile. `open-eyes wait` waits
  after the user took control on their own. `status` shows who is in control.
- **Cheaper snapshots.** Elements keep their `@N` ref while the page stays loaded.
  `snapshot --diff` shows only what changed, `--find <text>` only matching lines,
  `--scope @N` one element, and long snapshots are paged (400 lines by default,
  `--limit`, `--page`).
- `click`, `fill` and `press` report the changes they caused, after the DOM settles.
- `launch --headless` for CI and background work.
- Unit, property-based (fast-check) and end-to-end tests, run in CI on Node 22 and 24.

### Changed

- The project follows git flow: `develop` is the default branch, `main` only receives
  release and hotfix branches.

### Fixed

- `launch` waits up to 30 s for a cold browser start instead of 10 s.
- A missing browser binary is reported instead of crashing.

### Security

- The local state file and `OPEN_EYES_PORT` are validated instead of trusted, and
  open-eyes only connects to a DevTools endpoint on the loopback interface.

## [0.1.0] - 2026-10-23

### Added

- First MVP: a CLI that drives a visible Chromium over the Chrome DevTools Protocol,
  with accessibility snapshots and `@N` refs, `click`, `fill`, `press`, `screenshot`,
  `eval`, multi-step `run` scripts, a live overlay showing each action, and an agent
  skill.

[Unreleased]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SchlaftGut0-1/open-eyes/compare/2bbe51e...v0.2.0
[0.1.0]: https://github.com/SchlaftGut0-1/open-eyes/commit/2bbe51e
