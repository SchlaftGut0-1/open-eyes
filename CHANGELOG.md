# Changelog

All notable changes to open-eyes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `open-eyes do "<goal>"` lets a local model carry out a routine task in the agent
  window, through any OpenAI-compatible endpoint set in `OPEN_EYES_MODEL_URL` (llama.cpp's
  `llama-server`, Ollama). It prints the outcome (`done`, `not done`, `not sure` or
  `stopped`), the actions it took and the page it ended on, so the main agent reads a few
  lines instead of every snapshot. The model may only read, click, fill, select, press,
  scroll and hover; policy, approvals and the audit log apply to each action, and a
  denial or the user taking control ends the run. `--steps` and `--timeout` limit it.
- `open-eyes model install` downloads the recommended local model for `do` (Gemma 4 E2B,
  2.8 GB) and llama.cpp's server, after showing what it downloads and asking. Downloads
  resume and are verified against pinned checksums. `do` then starts the server on the
  dedicated GPU for each run. `open-eyes model` shows what is installed and whether a newer
  model is available; `open-eyes model remove` deletes it. `OPEN_EYES_MODEL_URL` still
  takes precedence.

### Changed

- Clicking an option of a native dropdown chooses it, as `select` does, and reports
  `chose "<option>" in <dropdown>`. Before, the click did nothing, since Chromium shows
  those options in a popup outside the page. Options of a list that shows them all
  (`multiple` or `size` above 1) still get a real click.

## [0.4.1] - 2026-10-24

### Added

- A project site at https://schlaftgut0-1.github.io/open-eyes/ with what open-eyes
  does, how to install it, and the 0.4.0 vs 0.3.0 benchmarks (including where 0.4.0 is
  not better). It is published from `main` by a GitHub Pages workflow.
- The README explains how to install open-eyes straight from a release with npm, how to
  verify the package's checksum and provenance first, and where to find the agent skill
  after installing.

## [0.4.0] - 2026-10-24

Agents read far fewer tokens (see 0.4.0-beta.1) and can now do much more on a page:
scroll, pick from dropdowns, hover menus, upload and download files, act by name, and
work inside iframes.

### Added

- `open-eyes scroll [@N] [down|up] [pixels]` scrolls the page, or the list or panel
  holding `@N`, with real mouse-wheel events (lazy loading works), and shows what is on
  screen afterwards.
- `open-eyes select @N "Option"` chooses an option in native and custom dropdowns.
- `open-eyes hover @N` moves the mouse over an element and reports the menu or tooltip
  that appeared.
- `open-eyes upload @N <file...>` attaches local files to a file input after you allow
  it; the audit log keeps only file names. Downloads started by an action are saved to
  `~/Downloads/open-eyes` and reported.
- `screenshot --scope @N` captures a single element, even off screen, for far fewer
  image tokens than a full screenshot.
- **Act by name**: `click`, `fill`, `select`, `hover` and `upload` take
  `--name <text> [--role <role>]` instead of `@N`, no snapshot needed. Scripts take
  `{ name, role }`. Ambiguous names list the candidates and their refs.
- **Iframes**, including cross-origin ones (payment forms, embedded logins): their
  content is nested under an `iframe` line in snapshots, their elements get refs, and
  every action works on them at their real position. The policy is checked against the
  iframe's own site.
- Each release carries its signed build provenance (`.sigstore.json` and
  `.intoto.jsonl`) next to the package and checksum.

### Changed

- Actions wait for the content they fetched (fetch and XHR, at most 2 s) before
  reporting what changed, so debounced results such as search suggestions are in the
  report.

## [0.4.0-beta.1] - 2026-10-23

First pre-release of 0.4.0: agents read far fewer tokens. Measured on six sites, the
default snapshot dropped from 22,139 to 6,802 tokens (-69%), and a live session that
cost 11,423 tokens now costs 5,121.

### Added

- `snapshot` shows **what is on screen**, plus an outline of the headings above and
  below; `--full` prints the whole page. `--find`, `--scope` and `--diff` still cover
  the whole page.
- `snapshot --interactive` keeps only what can be clicked or typed into, plus headings
  (about half the tokens of a full snapshot on text-heavy pages).
- `open-eyes usage` shows the tokens each command cost the agent; `usage show` puts a
  live counter in the agent window.

### Changed

- **Compact snapshot format**: `button Save @3` instead of `- button "Save" @3`; text
  lines are quoted; empty list and table wrappers are gone.
- Snapshots drop noise: table cells and list items named after their own content, list
  bullets, separators, decorative images, repeated labels and lone punctuation.
  Citations are one line.
- When a click navigates without reloading (GitHub, single-page apps), the action reports
  "the page changed to <url>" in one line instead of a diff of the whole page (GitHub
  tab clicks: ~860 to ~36 tokens).
- The agent skill shrank from 1,582 to 648 tokens; script and option details moved to
  `open-eyes help`.
- Pre-release versions are published as GitHub pre-releases.

### Fixed

- Approving a confirmation no longer breaks the action it approved: clicks on the
  overlay never reach the page or move keyboard focus (Wikipedia's search closed on the
  click on Allow).
- The token counter no longer covers the Allow and Deny buttons in small windows.

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

[Unreleased]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.4.0-beta.1...v0.4.0
[0.4.0-beta.1]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.3.0...v0.4.0-beta.1
[0.3.0]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SchlaftGut0-1/open-eyes/compare/2bbe51e...v0.2.0
[0.1.0]: https://github.com/SchlaftGut0-1/open-eyes/commit/2bbe51e
