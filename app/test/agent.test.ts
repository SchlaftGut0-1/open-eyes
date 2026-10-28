import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import electron from "electron";
import { CDP } from "../../src/cdp.ts";
import { agentSocketPath } from "../src/agent.ts";

const root = mkdtempSync(join(tmpdir(), "open-eyes-agent-"));
const profile = join(root, "browser");
const APP = join(import.meta.dirname, "..");
const CLI = join(APP, "..", "src", "cli.ts");
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

describe("the CLI drives open-eyes Browser", () => {
  let app: ChildProcess;

  before(async () => {
    app = spawn(electron as unknown as string, [APP, "--ozone-platform=headless", PAGE], { env, stdio: "ignore" });
    for (let i = 0; i < 100 && !(await cli("status")).startsWith("browser: open-eyes Browser"); i++) await sleep(100);
  });

  after(() => {
    app?.kill();
    rmSync(root, { recursive: true, force: true });
  });

  test("status names it, and page commands use it without flags", async () => {
    assert.match(await cli("status"), /^browser: open-eyes Browser\nagent window: none/);
    await cli("open", PAGE);
    assert.match(await cli("snapshot"), /Hello/);
    assert.match(await cli("status"), /agent window: file:.*webdriver\.html/);
  });

  test("only the agent's tab says it is automated, and the app opens no DevTools port", async () => {
    assert.equal(await cli("eval", "localStorage.getItem('user') + ' ' + navigator.webdriver"), "false true");
    assert.equal(existsSync(join(profile, "DevToolsActivePort")), false);
  });

  test("the agent sees only its own tabs, and closes them", async () => {
    const cdp = await CDP.connect(`unix:${agentSocketPath(profile)}`);
    const targets = async () => (await cdp.send<{ targetInfos: { url: string }[] }>("Target.getTargets")).targetInfos.map((t) => t.url);
    try {
      assert.deepEqual(await targets(), [PAGE], "the user's own tab with the same page stays hidden");
      assert.equal(await cli("close"), "closed the agent window");
      assert.deepEqual(await targets(), []);
    } finally {
      cdp.close();
    }
    assert.match(await cli("status"), /agent window: none/);
  });

  test("a closed app is named in the error", async () => {
    const exited = new Promise((resolve) => app.once("exit", resolve));
    app.kill("SIGTERM");
    await exited;
    await assert.rejects(cli("snapshot"), /open-eyes Browser is closed; open it/);
  });
});
