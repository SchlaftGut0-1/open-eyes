#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { browserVersion, closeAgentWindow, connectPage, launch } from "./browser.ts";
import type { Page } from "./page.ts";
import { runScript } from "./run.ts";
import { loadState, profileDir, saveState } from "./state.ts";

const HELP = `open-eyes: give your AI agent eyes on a real browser, while you watch.

Usage: open-eyes <command> [args]

Browser
  launch [--headless]    Start a visible browser with the open-eyes profile
                         (--headless: no window, for CI or background work)
  status                 Show the browser and the agent window
  close                  Close the agent window

Page (works in the agent's own window)
  open <url>             Open a URL
  snapshot               Print the page as text; actionable elements get @N refs,
                         which stay the same for an element while the page is loaded
    --diff               Only what changed since the last snapshot
    --find <text>        Only lines containing <text>, with their parents
    --scope <@N>         Only the element @N and what is inside it
    --limit <lines>      Lines per page (default 400, 0 for all)
    --page <n>           Page to show when the snapshot is longer than --limit
  click <@N>             Click an element from the last snapshot
  fill <@N> <text>       Replace the content of a field
  press <key>            Press a key (Enter, Tab, Escape, ArrowDown, a, ...)
  screenshot [path]      Save a PNG of the page and print its path
  eval <js>              Evaluate a JavaScript expression in the page
  run <file|->           Run a script with \`page\` in scope (- reads stdin)

Working with the user
  handoff <message>      Ask the user to take over (log in, solve a captcha...)
                         and wait until they hand control back
  wait                   Wait until the user hands back control they took
                         Both accept --timeout <seconds> (default 600)

Environment
  OPEN_EYES_PORT         Remote debugging port (default 9222)
  OPEN_EYES_BROWSER      Browser binary to launch
  OPEN_EYES_SLOWMO       Pause in ms after showing each action (default 400)
  OPEN_EYES_SNAPSHOT_LIMIT  Default snapshot page size in lines (default 400)
  OPEN_EYES_OBSERVE      Set to 0 to stop actions from reporting page changes`;

function print(value: unknown): void {
  if (value === undefined) return;
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

/** Removes `--name <value>` from args and returns the value. */
function takeOption(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

/** Removes `--name <number>` from args and returns the number, at least `min`. */
function takeNumber(args: string[], name: string, min: number): number | undefined {
  const value = takeOption(args, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) throw new Error(`${name} needs a whole number of at least ${min}`);
  return number;
}

/** Removes `--name` from args and returns whether it was there. */
function takeFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i !== -1) args.splice(i, 1);
  return i !== -1;
}

/** Removes `--timeout <seconds>` from args and returns it in milliseconds. */
function takeTimeout(args: string[]): number | undefined {
  const seconds = takeNumber(args, "--timeout", 1);
  return seconds === undefined ? undefined : seconds * 1000;
}

function need(arg: string | undefined, usage: string): string {
  if (arg === undefined) throw new Error(`usage: open-eyes ${usage}`);
  return arg;
}

async function withPage(action: (page: Page) => Promise<unknown>): Promise<void> {
  const state = loadState();
  const { cdp, page } = await connectPage(state);
  try {
    print(await action(page));
  } finally {
    saveState(state);
    cdp.close();
  }
}

async function main([command, ...args]: string[]): Promise<void> {
  switch (command) {
    case "launch": {
      const state = loadState();
      const { binary, alreadyRunning } = await launch(state.port, { headless: args.includes("--headless") });
      saveState(state);
      print(
        alreadyRunning
          ? `browser already running on port ${state.port}`
          : `launched ${binary} on port ${state.port}\nprofile: ${profileDir}`,
      );
      return;
    }
    case "status": {
      const state = loadState();
      const version = await browserVersion(state.port);
      if (!version) return print(`no browser on port ${state.port}; run "open-eyes launch"`);
      print(`browser: ${version.Browser} on port ${state.port}`);
      return withPage(async (page) => {
        const inControl = (await page.owner()) === "user" ? "the user" : "the agent";
        return `agent window: ${await page.url()}\nin control: ${inControl}`;
      });
    }
    case "close": {
      const state = loadState();
      const closed = await closeAgentWindow(state);
      saveState(state);
      return print(closed ? "closed the agent window" : "no agent window to close");
    }
    case "open":
      return withPage((page) => page.goto(need(args[0], "open <url>")));
    case "snapshot": {
      const options = {
        diff: takeFlag(args, "--diff"),
        find: takeOption(args, "--find"),
        scope: takeOption(args, "--scope"),
        limit: takeNumber(args, "--limit", 0),
        page: takeNumber(args, "--page", 1),
      };
      if (args.length) throw new Error(`unknown snapshot option "${args[0]}"; see "open-eyes help"`);
      return withPage((page) => page.snapshot(options));
    }
    case "click":
      return withPage((page) => page.click(need(args[0], "click <@N>")));
    case "fill": {
      const ref = need(args[0], "fill <@N> <text>");
      return withPage((page) => page.fill(ref, args.slice(1).join(" ")));
    }
    case "press":
      return withPage((page) => page.press(need(args[0], "press <key>")));
    case "screenshot":
      return withPage((page) => page.screenshot(args[0]));
    case "eval":
      return withPage((page) => page.eval(need(args[0], "eval <js>")));
    case "run": {
      const file = need(args[0], "run <file|->");
      const source = readFileSync(file === "-" ? 0 : file, "utf8");
      return withPage((page) => runScript(page, source));
    }
    case "handoff": {
      const timeout = takeTimeout(args);
      const message = need(args.join(" ") || undefined, "handoff <message> [--timeout <seconds>]");
      return withPage((page) => page.handoff(message, timeout));
    }
    case "wait": {
      const timeout = takeTimeout(args);
      return withPage((page) => page.handoff(undefined, timeout));
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return print(HELP);
    default:
      throw new Error(`unknown command "${command}"; see "open-eyes help"`);
  }
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
