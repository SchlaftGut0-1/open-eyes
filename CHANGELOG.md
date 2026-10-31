# Changelog

All notable changes to open-eyes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- open-eyes Browser built on Chromium, in `packages/browser`: Chromium 156 with
  ungoogled-chromium's patches and our own on top, built on Linux
  with `packages/browser/scripts/build.sh`. It is named open-eyes Browser, with the eye
  icon, in its window, pages and text in every language, and keeps its profile, policies
  and native messaging hosts apart from Chromium's. Google sign-in works in it (#177). It
  is open-eyes purple by default, with our own palette for the frame, toolbar, tabs and
  address bar in light and dark; tabs run down a slim rail of icons on the left; and the
  profile button shows only in incognito and guest windows (#184, #181).
- Spaces: several agents can work in the same browser at once, each in its own window.
  Add `--space <name>` to any command (or set `OPEN_EYES_SPACE`) and that agent gets its
  own window, refs, snapshot baseline, take-control state and dialog watcher; the banner
  shows the space's name. `open-eyes spaces` lists them, and `close --space <name>` closes
  one and forgets it; `disconnect` closes the windows of every space. Without a space,
  commands use the `default` one, as before (#23). Commands in different spaces can run
  at the same time: each space writes only its own state, every write is atomic, and a
  command writes back only the shared settings it changed itself (#24).
- An **Agent** side panel in open-eyes Browser, pinned to the toolbar. It shows the
  agent's steps live in the active tab, and its **Take control** and **Hand back**
  buttons replace the overlay's in that browser. While the user is in control the
  browser itself refuses the agent's clicks, keys and navigations (#185).

## [0.6.0] - 2026-10-28

### Security

- A password in a URL (`https://user:password@host/`) is never stored: the audit log drops
  `user:password@` from every URL, and a trace leaves out the command, as for typing into a
  password field. Before, both kept it.
- The audit log records `eval` by its length (`eval (57 characters)`), as it does `fill`.
  Before, it kept the first 200 characters of the code, so an `eval` that set a password
  field put the password in the log.
- `open-eyes dialog accept` no longer accepts a risky confirm or prompt for the user: under
  `confirm risky`, one whose text has a risky word ("Delete this repository?"), and under
  `confirm always`, any. It stays open and the user answers it in the window. Before, a
  button with no risky words could open such a confirm and the agent could accept it.
- open-eyes never opens the browser's own pages (`chrome://`, `chrome-extension://`,
  `devtools://`, `edge://`, `brave://`). Before, with no allow list, `open
  chrome://password-manager/passwords` worked, so a page's hidden instructions could steer
  the agent to the saved passwords or settings, in `connect` mode those of the user.
- Clicking a form's submit button asks for approval under `confirm risky` by the same rule
  as pressing Enter: forms with a password field, and any form that is not a search. Before,
  a click only asked when the button's name had a risky word, so a login form was sent
  without asking when its button said "Log in" or "Continue".
- Links whose name has a risky word ("Buy now", "Delete account", "Comprar ahora") ask for
  approval under `confirm risky`, as buttons do. Shops and apps often style links as
  buttons; before, they were clicked without asking.
- Traces no longer keep a password that comes back in a later command's output, such as
  the URL of a form sent with GET (`?p=…`). Once a trace typed into a password field, the
  outputs of the commands after it are not stored. Such traces were already left out of
  the export; now the local file does not have it either.
- The audit log says which actions the user allowed on screen: `open-eyes log` shows
  `(the user allowed: click button "Send")`. Before, an approved risky action looked the
  same as one that never asked.

### Added

- `open-eyes drag @N @M` drags an element onto another: press, move in steps, release.
  It works with HTML5 drag and drop and with widgets that follow the mouse. Elements with
  `draggable="true"` get refs for it.
- Rich-text editors (`contenteditable`: TinyMCE, Gmail, Notion, comment boxes) and named
  images get `@N` refs, so `fill` types into editors and `hover` reaches images that reveal
  something (a profile card, a caption). On four benchmark pages snapshots grew 0–3%.
- `click --right` right-clicks (context menus) and `click --double` double-clicks (editing a
  cell, opening a file); in scripts, `page.click("@N", "right")` and `"double"`.
- `press` sends key combinations: `press Control+a`, `press Shift+Tab`,
  `press Control+Enter` (Alt+, Control+, Meta+ and Shift+, in any number).

### Changed

- `snapshot --find` shows a match in a table with its whole row, so a found email or price
  comes with the name it belongs to. Other snapshots are unchanged in size.
- A link with no name (a logo, an icon, a vote arrow) shows where it goes: `link url=/ @1`,
  the path on the same site, the host for another site, and only `#fragment` on the same
  page. Before, it was a bare `link @1`, and the local model clicked Hacker News' logo
  instead of the first story. It costs about 1% more tokens on a Wikipedia article and
  20% on Hacker News' front page, where every vote arrow is such a link.
- The overlay shows only the agent's pointer while it acts, no longer a purple box around
  the element, which stayed on screen after the action.
- `scroll` moves the page in small steps that speed up and slow down, as a person does,
  instead of one jump; `scroll @N` scrolls the element into view smoothly.

### Fixed

- When the local model replies with nothing, `open-eyes do` reports `not done: the model
  gave no answer` instead of `stopped: the model answered without finishing:` and an empty
  quote.
- A page behind HTTP authentication (intranets, routers, staging sites) no longer fails with
  a bare `net::ERR_INVALID_AUTH_CREDENTIALS`: `open` says it asks for a user name and
  password and how to pass them, `https://USER:PASSWORD@host/path`.
- The token counter in the agent window (`usage show`) keeps running totals instead of
  rereading the whole usage log on every command, which added ~0.2 s per command after a
  year of heavy use (29 MB).
- When the agent moved to another tab, the old dialog watcher could delete the new one's
  socket as it exited, so `open-eyes dialog accept` failed with "the dialog watcher is not
  answering". A watcher now removes the socket only while it is still the current one.
- `open-eyes do` stops when the page opens a dialog and reports it, so the main agent can
  answer it with `open-eyes dialog`. Before, the local model, which cannot answer dialogs,
  retried until it ran out of steps or time.
- A page stuck in a script that never ends no longer hangs open-eyes: a request the browser
  does not answer within 60 s fails with "the page stopped responding". Before, a click on
  a button that looped forever never returned.
- `open-eyes do` stops the local model when it is killed (a timeout, Ctrl+C), also while
  the model is starting. Before, `llama-server` kept running and held the model in GPU
  memory.
- `open` waits (up to 5 s) until the page shows something. Single-page apps load an empty
  shell first, and Amazon on a cold start loads itself again right after loading, so the
  snapshot after `open` came out empty (2 lines, no refs).
- `open` takes a file path (`/home/me/page.html`, `./page.html`, `~/page.html`) and opens it
  as a `file://` URL. Before, it became `https:///home/me/page.html` and failed.
- `click` on a disabled control (`disabled`, inside a disabled fieldset, or
  `aria-disabled="true"`) fails and says it is disabled. Before, it reported "clicked"
  although nothing happened, and agents went on as if it had worked.
- On a scaled screen (125%, 200%), the default snapshot showed the wrong part of the page:
  elements on screen were listed as below it, so after `scroll @N` the element seemed still
  off screen. What is on screen is now measured in the page's own pixels.
- `scroll @N` says when the element is still off screen once the page settles (some pages
  pull the scroll back) and which way to scroll, instead of `scrolled to`.
- When an action opens a tab from the agent window (a link with `target=_blank`,
  `window.open`), the agent follows it: that tab becomes the agent window and the action
  says so. Before, the agent stayed on the old tab and could not reach the new one.
- Dialogs no longer stop the agent. An action that opens an alert, confirm or prompt
  returns at once and says what the page asked; the dialog stays open, as for a person,
  until the agent answers it with `open-eyes dialog accept [text]` or
  `open-eyes dialog dismiss` (`open-eyes dialog` shows it). While it is open, other
  commands say so instead of hanging. Before, the action waited until a person closed the
  dialog, and every command after it hung. A background process keeps the connection
  that sees the window's dialogs, since only that connection can answer them.

## [0.5.0] - 2026-10-25

A local model can now carry out routine tasks for the main agent (`open-eyes do`), with a
fine-tuned navigator that `open-eyes model install` downloads, and sessions can be
recorded as training examples (`open-eyes trace`).

### Security

- The audit log keeps only the origin and path of URLs. Query strings and fragments often
  carry what the user typed or secrets, such as a phone number or a sign-up token that a
  site put in its redirect, and they were stored in full.

### Added

- `open-eyes --version` and `open-eyes version` print the installed version.
- `open-eyes do "<goal>"` lets a local model carry out a routine task in the agent
  window, through any OpenAI-compatible endpoint set in `OPEN_EYES_MODEL_URL` (llama.cpp's
  `llama-server`, Ollama). It prints the outcome (`done`, `not done`, `not sure` or
  `stopped`), the actions it took and the page it ended on, so the main agent reads a few
  lines instead of every snapshot. The model may only read, click, fill, select, press,
  scroll and hover; policy, approvals and the audit log apply to each action, and a
  denial or the user taking control ends the run. `--steps` and `--timeout` limit it.
- `open-eyes model install` downloads the recommended local model for `do`,
  [open-eyes navigator v1](https://huggingface.co/SchlaftGut/open-eyes-navigator) (2.2 GB):
  Gemma 4 E2B fine-tuned on open-eyes sessions, which passed 91.1% of held-out tasks with no
  false success claims, against 84.4% and 3 for Gemma 4 E2B itself. It also downloads
  llama.cpp's server, after showing what it downloads and asking. Downloads
  resume and are verified against pinned checksums. `do` then starts the server on the
  dedicated GPU for each run. `open-eyes model` shows what is installed and whether a newer
  model is available; `open-eyes model remove` deletes it. `OPEN_EYES_MODEL_URL` still
  takes precedence.
- `open-eyes trace start "<goal>"` records each following command and what it printed,
  until `open-eyes trace stop [done|failed] [answer]`, as examples for training the local
  model. Recording is opt-in, stays on this computer, and never stores text typed into
  password fields or uploaded files' contents. `trace`, `trace show` and `trace delete`
  review and remove traces; `trace export` writes chat/tool-call JSONL in the exact format
  of `open-eyes do`, leaving out traces it could not learn from and saying why.

### Changed

- Pressing Enter in a search box no longer asks for approval: a form in a search landmark,
  or whose only field is a search box, is not a risky submit. Forms with a password field,
  or any other form, still ask.
- `snapshot --find` and `--name` treat any whitespace as a space, so "Designed by" finds
  Wikipedia's "Designed&nbsp;by" (a non-breaking space) the way an agent types it.
- `fill` on a native dropdown chooses the option with that text, as `select` does, and
  `fill` on anything that cannot take text (a link, button, checkbox, radio, file input or
  read-only field) fails with what to use instead (`click`, `upload`). Before, it reported
  "filled" although nothing was typed, and agents went on as if it had worked.
- `open-eyes do` asks the model for a tool call on every reply (`tool_choice: "required"`),
  gives it room to think before acting (2048 reply tokens instead of 400), reminds it once
  when it answers in plain text or sends a call that cannot be read, and still reports the
  actions taken when the model server fails. On 15 held-out tasks, Gemma 4 E2B went from 6
  of 9 (old set) to 13 of 15, with one false success claim.
- Clicking an option of a native dropdown chooses it, as `select` does, and reports
  `chose "<option>" in <dropdown>`. Before, the click did nothing, since Chromium shows
  those options in a popup outside the page. Options of a list that shows them all
  (`multiple` or `size` above 1) still get a real click.

## [0.4.2] - 2026-10-25

### Security

- A web page could approve open-eyes' risky-action confirmations without the user, by
  writing the answer into the overlay's state, which lived in the page's own JavaScript
  (GHSA-hc9g-g6x3-gpc6). The overlay now runs in an isolated world the page cannot reach,
  its shadow root is closed, and who is in control is also kept in open-eyes' own state.
  Upgrade if you let an agent use sites you do not fully trust.

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

[Unreleased]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.4.0-beta.1...v0.4.0
[0.4.0-beta.1]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.3.0...v0.4.0-beta.1
[0.3.0]: https://github.com/SchlaftGut0-1/open-eyes/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/SchlaftGut0-1/open-eyes/compare/2bbe51e...v0.2.0
[0.1.0]: https://github.com/SchlaftGut0-1/open-eyes/commit/2bbe51e
