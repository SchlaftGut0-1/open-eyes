import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CDP } from "./cdp.ts";
import { ensureWatcher } from "./dialogs.ts";
import { Page } from "./page.ts";
import { forgetSpace, isAlive, loadState, profileDir, socketPath, space, spaces, stateDir, type State } from "./state.ts";

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

/** open-eyes Browser's profile, where the Chromium build in packages/browser keeps it. */
const appProfile = process.env.OPEN_EYES_BROWSER_PROFILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "open-eyes-browser");

/** Where open-eyes Browser listens for agents (#179). */
function appSocketPath(): string {
  const id = createHash("sha256").update(appProfile).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\open-eyes-browser-${id}`;
  return join(process.env.XDG_RUNTIME_DIR ?? appProfile, `open-eyes-browser-${id}.sock`);
}

const appEndpointUrl = () => `unix:${appSocketPath()}`;

export async function appEndpoint(): Promise<string | undefined> {
  const endpoint = appEndpointUrl();
  try {
    (await CDP.connect(endpoint)).close();
    return endpoint;
  } catch {
    return undefined;
  }
}

export const APP_CLOSED = 'open-eyes Browser is closed; open it, or run "open-eyes launch" or "open-eyes connect"';
export const appInstalled = () => existsSync(appProfile);

const LAUNCH_TIMEOUT_MS = 30_000;

// shortcut: only finds a local packages/browser build, until installable builds ship (#187).
function appBinary(): string | undefined {
  const build = process.env.OPEN_EYES_CHROMIUM_BUILD ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "open-eyes-browser");
  const binary = join(build, "src", "out", "Default", "chrome");
  return existsSync(binary) ? binary : undefined;
}

export async function launchApp(): Promise<"running" | "launched" | "not-installed"> {
  if (await appEndpoint()) return "running";
  const binary = appBinary();
  if (!binary) return "not-installed";
  spawn(binary, [`--user-data-dir=${appProfile}`], { detached: true, stdio: "ignore" }).unref();
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await appEndpoint()) return "launched";
    await sleep(200);
  }
  throw new Error(`open-eyes Browser started but is not taking agents after ${LAUNCH_TIMEOUT_MS / 1000}s`);
}

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

/** The connection to use: the daemon while connected to the user's browser, else the launched one, else open-eyes Browser. */
async function browserEndpoint(state: State): Promise<string> {
  if (state.daemonPid) {
    if (isAlive(state.daemonPid)) return `unix:${socketPath}`;
    Object.assign(state, { daemonPid: undefined, targetId: undefined, refs: {} });
    throw new Error('the connection to your browser was closed; run "open-eyes connect" again');
  }
  const version = await browserVersion(state.port);
  if (version) return version.webSocketDebuggerUrl;
  const app = await appEndpoint();
  if (app) return app;
  if (appInstalled()) throw new Error(APP_CLOSED);
  throw new Error(`no browser on port ${state.port}; run "open-eyes launch" or "open-eyes connect" first`);
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

/** Closes every space's agent window in the user's browser and stops the daemon. */
export async function disconnectBrowser(state: State): Promise<boolean> {
  const pid = state.daemonPid;
  if (!pid || !isAlive(pid)) {
    state.daemonPid = undefined;
    return false;
  }
  // No space may leave a window behind in the user's browser; the other spaces are forgotten.
  for (const name of spaces().filter((name) => name !== space())) {
    await closeAgentWindow(loadState(name));
    if (name !== "default") forgetSpace(name);
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

export async function connectPage(state: State): Promise<{ cdp: CDP; page: Page }> {
  const { cdp, page } = await connectExistingPage(state);
  if (page) return { cdp, page };
  const endpoint = await browserEndpoint(state);
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
    newWindow: endpoint !== appEndpointUrl(),
  });
  Object.assign(state, { targetId, refs: {} });
  return { cdp, page: await attach(cdp, endpoint, targetId, state) };
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
  const page = new Page(cdp, sessionId, state, endpoint === appEndpointUrl());
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
