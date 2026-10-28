import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CDP } from "./cdp.ts";
import { ensureWatcher } from "./dialogs.ts";
import { Page } from "./page.ts";
import { isAlive, profileDir, socketPath, stateDir, type State } from "./state.ts";

const BROWSER_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "brave",
  "brave-browser",
  "microsoft-edge",
];
const MAC_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

const LAUNCH_TIMEOUT_MS = 30_000;
/** How long `connect` waits for the user to approve the browser's permission prompt. */
const CONNECT_TIMEOUT_MS = 120_000;

/** Everyday-profile directories, where a browser with remote debugging on writes DevToolsActivePort. */
function profileDirs(): Record<string, string[]> {
  const home = homedir();
  if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return {
      chrome: [join(support, "Google", "Chrome")],
      chromium: [join(support, "Chromium")],
      brave: [join(support, "BraveSoftware", "Brave-Browser")],
      edge: [join(support, "Microsoft Edge")],
    };
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return {
      chrome: [join(local, "Google", "Chrome", "User Data")],
      chromium: [join(local, "Chromium", "User Data")],
      brave: [join(local, "BraveSoftware", "Brave-Browser", "User Data")],
      edge: [join(local, "Microsoft", "Edge", "User Data")],
    };
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return {
    chrome: [join(config, "google-chrome"), join(config, "google-chrome-beta")],
    chromium: [join(config, "chromium")],
    brave: [join(config, "BraveSoftware", "Brave-Browser")],
    edge: [join(config, "microsoft-edge")],
  };
}

/** Reads a DevToolsActivePort file ("<port>\n/devtools/browser/<id>") into a WebSocket URL. */
export function readDevToolsActivePort(dir: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(join(dir, "DevToolsActivePort"), "utf8");
  } catch {
    return undefined;
  }
  const [port, path] = content.split(/\r?\n/);
  if (!/^\d{1,5}$/.test(port) || !/^\/devtools\/browser\/[\w-]+$/.test(path ?? "")) return undefined;
  return `ws://127.0.0.1:${port}${path}`;
}

/** The user's everyday browser, if remote debugging is enabled in it. */
export function findEverydayBrowser(name?: string): { name: string; url: string } | undefined {
  const dirs = profileDirs();
  if (name && !dirs[name]) throw new Error(`unknown browser "${name}"; use one of: ${Object.keys(dirs).join(", ")}`);
  for (const [browser, candidates] of Object.entries(dirs)) {
    if (name && browser !== name) continue;
    for (const dir of candidates) {
      const url = readDevToolsActivePort(dir);
      if (url) return { name: browser, url };
    }
  }
  return undefined;
}

/** Whether `url` is a DevTools WebSocket on this machine (and on `port`, if given). */
export function isLocalDevToolsUrl(url: string, port?: number): boolean {
  const ws = URL.parse(url);
  return (
    ws?.protocol === "ws:" &&
    ["127.0.0.1", "localhost"].includes(ws.hostname) &&
    (port === undefined || ws.port === String(port))
  );
}

export type BrowserVersion = { Browser: string; webSocketDebuggerUrl: string };

export function findBrowser(): string | undefined {
  if (process.env.OPEN_EYES_BROWSER) return process.env.OPEN_EYES_BROWSER;
  const dirs = (process.env.PATH ?? "").split(delimiter);
  for (const name of BROWSER_NAMES) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return MAC_BROWSERS.find((path) => existsSync(path));
}

export async function browserVersion(port: number): Promise<BrowserVersion | undefined> {
  let version: BrowserVersion;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) return undefined;
    version = (await response.json()) as BrowserVersion;
  } catch {
    return undefined;
  }
  // Only ever open a DevTools connection to the local browser we just asked.
  if (!isLocalDevToolsUrl(version.webSocketDebuggerUrl ?? "", port)) {
    throw new Error(`port ${port} answered with an unexpected DevTools endpoint`);
  }
  return version;
}

/** Starts a browser with its own open-eyes profile and remote debugging on `port`. */
export async function launch(
  port: number,
  { headless = false } = {},
): Promise<{ binary: string; alreadyRunning: boolean }> {
  if (await browserVersion(port)) return { binary: "", alreadyRunning: true };
  const binary = findBrowser();
  if (!binary) throw new Error("no Chromium-based browser found; set OPEN_EYES_BROWSER to its path");

  mkdirSync(profileDir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (headless) args.push("--headless=new");
  const child = spawn(binary, args, { detached: true, stdio: "ignore" });
  let spawnError: Error | undefined;
  child.once("error", (error) => (spawnError = error));
  child.unref();

  // A cold start can take well over 10s on a busy machine or CI runner.
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`could not start ${binary}: ${spawnError.message}`);
    if (await browserVersion(port)) return { binary, alreadyRunning: false };
    await sleep(200);
  }
  throw new Error(`${binary} started but is not answering on port ${port} after ${LAUNCH_TIMEOUT_MS / 1000}s`);
}

/** The connection to use: the daemon while connected to the user's browser, else the launched one. */
async function browserEndpoint(state: State): Promise<string> {
  if (state.daemonPid) {
    if (isAlive(state.daemonPid)) return `unix:${socketPath}`;
    Object.assign(state, { daemonPid: undefined, targetId: undefined, refs: {} });
    throw new Error('the connection to your browser was closed; run "open-eyes connect" again');
  }
  const version = await browserVersion(state.port);
  if (!version) throw new Error(`no browser on port ${state.port}; run "open-eyes launch" or "open-eyes connect" first`);
  return version.webSocketDebuggerUrl;
}

/**
 * Connects to the user's everyday browser at `endpoint` through a background daemon that
 * holds the one approved connection. Returns the browser's name and version.
 */
export async function connectBrowser(state: State, endpoint: string): Promise<string> {
  if (!isLocalDevToolsUrl(endpoint)) throw new Error(`refusing to connect to non-local endpoint ${endpoint}`);
  if (state.daemonPid && isAlive(state.daemonPid)) {
    throw new Error('already connected to a browser; run "open-eyes disconnect" first');
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const log = openSync(join(stateDir, "daemon.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "__daemon", endpoint], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log); // The daemon has its own copy.
  let exited = false;
  child.once("exit", () => (exited = true));

  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`the browser refused or closed the connection; details in ${join(stateDir, "daemon.log")}`);
    }
    try {
      const cdp = await CDP.connect(`unix:${socketPath}`);
      try {
        const { product } = await cdp.send<{ product: string }>("Browser.getVersion");
        child.unref();
        Object.assign(state, { daemonPid: child.pid, targetId: undefined, refs: {}, refsLoaderId: undefined });
        return product;
      } finally {
        cdp.close();
      }
    } catch {
      await sleep(250); // The daemon is still waiting for the user's approval.
    }
  }
  child.kill();
  throw new Error(`the connection was not approved within ${CONNECT_TIMEOUT_MS / 1000}s`);
}

/** Closes the agent window in the user's browser and stops the daemon. */
export async function disconnectBrowser(state: State): Promise<boolean> {
  const pid = state.daemonPid;
  if (!pid || !isAlive(pid)) {
    state.daemonPid = undefined;
    return false;
  }
  await closeAgentWindow(state);
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(100);
  state.daemonPid = undefined;
  return true;
}

/** The URLs of the browser's open pages, by target id. */
export async function openPages(state: State): Promise<Map<string, string>> {
  const cdp = await CDP.connect(await browserEndpoint(state));
  try {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    return new Map(targetInfos.filter((t) => t.type === "page").map((t) => [t.targetId, t.url]));
  } finally {
    cdp.close();
  }
}

/** Connects to the browser and attaches to the agent's window, opening one if needed. */
export async function connectPage(state: State): Promise<{ cdp: CDP; page: Page }> {
  const { cdp, page } = await connectExistingPage(state);
  if (page) return { cdp, page };
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  Object.assign(state, { targetId, refs: {} });
  return { cdp, page: await attach(cdp, await browserEndpoint(state), targetId, state) };
}

/** Like connectPage, but never opens a window: `page` is undefined when there is none. */
export async function connectExistingPage(state: State): Promise<{ cdp: CDP; page?: Page }> {
  const endpoint = await browserEndpoint(state);
  const cdp = await CDP.connect(endpoint);
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>(
    "Target.getTargets",
  );
  const { targetId } = state;
  if (!targetId || !targetInfos.some((t) => t.targetId === targetId && t.type === "page")) {
    Object.assign(state, { targetId: undefined, refs: {} });
    return { cdp };
  }
  return { cdp, page: await attach(cdp, endpoint, targetId, state) };
}

async function attach(cdp: CDP, endpoint: string, targetId: string, state: State): Promise<Page> {
  await ensureWatcher(endpoint, targetId); // Sees the dialogs the page opens, between commands too.
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, sessionId, state);
  await page.init();
  return page;
}

export async function closeAgentWindow(state: State): Promise<boolean> {
  if (!state.targetId) return false;
  const endpoint = await browserEndpoint(state).catch(() => undefined);
  if (!endpoint) return false;
  const cdp = await CDP.connect(endpoint);
  try {
    await cdp.send("Target.closeTarget", { targetId: state.targetId });
    return true;
  } catch {
    return false;
  } finally {
    state.targetId = undefined;
    state.refs = {};
    cdp.close();
  }
}
