#!/usr/bin/env node
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
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
import { audit, readAudit } from "./audit.ts";
import { runDaemon } from "./daemon.ts";
import { answerDialog, describeDialog, openDialog, runWatcher } from "./dialogs.ts";
import { formatSize, installedNavigator, installNavigator, MANIFEST, modelsDir, navigatorStatus, serverFor, startNavigator } from "./models.ts";
import { modelEndpoint, navigate, NO_MODEL } from "./navigator.ts";
import type { Page } from "./page.ts";
import { CONFIRM_MODES, loadPolicy, normalizeSite, policyFile, savePolicy, type ConfirmMode } from "./policy.ts";
import { runScript } from "./run.ts";
import { formatUsage, readUsage, recordUsage, resetUsage, usageSummary } from "./usage.ts";
import { loadState, profileDir, saveState, socketPath } from "./state.ts";
import { activeTrace, deleteTraces, formatCommand, listTraces, readTrace, recordStep, startTrace, stopTrace, toExample, tracesDir } from "./trace.ts";

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
  version, --version     Print the open-eyes version

Page (works in the agent's own window)
  open <url|file>        Open a URL, or a local file by its path
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
  press <key>            Press a key (Enter, Tab, Escape, ArrowDown, a, ...), with
                         Alt+, Control+, Meta+ or Shift+ for a combination (Control+a)
  select <@N> <option>   Choose an option by its text in a dropdown (native or custom)
  hover <@N>             Move the mouse over an element and report what appeared
  upload <@N> <file...>  Attach local files to a file input (asks the user first)
                         Instead of <@N>, these take --name <text> [--role <role>]:
                         the element with that accessible name, no snapshot needed
                         Downloads started by click or press are saved in
                         ~/Downloads/open-eyes (OPEN_EYES_DOWNLOADS) and reported
  dialog                 Show the alert, confirm or prompt the page is showing; it
                         stays open, and the page waits, until the agent answers:
    accept [text]        OK (with the text, for a prompt)
    dismiss              Cancel
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
  model                  Show the downloaded model and whether a newer one exists
  model install [--yes]  Download the recommended model and llama.cpp's server
                         (asks first; --yes skips the question)
  model remove           Delete them

Training traces (opt-in, stay on this computer)
  trace start "<goal>"   Record each following command and what it printed, as an
                         example for training the local model; never text typed
                         into password fields or uploaded files' contents
  trace stop [done|failed] [answer]  Stop recording, with the outcome
  trace [list]           List traces          trace show <id>   Review one
  trace delete <id...>|--all          trace export [file]   JSONL for fine-tuning

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
  OPEN_EYES_MODEL_KEY    API key, if the endpoint needs one
  OPEN_EYES_MODEL_DEVICE GPU for the downloaded model, as llama-server
                         --list-devices names it (default: the dedicated one)`;

function format(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function print(value: unknown): void {
  const text = format(value);
  if (text) console.log(text);
}

/** The version in package.json, which is one folder up from both src/cli.ts and the built dist/cli.js. */
function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

const CONNECT_HELP = `no browser with remote debugging enabled was found.
In Chrome 144+ (or Chromium, Brave, Edge), type chrome://inspect/#remote-debugging in the
address bar, turn on remote debugging there, and run "open-eyes connect" again.`;

/**
 * Runs a page command and records what it printed, which is what the agent reads and pays
 * for in tokens. `label` names the command in `open-eyes usage`; it never holds typed text.
 */
/** Answers the open dialog; counted and traced like the page commands. */
async function withDialog(label: string, answer: () => Promise<string>): Promise<void> {
  const started = Date.now();
  let output = "";
  try {
    output = await answer();
    console.log(output);
  } catch (error) {
    output = `error: ${(error as Error).message}`;
    throw error;
  } finally {
    recordUsage(label, output, Date.now() - started);
    const trace = activeTrace();
    if (trace) recordStep(trace, { command: formatCommand(commandWords), output, ms: Date.now() - started });
  }
}

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
    const trace = activeTrace();
    if (trace) {
      // Uploaded files are recorded by name, and text typed into a password field not at all.
      const secret = connection?.page.typedSecret ?? false;
      const words = commandWords[0] === "upload" ? commandWords.map((word) => (/[\\/]/.test(word) ? basename(word) : word)) : commandWords;
      const command = secret ? `${words[0]} (typed into a password field, not stored)` : formatCommand(words);
      recordStep(trace, { command, output: secret ? "" : output, ms: Date.now() - started, ...(secret ? { secret } : {}) });
    }
    if (state.showTokens && connection) await connection.page.showUsage(usageSummary(entry)).catch(() => {});
    connection?.cdp.close();
    saveState(state); // Also when connecting failed: it may have learned the daemon is gone.
  }
}

/** The command as typed, for traces; args are consumed while parsing. */
let commandWords: string[] = [];

async function main([command, ...args]: string[]): Promise<void> {
  commandWords = [command, ...args];
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
    case "__dialogs": // Started by page commands; not for direct use.
      return runWatcher(need(args[0], "__dialogs <endpoint> <target>"), need(args[1], "__dialogs <endpoint> <target>"));
    case "dialog": {
      const action = args.shift();
      if (action === undefined) {
        const dialog = openDialog(loadState().targetId);
        return print(dialog ? describeDialog(dialog) : "no dialog is open");
      }
      if (action !== "accept" && action !== "dismiss") throw new Error("usage: open-eyes dialog [accept [text] | dismiss]");
      const text = args.length ? args.join(" ") : undefined;
      if (action === "dismiss" && text !== undefined) throw new Error("dismiss takes no text; use accept <text> to answer a prompt");
      return withDialog(`dialog ${action}`, async () => {
        const dialog = await answerDialog(action === "accept", text);
        audit({ action: "dialog", target: `${action} ${dialog.type} ${JSON.stringify(dialog.message)}`, outcome: "ok" });
        const verb = action === "dismiss" ? "dismissed" : dialog.type === "alert" ? "closed" : "accepted";
        const typed = text !== undefined && dialog.type === "prompt" ? ` with ${JSON.stringify(text)}` : "";
        return `${verb} the ${dialog.type} ${JSON.stringify(dialog.message)}${typed}; run "open-eyes snapshot" to see the page`;
      });
    }
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
      // Your own endpoint first; otherwise the downloaded model, started for this run.
      let endpoint = modelEndpoint();
      let stop = () => {};
      if (!endpoint) {
        const installed = installedNavigator();
        if (!installed) throw new Error(NO_MODEL);
        console.error("starting the local model...");
        ({ endpoint, stop } = await startNavigator(installed));
      }
      try {
        return await withPage("do", (page) => navigate(page, goal, endpoint, { steps, timeout }));
      } finally {
        stop();
      }
    }
    case "model": {
      const action = args[0];
      if (action === undefined || action === "status") {
        const own = modelEndpoint();
        return print(`${own ? `endpoint: ${own.url} (OPEN_EYES_MODEL_URL), used by "do" first\n` : ""}${navigatorStatus(MANIFEST)}`);
      }
      if (action === "remove") {
        rmSync(modelsDir, { recursive: true, force: true });
        return print(`deleted ${modelsDir}`);
      }
      if (action !== "install") throw new Error(`unknown model action "${action}"; see "open-eyes help"`);
      const server = serverFor(MANIFEST);
      const { model } = MANIFEST;
      console.error(
        [
          "open-eyes will download:",
          `  ${model.name}, ${formatSize(model.size)}, license: ${model.license}`,
          ...(server ? [`  llama.cpp server (${server.id}), ${formatSize(server.size)}`] : []),
          `into ${modelsDir}`,
        ].join("\n"),
      );
      if (!takeFlag(args, "--yes")) {
        // An agent cannot answer this; only the user should agree to a download this big.
        if (!process.stdin.isTTY) throw new Error('run "open-eyes model install --yes" yourself to confirm the download');
        const prompt = createInterface({ input: process.stdin, output: process.stderr });
        const answer = await prompt.question("Download? [y/N] ");
        prompt.close();
        if (!/^y(es)?$/i.test(answer.trim())) return print("nothing downloaded");
      }
      let shown = "";
      const installed = await installNavigator(MANIFEST, modelsDir, (what, done, total) => {
        const line = `${what}: ${Math.floor((done / total) * 100)}%`;
        if (line !== shown && process.stderr.isTTY) process.stderr.write(`\r${(shown = line)}`);
      });
      if (shown) process.stderr.write("\n");
      return print(`installed ${installed.model}; "open-eyes do" now uses it`);
    }
    case "trace": {
      const [action, ...rest] = args;
      if (action === "start") {
        const id = startTrace(need(rest.join(" ").trim() || undefined, 'trace start "<goal>"'));
        return print(
          `recording trace ${id}: each open-eyes command and what it printed, never text typed into\npassword fields or the contents of uploaded files. It stays in ${tracesDir}.\nEnd it with "open-eyes trace stop [done|failed] [answer]".`,
        );
      }
      if (action === "stop") {
        const outcome = rest[0] === "failed" ? "failed" : "done";
        if (rest[0] === "done" || rest[0] === "failed") rest.shift();
        const trace = stopTrace(outcome, rest.join(" ").trim());
        return print(`stopped trace ${trace.id}: ${trace.outcome}, ${trace.steps.length} commands`);
      }
      if (action === "show") {
        const trace = readTrace(need(rest[0], "trace show <id>"));
        const lines = [`goal: ${trace.goal}`, `outcome: ${trace.outcome ?? "recording"}${trace.answer ? ` (${trace.answer})` : ""}`];
        for (const step of trace.steps) lines.push("", `$ open-eyes ${step.command}`, ...(step.output ? [step.output] : []));
        return print(lines.join("\n"));
      }
      if (action === "delete") {
        const count = deleteTraces(rest[0] === "--all" ? "all" : rest.length ? rest : [need(undefined, "trace delete <id...>|--all")]);
        return print(`deleted ${count} trace${count === 1 ? "" : "s"}`);
      }
      if (action === "export") {
        const examples: string[] = [];
        const skipped: string[] = [];
        for (const trace of listTraces()) {
          const example = toExample(trace);
          if ("skipped" in example) skipped.push(`  ${trace.id}: ${example.skipped}`);
          else examples.push(JSON.stringify(example));
        }
        const jsonl = examples.map((line) => `${line}\n`).join("");
        if (rest[0]) writeFileSync(rest[0], jsonl, { mode: 0o600 });
        else process.stdout.write(jsonl);
        console.error([`exported ${examples.length} traces${rest[0] ? ` to ${rest[0]}` : ""}`, ...(skipped.length ? [`skipped ${skipped.length}:`, ...skipped] : [])].join("\n"));
        return;
      }
      if (action !== undefined && action !== "list") throw new Error(`unknown trace action "${action}"; see "open-eyes help"`);
      const traces = listTraces();
      const recording = activeTrace();
      if (!traces.length) return print('no traces; start one with open-eyes trace start "<goal>"');
      return print(
        traces
          .map((t) => `${t.id}  ${(t.id === recording ? "recording" : (t.outcome ?? "unfinished")).padEnd(10)} ${String(t.steps.length).padStart(3)} commands  ${t.goal}`)
          .join("\n"),
      );
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
    case "version":
    case "--version":
      return print(packageVersion());
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
