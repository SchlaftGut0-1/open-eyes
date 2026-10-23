# open-eyes

[![CI](https://github.com/SchlaftGut0-1/open-eyes/actions/workflows/ci.yml/badge.svg)](https://github.com/SchlaftGut0-1/open-eyes/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/SchlaftGut0-1/open-eyes/badge)](https://scorecard.dev/viewer/?uri=github.com/SchlaftGut0-1/open-eyes)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Give your AI agents eyes. `open-eyes` lets Claude Code, Codex, Cursor, opencode, or any
agent with a terminal see and drive a **real, visible browser**, and lets **you watch
what it is doing** as it happens.

- **Your browser, no fork.** Works with stock Chromium, Chrome, Brave, or Edge over the
  Chrome DevTools Protocol. Use a dedicated profile (`launch`) or your everyday browser
  with all your logins (`connect`).
- **You can see the agent.** It works in its own window with a live overlay: a cursor
  that moves to each target, a highlight on the element it is about to touch, and a
  banner describing the step.
- **Take control any time.** Press **Take control** in the agent's window to pause it,
  do what you need, and hand it back. Agents can also ask for help with
  `open-eyes handoff "Please log in"` and wait for you.
- **Cheap eyes.** `snapshot` turns the page into compact text with stable `@N` refs, so
  the model reads structure instead of burning tokens on screenshots. Every action
  reports only what it changed, and `--find`, `--scope` and `--diff` show just the part
  that matters. On a Wikipedia article, a click reports ~200 tokens of changes instead
  of a ~13,000-token page. Screenshots are there when visuals matter.
- **One call, many steps.** Agents can write a short script (`open-eyes run`) instead of
  a slow command-by-command loop.
- **Linux first**, fully open source (MIT).

## Quick start

```bash
npm install
npm run build
npm link              # puts `open-eyes` on your PATH

open-eyes launch      # visible browser with its own open-eyes profile
open-eyes open news.ycombinator.com
open-eyes snapshot
open-eyes click @12
```

To use it from an agent, copy `skills/open-eyes` into your agent's skills directory
(for Claude Code: `~/.claude/skills/open-eyes`).

## Use your everyday browser

Chrome 144+ (and Chromium, Brave, Edge) can let tools connect to the browser you already
use:

1. Open `chrome://inspect/#remote-debugging` and turn remote debugging on.
2. Run `open-eyes connect` and approve the prompt in your browser.

Chrome asks for approval on every new connection, so open-eyes keeps a single approved
connection in a small background daemon and routes commands through a private local
socket (readable only by your user). The agent works in its own window; your tabs are
left alone. `open-eyes disconnect` closes that window and stops the daemon.

## Commands

| Command | Does |
|---|---|
| `launch [--headless]` | Start a browser with the open-eyes profile (visible unless `--headless`) |
| `connect [--browser <name>]` | Use your everyday browser, with your logins |
| `disconnect` | Stop using your everyday browser |
| `status` | Show the browser and the agent window |
| `open <url>` | Open a URL in the agent window |
| `snapshot` | Print the page as text; actionable elements get `@N` refs |
| `snapshot --find <text>` / `--scope @N` / `--diff` | Only matching lines, one element, or what changed |
| `click <@N>` | Click an element |
| `fill <@N> <text>` | Replace a field's content |
| `press <key>` | Press a key |
| `screenshot [path]` | Save a PNG and print its path |
| `eval <js>` | Evaluate JavaScript in the page |
| `run <file\|->` | Run a multi-step script with `page` in scope |
| `handoff <message>` | Ask the user to take over, wait until they hand control back |
| `wait` | Wait until the user hands back control they took |
| `close` | Close the agent window |

Set `OPEN_EYES_SLOWMO=0` to drop the pause that lets you follow each action.

## How it works

```
agent ──shell──▶ open-eyes CLI ──CDP (WebSocket)──▶ your Chromium
                                                     └─ agent window + overlay
```

Each command is a short-lived process. It attaches to the agent's window (creating it
if needed), reads the accessibility tree or acts on the page, and exits. Refs from the
last snapshot are kept in `~/.local/state/open-eyes/state.json`.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in
[SECURITY.md](SECURITY.md).

## Status

Early MVP. Next up: guardrails against prompt injection, snapshots inside iframes, and
several parallel agent windows ("spaces").
