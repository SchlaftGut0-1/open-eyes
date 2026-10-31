import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import { CDP } from "../../../src/cdp.ts";

const BROWSER = join(
  process.env.OPEN_EYES_CHROMIUM_BUILD ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "open-eyes-browser"),
  "src",
  "out",
  "Default",
  "chrome",
);
const root = mkdtempSync(join(tmpdir(), "open-eyes-chromium-"));
const profile = join(root, "browser");
const CLI = join(import.meta.dirname, "..", "..", "..", "src", "cli.ts");
const PAGE = pathToFileURL(join(import.meta.dirname, "fixtures", "webdriver.html")).href;
const env = {
  ...process.env,
  OPEN_EYES_BROWSER_PROFILE: profile,
  OPEN_EYES_PORT: String(9900 + Math.floor(Math.random() * 90)),
  OPEN_EYES_SLOWMO: "0",
  OPEN_EYES_CONFIRM: "never",
  XDG_STATE_HOME: join(root, "state"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CONFIG_HOME: join(root, "config"),
};
const cli = async (...args: string[]) => (await promisify(execFile)(process.execPath, [CLI, ...args], { env })).stdout.trim();
const socket = join(
  process.env.XDG_RUNTIME_DIR ?? profile,
  `open-eyes-browser-${createHash("sha256").update(profile).digest("hex").slice(0, 12)}.sock`,
);

describe("the CLI drives open-eyes Browser built on Chromium", { skip: !existsSync(BROWSER) && `no build at ${BROWSER}` }, () => {
  let browser: ChildProcess;

  before(async () => {
    browser = spawn(BROWSER, [`--user-data-dir=${profile}`, "--ozone-platform=headless", "--window-size=1280,800", "--no-first-run", PAGE], { env, stdio: "ignore" });
    for (let i = 0; i < 200 && !(await cli("status")).startsWith("browser: open-eyes Browser"); i++) await sleep(100);
  });

  after(async () => {
    if (browser && browser.exitCode === null) {
      const exited = new Promise((resolve) => browser.once("exit", resolve));
      browser.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("status names it, and page commands use it without flags", async () => {
    assert.match(await cli("status"), /^browser: open-eyes Browser\nagent window: none/);
    await cli("open", PAGE);
    assert.match(await cli("snapshot"), /Hello/);
    assert.match(await cli("status"), /agent window: file:.*webdriver\.html/);
  });

  test("only the agent's tab says it is automated, and no DevTools port is open", async () => {
    assert.equal(await cli("eval", "localStorage.getItem('user') + ' ' + navigator.webdriver"), "false true");
    assert.equal(existsSync(join(profile, "DevToolsActivePort")), false);
  });

  test("the agent sees only its own tabs, cannot reach the user's, and closes its own", async () => {
    const cdp = await CDP.connect(`unix:${socket}`);
    try {
      const targets = async () => (await cdp.send<{ targetInfos: { url: string }[] }>("Target.getTargets")).targetInfos.map((t) => t.url);
      assert.deepEqual(await targets(), [PAGE], "the user's own tab with the same page stays hidden");
      await assert.rejects(cdp.send("Target.attachToTarget", { targetId: "0".repeat(32), flatten: true }), /No target with given id found/);
      await assert.rejects(cdp.send("Browser.close"), /not available in open-eyes Browser/);
      assert.equal(await cli("close"), "closed the agent window");
      assert.deepEqual(await targets(), []);
    } finally {
      cdp.close();
    }
  });

  test("the socket is private", () => {
    assert.equal(statSync(socket).mode & 0o777, 0o600);
  });
});
