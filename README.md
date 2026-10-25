# open-eyes

[![CI](https://github.com/SchlaftGut0-1/open-eyes/actions/workflows/ci.yml/badge.svg)](https://github.com/SchlaftGut0-1/open-eyes/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/SchlaftGut0-1/open-eyes/badge)](https://scorecard.dev/viewer/?uri=github.com/SchlaftGut0-1/open-eyes)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Give your AI agents eyes. `open-eyes` lets Claude Code, Codex, Cursor, opencode, or any
agent with a terminal see and drive a **real, visible browser**, and lets **you watch
what it is doing** as it happens.

**Site:** https://schlaftgut0-1.github.io/open-eyes/ · [Benchmarks](https://schlaftgut0-1.github.io/open-eyes/benchmarks.html)

- **Your browser, no fork.** Works with stock Chromium, Chrome, Brave, or Edge over the
  Chrome DevTools Protocol. Use a dedicated profile (`launch`) or your everyday browser
  with all your logins (`connect`).
- **You can see the agent.** It works in its own window with a live overlay: a cursor
  that moves to each target, a highlight on the element it is about to touch, and a
  banner describing the step.
- **Take control any time.** Press **Take control** in the agent's window to pause it,
  do what you need, and hand it back. Agents can also ask for help with
  `open-eyes handoff "Please log in"` and wait for you.
- **Guardrails against prompt injection.** Allow and block lists keep the agent on the
  sites you choose; risky actions (paying, sending, deleting, submitting, typing a
  password) wait for your **Allow / Deny** on screen; every action is logged.
- **Cheap eyes.** `snapshot` shows what is on screen as compact text with stable `@N`
  refs, plus an outline of the rest, so the model reads structure instead of burning
  tokens on screenshots. Every action reports only what it changed, and `--find`,
  `--scope` and `--diff` show just the part that matters. On a Wikipedia article the
  default snapshot is about 1,000 tokens, less than a screenshot. Screenshots are there
  when visuals matter.
- **One call, many steps.** Agents can write a short script (`open-eyes run`) instead of
  a slow command-by-command loop.
- **Linux first**, fully open source (MIT).

## Install

You need Node.js 22 or newer and Chromium, Chrome, Brave or Edge. Install the package
from the latest [release](https://github.com/SchlaftGut0-1/open-eyes/releases):

```bash
npm install -g https://github.com/SchlaftGut0-1/open-eyes/releases/download/v0.4.1/open-eyes-0.4.1.tgz
```

To check the package first, download it with its checksum and provenance from the
release page, then:

```bash
sha256sum -c open-eyes-0.4.1.tgz.sha256
gh attestation verify open-eyes-0.4.1.tgz -R SchlaftGut0-1/open-eyes
npm install -g ./open-eyes-0.4.1.tgz
```

To use it from an agent, copy the skill into your agent's skills directory (for Claude
Code: `~/.claude/skills/open-eyes`):

```bash
cp -r "$(npm root -g)/open-eyes/skills/open-eyes" ~/.claude/skills/
```

## Quick start

```bash
open-eyes launch      # visible browser with its own open-eyes profile
open-eyes open news.ycombinator.com
open-eyes snapshot
open-eyes click @12
```

To work on open-eyes itself, build it from a clone instead: `npm install`,
`npm run build`, then `npm link` puts your build on your PATH.

## Use your everyday browser

Chrome 144+ (and Chromium, Brave, Edge) can let tools connect to the browser you already
use:

1. Open `chrome://inspect/#remote-debugging` and turn remote debugging on.
2. Run `open-eyes connect` and approve the prompt in your browser.

Chrome asks for approval on every new connection, so open-eyes keeps a single approved
connection in a small background daemon and routes commands through a private local
socket (readable only by your user). The agent works in its own window; your tabs are
left alone. `open-eyes disconnect` closes that window and stops the daemon.

## Local model (optional)

`open-eyes do "<goal>"` hands a routine task to a small model running on your computer.
It reads the page and acts in the agent window, and your agent pays only for the goal
and a short report, about 30 tokens instead of the ~1,600 it would read doing the steps
itself.

```bash
open-eyes model install        # shows what it downloads and asks first
open-eyes open example.com/signup
open-eyes do "Sign up as Ana and accept the terms"
```

```
done: Hello, Ana (accepted)
actions:
  fill @1 "Ana" → filled textbox "Name"
  click @2 → clicked checkbox "Accept terms"
  click @4 → clicked button "Send"
page: https://example.com/signup
```

`open-eyes model install` downloads the model we tested and recommend, Gemma 4 E2B
(2.8 GB, Apache 2.0, fits on a 4 GB GPU), and llama.cpp's server (about 35 MB) into
`~/.local/share/open-eyes/models`, verifying both against pinned checksums. An interrupted
download resumes. `do` starts the server for each run, on your dedicated GPU, and stops it
afterwards. `open-eyes model` shows what is installed and tells you when a better model is
available, and `open-eyes model remove` deletes it all. Nothing is downloaded until you
agree.

To use your own server instead, set `OPEN_EYES_MODEL_URL` to any OpenAI-compatible
endpoint, such as llama.cpp's `llama-server` at `http://127.0.0.1:8080/v1` or Ollama at
`http://127.0.0.1:11434/v1` with `OPEN_EYES_MODEL` set to the model's name. It takes
precedence over the downloaded model.

The model can read, click, type, choose, scroll and hover, never run JavaScript, upload
files or open other sites, and every action goes through the policy, approvals and audit
log below. If you deny an action or take control, it stops. Small models can be wrong
about their own success, so the report lists every action: check the result before
relying on it.

## Safety

Web pages can hide instructions meant to hijack an agent, and there is no complete fix
for that. open-eyes limits the damage:

```bash
open-eyes policy allow github.com docs.python.org   # only these sites (and subdomains)
open-eyes policy block mybank.com                   # never these, even if allowed
open-eyes policy confirm risky                      # default: ask before risky actions
open-eyes log                                       # what the agent did
```

- The agent cannot open, read or act on a site outside the policy, and open-eyes leaves
  the page if a click or redirect lands there.
- Before a risky action, the window highlights the target and asks **Allow / Deny**.
  Only real clicks from you count; page scripts cannot answer. `confirm always` asks for
  every action; `confirm never` turns questions off (for unattended runs).
- The audit log records every action and its outcome, never the text typed into fields.

These guardrails stop pages from steering a well-behaved agent. They cannot stop an
agent that is itself compromised: it has a shell and could edit the policy file.

## Commands

| Command | Does |
|---|---|
| `launch [--headless]` | Start a browser with the open-eyes profile (visible unless `--headless`) |
| `connect [--browser <name>]` | Use your everyday browser, with your logins |
| `disconnect` | Stop using your everyday browser |
| `status` | Show the browser and the agent window |
| `open <url>` | Open a URL in the agent window |
| `snapshot` | Print what is on screen as text, plus an outline of the rest; actionable elements get `@N` refs. Iframes, also cross-origin ones (payment forms, embedded logins), are nested under an `iframe` line and work like the rest of the page |
| `snapshot --find <text>` / `--scope @N` / `--diff` / `--full` / `--interactive` | Matching lines, one element, what changed, the whole page, or only what can be acted on |
| `click <@N>` | Click an element. Instead of `@N`, `click`, `fill`, `select`, `hover` and `upload` take `--name <text> [--role <role>]`: the element with that accessible name, no snapshot needed |
| `fill <@N> <text>` | Replace a field's content |
| `press <key>` | Press a key |
| `select <@N> <option>` | Choose an option by its text in a dropdown (native or custom) |
| `hover <@N>` | Move the mouse over an element and report the menu or tooltip that appeared |
| `upload <@N> <file...>` | Attach local files to a file input, after you allow it; downloads are saved to `~/Downloads/open-eyes` |
| `scroll [@N] [down\|up] [pixels]` | Scroll the page, or the list holding `@N`, and show what is on screen |
| `screenshot [path] [--scope @N]` | Save a PNG of the page, or of one element, and print its path |
| `eval <js>` | Evaluate JavaScript in the page |
| `run <file\|->` | Run a multi-step script with `page` in scope |
| `do "<goal>" [--steps <n>] [--timeout <seconds>]` | Let a local model carry out a goal and report what it did ([Local model](#local-model-optional)) |
| `model [install [--yes]\|remove]` | Show, download (after asking) or delete the local model for `do` |
| `handoff <message>` | Ask the user to take over, wait until they hand control back |
| `wait` | Wait until the user hands back control they took |
| `policy [allow\|block\|remove\|confirm\|reset]` | Show or change which sites are allowed and what needs approval |
| `log` | Show the last actions the agent took |
| `usage [show\|hide\|reset]` | Tokens each command cost the agent; `show` puts a live counter in the agent window |
| `close` | Close the agent window |

Set `OPEN_EYES_SLOWMO=0` to drop the pause that lets you follow each action.

## How it works

```
agent ──shell──▶ open-eyes CLI ──CDP (WebSocket)──▶ your Chromium
                                                     └─ agent window + overlay
```

Each command is a short-lived process. It attaches to the agent's window (creating it
if needed), reads the accessibility tree (attaching to cross-origin iframes, which run in
their own processes) or acts on the page, and exits. Refs from the
last snapshot are kept in `~/.local/state/open-eyes/state.json`.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in
[SECURITY.md](SECURITY.md).

## Status

Early MVP. Next up: several parallel agent windows ("spaces").
