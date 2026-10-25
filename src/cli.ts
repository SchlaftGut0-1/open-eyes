#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  browserVersion,
  closeAgentWindow,
  connectBrowser,
  connectExistingPage,
  connectPage,
  disconnectBrowser,
  findEverydayBrowser,
  launch,
} from "./browser.ts";
import { need, takeFlag, takeNumber, takeOption, takeTarget, takeTimeout } from "./args.ts";
import { readAudit } from "./audit.ts";
import { runDaemon } from "./daemon.ts";
import { modelEndpoint, navigate, NO_MODEL } from "./navigator.ts";
import type { Page } from "./page.ts";
import { CONFIRM_MODES, loadPolicy, normalizeSite, policyFile, savePolicy, type ConfirmMode } from "./policy.ts";
import { runScript } from "./run.ts";
import { formatUsage, readUsage, recordUsage, resetUsage, usageSummary } from "./usage.ts";
import { loadState, profileDir, saveState, socketPath } from "./state.ts";

const HELP = `open-eyes: give your AI agent eyes on a real browser, while you watch.

Usage: open-eyes <command> [args]

Browser
  launch [--headless]    Start a visible browser with the open-eyes profile
                         (--headless: no window, for CI or background work)
  connect                Use your everyday browser, with your logins, instead
                         (enable it first at chrome://inspect/#remote-debugging)
    --browser <name>     chrome, chromium, brave or edge (default: first found)
    --endpoint <ws-url>  A local DevTools WebSocket URL to connect to directly
  disconnect             Stop using your everyday browser
  status                 Show the browser and the agent window
  close                  Close the agent window

Page (works in the agent's own window)
  open <url>             Open a URL
  snapshot               Print what is on screen as text, plus an outline of the rest;
                         actionable elements get @N refs, which stay the same for an
                         element while the page is loaded
    --full               The whole page instead of what is on screen
    --interactive        Only what can be clicked or typed into, plus headings
    --diff               Only what changed since the last snapshot
    --find <text>        Only lines containing <text>, with their parents
    --scope <@N>         Only the element @N and what is inside it
    --limit <lines>      Lines per page (default 400, 0 for all)
    --page <n>           Page to show when the snapshot is longer than --limit
  click <@N>             Click an element from the last snapshot
  fill <@N> <text>       Replace the content of a field
  press <key>            Press a key (Enter, Tab, Escape, ArrowDown, a, ...)
  select <@N> <option>   Choose an option by its text in a dropdown (native or custom)
  hover <@N>             Move the mouse over an element and report what appeared
  upload <@N> <file...>  Attach local files to a file input (asks the user first)
                         Instead of <@N>, these take --name <text> [--role <role>]:
                         the element with that accessible name, no snapshot needed
                         Downloads started by click or press are saved in
                         ~/Downloads/open-eyes (OPEN_EYES_DOWNLOADS) and reported
  scroll [@N] [down|up] [pixels]
                         Scroll the page (default: down one screen); with @N, scroll
                         the list or panel holding it, or with no direction bring
                         @N into view. Prints what is on screen afterwards
  screenshot [path]      Save a PNG of the page and print its path
    --scope <@N>         Only that element (cheaper for vision models)
  eval <js>              Evaluate a JavaScript expression in the page
  run <file|->           Run a script with \`page\` in scope (- reads stdin)

Scripts (open-eyes run): \`page\` methods, all async
  goto(url)  snapshot({ full, find, scope, diff, interactive, limit, page })
  click("@N")  fill("@N", text)  press(key)  select("@N", option)  hover("@N")
  upload("@N", [paths])   Each also takes { name, role? } instead of "@N"
  scroll(ref?, "down"|"up", px?)
  waitForText(text, ms?)  wait(ms)
  eval(js)  screenshot(path?, ref?)  handoff(message?, ms?)  url()
  Refs come from snapshot(): take one before clicking and after the page changes.

Local model (optional)
  do "<goal>"            Let a local model carry out the goal in the agent window
                         and print what it did and whether it succeeded. It may
                         read and act (click, fill, select...), never eval, upload
                         or open other pages; the safety rules below still apply
    --steps <n>          Most commands it may run (default 15)
    --timeout <seconds>  Give up after this long (default 180)

Working with the user
  handoff <message>      Ask the user to take over (log in, solve a captcha...)
                         and wait until they hand control back
  wait                   Wait until the user hands back control they took
                         Both accept --timeout <seconds> (default 600)

Safety
  policy                 Show which sites the agent may use and what needs approval
  policy allow <site...> Only allow these sites (and their subdomains)
  policy block <site...> Never allow these sites
  policy remove <site...>  Remove sites from both lists
  policy confirm <mode>  Ask before risky actions (risky, default), every action
                         (always) or never (never)
  policy reset           Back to defaults: every site allowed, confirm risky
  log [--limit <n>]      Show the last actions the agent took (default 20)

Token usage
  usage [--limit <n>]    Tokens each recent command cost the agent (estimated)
  usage show|hide        Show or hide the token counter in the agent window
  usage reset            Start counting from zero

Environment
  OPEN_EYES_PORT         Remote debugging port (default 9222)
  OPEN_EYES_BROWSER      Browser binary to launch
  OPEN_EYES_SLOWMO       Pause in ms after showing each action (default 400)
  OPEN_EYES_SNAPSHOT_LIMIT  Default snapshot page size in lines (default 400)
  OPEN_EYES_OBSERVE      Set to 0 to stop actions from reporting page changes
  OPEN_EYES_CONFIRM      Override the confirm mode (risky, always, never)
  OPEN_EYES_MODEL_URL    OpenAI-compatible endpoint for "do", e.g. llama-server
                         at http://127.0.0.1:8080/v1 or Ollama at :11434/v1
  OPEN_EYES_MODEL        Model name to ask for (needed by Ollama)
  OPEN_EYES_MODEL_KEY    API key, if the endpoint needs one`;

function format(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function print(value: unknown): void {
  const text = format(value);
  if (text) console.log(text);
}

const CONNECT_HELP = `no browser with remote debugging enabled was found.
In Chrome 144+ (or Chromium, Brave, Edge), type chrome://inspect/#remote-debugging in the
address bar, turn on remote debugging there, and run "open-eyes connect" again.`;

/**
 * Runs a page command and records what it printed, which is what the agent reads and pays
 * for in tokens. `label` names the command in `open-eyes usage`; it never holds typed text.
 */
async function withPage(label: string, action: (page: Page) => Promise<unknown>): Promise<void> {
  const state = loadState();
  const started = Date.now();
  let output = "";
  let connection: Awaited<ReturnType<typeof connectPage>> | undefined;
  try {
    connection = await connectPage(state);
    output = format(await action(connection.page));
    if (output) console.log(output);
  } catch (error) {
    output = `error: ${(error as Error).message}`;
    throw error;
  } finally {
    const entry = recordUsage(label, output, Date.now() - started);
    if (state.showTokens && connection) await connection.page.showUsage(usageSummary(entry)).catch(() => {});
    connection?.cdp.close();
    saveState(state); // Also when connecting failed: it may have learned the daemon is gone.
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
      if (state.daemonPid) {
        print(`browser: your everyday browser, connected through the open-eyes daemon (pid ${state.daemonPid})`);
      } else {
        const version = await browserVersion(state.port);
        if (!version) return print(`no browser on port ${state.port}; run "open-eyes launch" or "open-eyes connect"`);
        print(`browser: ${version.Browser} on port ${state.port}`);
      }
      // Only look: status must not open an agent window in the user's browser.
      try {
        const { cdp, page } = await connectExistingPage(state);
        try {
          if (!page) return print("agent window: none (opens with the next page command)");
          const inControl = (await page.owner()) === "user" ? "the user" : "the agent";
          return print(`agent window: ${await page.url()}\nin control: ${inControl}`);
        } finally {
          cdp.close();
        }
      } finally {
        saveState(state);
      }
    }
    case "connect": {
      const state = loadState();
      const browser = takeOption(args, "--browser");
      let endpoint = takeOption(args, "--endpoint");
      let name = endpoint ?? "";
      if (!endpoint) {
        const found = findEverydayBrowser(browser);
        if (!found) throw new Error(CONNECT_HELP);
        ({ url: endpoint, name } = found);
      }
      console.error(`connecting to ${name}; approve the remote debugging prompt in your browser if it appears...`);
      const product = await connectBrowser(state, endpoint);
      saveState(state);
      // Chromium-based browsers all report themselves as "Chrome/<version>".
      const label = name === endpoint ? product : `${name} (${product.replace("Chrome/", "version ")})`;
      return print(`connected to ${label}. Agent commands now use your browser; "open-eyes disconnect" to stop.`);
    }
    case "disconnect": {
      const state = loadState();
      const disconnected = await disconnectBrowser(state);
      saveState(state);
      return print(disconnected ? "disconnected from your browser" : "not connected to a browser");
    }
    case "policy": {
      const policy = loadPolicy();
      const [action, ...sites] = args;
      if (action === "allow" || action === "block") {
        const list = policy[action];
        for (const site of sites.map(normalizeSite)) if (!list.includes(site)) list.push(site);
        if (!sites.length) throw new Error(`usage: open-eyes policy ${action} <site...>`);
      } else if (action === "remove") {
        const drop = new Set(sites.map(normalizeSite));
        policy.allow = policy.allow.filter((site) => !drop.has(site));
        policy.block = policy.block.filter((site) => !drop.has(site));
      } else if (action === "confirm") {
        const mode = sites[0] as ConfirmMode;
        if (!CONFIRM_MODES.includes(mode)) throw new Error(`usage: open-eyes policy confirm <${CONFIRM_MODES.join("|")}>`);
        policy.confirm = mode;
      } else if (action === "reset") {
        Object.assign(policy, { allow: [], block: [], confirm: "risky" });
      } else if (action !== undefined) {
        throw new Error(`unknown policy action "${action}"; see "open-eyes help"`);
      }
      if (action !== undefined) savePolicy(policy);
      return print(
        [
          `allowed sites: ${policy.allow.length ? policy.allow.join(", ") : "all"}`,
          `blocked sites: ${policy.block.length ? policy.block.join(", ") : "none"}`,
          `ask before: ${{ risky: "risky actions", always: "every action", never: "nothing" }[policy.confirm]}`,
          `file: ${policyFile}`,
        ].join("\n"),
      );
    }
    case "usage": {
      const state = loadState();
      const action = args[0];
      if (action === "reset") {
        resetUsage();
        return print("token counter reset");
      }
      if (action === "show" || action === "hide") {
        state.showTokens = action === "show" || undefined;
        saveState(state);
        if (action === "hide") {
          // Take the counter off the window now instead of at the next command.
          const { cdp, page } = await connectExistingPage(state).catch(() => ({ cdp: undefined, page: undefined }));
          await page?.showUsage(null).catch(() => {});
          cdp?.close();
        }
        return print(action === "show" ? "token counter shown in the agent window" : "token counter hidden");
      }
      if (action !== undefined && action !== "--limit") throw new Error(`unknown usage action "${action}"; see "open-eyes help"`);
      return print(formatUsage(readUsage(), takeNumber(args, "--limit", 1) ?? 30));
    }
    case "log": {
      const limit = takeNumber(args, "--limit", 1) ?? 20;
      const entries = readAudit(limit);
      return print(entries.length ? entries.join("\n") : "no actions recorded yet");
    }
    case "__daemon": // Started by "connect"; not for direct use.
      return runDaemon(need(args[0], "__daemon <ws-url>"), socketPath);
    case "close": {
      const state = loadState();
      const closed = await closeAgentWindow(state);
      saveState(state);
      return print(closed ? "closed the agent window" : "no agent window to close");
    }
    case "open":
      return withPage(`open ${args[0] ?? ""}`, (page) => page.goto(need(args[0], "open <url>")));
    case "snapshot": {
      const original = [...args];
      const options = {
        full: takeFlag(args, "--full"),
        interactive: takeFlag(args, "--interactive"),
        diff: takeFlag(args, "--diff"),
        find: takeOption(args, "--find"),
        scope: takeOption(args, "--scope"),
        limit: takeNumber(args, "--limit", 0),
        page: takeNumber(args, "--page", 1),
      };
      if (args.length) throw new Error(`unknown snapshot option "${args[0]}"; see "open-eyes help"`);
      return withPage(`snapshot ${original.join(" ")}`.trim(), (page) => page.snapshot(options));
    }
    case "click": {
      const [target, label] = takeTarget(args, "click <@N>");
      return withPage(`click ${label}`, (page) => page.click(target));
    }
    case "fill": {
      const [target, label] = takeTarget(args, "fill <@N> <text>");
      return withPage(`fill ${label}`, (page) => page.fill(target, args.join(" ")));
    }
    case "press":
      return withPage(`press ${args[0] ?? ""}`, (page) => page.press(need(args[0], "press <key>")));
    case "upload": {
      const [target, label] = takeTarget(args, "upload <@N> <file...>");
      if (!args.length) throw new Error("usage: open-eyes upload <@N> <file...>");
      return withPage(`upload ${label} ${args.map((f) => f.split("/").pop()).join(" ")}`, (page) => page.upload(target, args));
    }
    case "hover": {
      const [target, label] = takeTarget(args, "hover <@N>");
      return withPage(`hover ${label}`, (page) => page.hover(target));
    }
    case "select": {
      const [target, label] = takeTarget(args, "select <@N> <option>");
      const option = need(args.join(" ") || undefined, "select <@N> <option>");
      return withPage(`select ${label} ${option}`, (page) => page.select(target, option));
    }
    case "scroll": {
      let ref: string | undefined;
      let direction: "down" | "up" | undefined;
      let pixels: number | undefined;
      for (const arg of args) {
        if (/^@\d+$/.test(arg) && ref === undefined) ref = arg;
        else if (arg === "down" || arg === "up") direction = arg;
        else if (/^\d+$/.test(arg)) pixels = Number(arg);
        else throw new Error("usage: open-eyes scroll [@N] [down|up] [pixels]");
      }
      return withPage(`scroll ${args.join(" ")}`.trim(), (page) => page.scroll(ref, direction, pixels));
    }
    case "screenshot": {
      const scope = takeOption(args, "--scope");
      return withPage(scope ? `screenshot --scope ${scope}` : "screenshot", (page) => page.screenshot(args[0], scope));
    }
    case "eval":
      return withPage("eval", (page) => page.eval(need(args[0], "eval <js>")));
    case "run": {
      const file = need(args[0], "run <file|->");
      const source = readFileSync(file === "-" ? 0 : file, "utf8");
      return withPage(`run ${file}`, (page) => runScript(page, source));
    }
    case "do": {
      const steps = takeNumber(args, "--steps", 1);
      const timeout = takeTimeout(args);
      const goal = need(args.join(" ").trim() || undefined, 'do "<goal>" [--steps <n>] [--timeout <seconds>]');
      const endpoint = modelEndpoint();
      if (!endpoint) throw new Error(NO_MODEL);
      return withPage("do", (page) => navigate(page, goal, endpoint, { steps, timeout }));
    }
    case "handoff": {
      const timeout = takeTimeout(args);
      const message = need(args.join(" ") || undefined, "handoff <message> [--timeout <seconds>]");
      return withPage("handoff", (page) => page.handoff(message, timeout));
    }
    case "wait": {
      const timeout = takeTimeout(args);
      return withPage("wait", (page) => page.handoff(undefined, timeout));
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
