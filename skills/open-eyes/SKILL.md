---
name: open-eyes
description: See and drive a real, visible web browser. Use when a task needs a website - reading a page, logging in, filling forms, clicking through a flow, scraping, or checking how a web app you are building actually looks and behaves.
---

# open-eyes

`open-eyes` drives a real Chromium-based browser over the Chrome DevTools Protocol.
You work in your own browser window; the user can watch every action live (a purple
cursor, a highlight on the element you touch, and a banner describing the step).

## Setup

```bash
open-eyes status     # is a browser running?
open-eyes launch     # if not: starts a visible browser with the open-eyes profile
```

The open-eyes profile keeps its logins between runs. If a site needs the user to log
in, open the page, tell the user, and wait for them to do it in that window.

## Core loop

1. `open-eyes open <url>`
2. `open-eyes snapshot`: the page as indented text. Every actionable element ends with
   a ref like `@7`.
3. Act with refs: `open-eyes click @7`, `open-eyes fill @3 "some text"`, `open-eyes press Enter`.
4. Snapshot again after anything that changes the page. Refs from an old snapshot go
   stale when the page changes; the CLI tells you when that happens.

Use `open-eyes screenshot` when layout or visuals matter (it prints a PNG path you can
read). Prefer `snapshot` for everything else: it is far cheaper.

## Multi-step scripts

For tasks with several steps, write one script instead of many commands. `page` is in
scope; `return` a value or `console.log` to report back.

```bash
open-eyes run - <<'EOF'
await page.goto("https://news.ycombinator.com");
const snap = await page.snapshot();
console.log(snap.split("\n").slice(0, 40).join("\n"));
EOF
```

`page` API:

| Method | Does |
|---|---|
| `goto(url)` | Open a URL, wait for load, return the final URL |
| `snapshot()` | Return the page text with fresh `@N` refs |
| `click("@N")` | Click an element |
| `fill("@N", text)` | Replace a field's content |
| `press(key)` | `Enter`, `Tab`, `Escape`, arrows, or one character |
| `waitForText(text, ms?)` | Wait until text appears on the page |
| `wait(ms)` | Sleep |
| `eval(js)` | Evaluate an expression in the page, return its JSON value |
| `screenshot(path?)` | Save a PNG, return its path |
| `url()` | Current URL |

Refs only exist after a `snapshot()`, so inside a script take a snapshot before clicking
and again after the page changes.

## Etiquette

- Stay in your window. Never close or touch the user's other tabs.
- Ask before anything irreversible: purchases, sending messages, deleting data,
  submitting forms on the user's behalf.
- `open-eyes close` closes your window when you are done.
