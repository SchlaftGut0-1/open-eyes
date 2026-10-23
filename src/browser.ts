import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CDP } from "./cdp.ts";
import { Page } from "./page.ts";
import { profileDir, type State } from "./state.ts";

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
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    return response.ok ? ((await response.json()) as BrowserVersion) : undefined;
  } catch {
    return undefined;
  }
}

/** Starts a visible browser with its own open-eyes profile and remote debugging on `port`. */
export async function launch(port: number): Promise<{ binary: string; alreadyRunning: boolean }> {
  if (await browserVersion(port)) return { binary: "", alreadyRunning: true };
  const binary = findBrowser();
  if (!binary) throw new Error("no Chromium-based browser found; set OPEN_EYES_BROWSER to its path");

  mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  for (let attempt = 0; attempt < 50; attempt++) {
    if (await browserVersion(port)) return { binary, alreadyRunning: false };
    await sleep(200);
  }
  throw new Error(`${binary} started but is not answering on port ${port}`);
}

/** Connects to the browser and attaches to the agent's window, opening one if needed. */
export async function connectPage(state: State): Promise<{ cdp: CDP; page: Page }> {
  const version = await browserVersion(state.port);
  if (!version) throw new Error(`no browser on port ${state.port}; run "open-eyes launch" first`);
  const cdp = await CDP.connect(version.webSocketDebuggerUrl);

  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>(
    "Target.getTargets",
  );
  let targetId = state.targetId;
  if (!targetId || !targetInfos.some((t) => t.targetId === targetId && t.type === "page")) {
    ({ targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    }));
    state.targetId = targetId;
    state.refs = {};
  }

  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const page = new Page(cdp, sessionId, state);
  await page.init();
  return { cdp, page };
}

export async function closeAgentWindow(state: State): Promise<boolean> {
  const version = await browserVersion(state.port);
  if (!version || !state.targetId) return false;
  const cdp = await CDP.connect(version.webSocketDebuggerUrl);
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
