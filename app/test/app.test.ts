import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import electron from "electron";
import { CDP } from "../../src/cdp.ts";

const profile = mkdtempSync(join(tmpdir(), "open-eyes-browser-"));
const APP = join(import.meta.dirname, "..");
const fixture = (name: string) => pathToFileURL(join(APP, "..", "test", "fixtures", name)).href;
const FIRST = fixture("form.html");

type Target = { targetId: string; type: string; url: string };

describe("open-eyes Browser", () => {
  let app: ChildProcess;
  let endpoint = "";
  let cdp: CDP;

  const pages = async () => ((await cdp.send<{ targetInfos: Target[] }>("Target.getTargets")).targetInfos).filter((t) => t.type === "page");
  const tabs = async () => (await pages()).filter((t) => !t.url.endsWith("/ui/index.html"));
  const evaluate = async (target: Target, expression: string) => {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const { result } = await cdp.send<{ result: { value: unknown } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    await cdp.send("Target.detachFromTarget", { sessionId });
    return result.value;
  };
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 50 && !(await check()); i++) await sleep(100);
  };

  before(async () => {
    app = spawn(electron as unknown as string, [APP, "--ozone-platform=headless", FIRST], {
      env: { ...process.env, OPEN_EYES_BROWSER_PROFILE: profile },
      stdio: "ignore",
    });
    for (let i = 0; i < 100 && !endpoint; i++) {
      try {
        const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
        endpoint = `ws://127.0.0.1:${port}${path}`;
      } catch {
        await sleep(100);
      }
    }
    cdp = await CDP.connect(endpoint);
    await until(async () => (await tabs()).length === 1);
  });

  after(() => {
    cdp?.close();
    app?.kill();
    rmSync(profile, { recursive: true, force: true });
  });

  test("listens for DevTools on this machine only, and opens the first tab", async () => {
    // Loopback answers; this machine's address on the network does not.
    const port = new URL(endpoint).port;
    assert.ok((await fetch(`http://127.0.0.1:${port}/json/version`)).ok);
    const lan = Object.values(networkInterfaces()).flat().find((a) => a?.family === "IPv4" && !a.internal)?.address;
    if (lan) await assert.rejects(fetch(`http://${lan}:${port}/json/version`));
    const [tab] = await tabs();
    assert.equal(tab.url, FIRST);
  });

  test("a page cannot reach the app or open the browser's own pages", async () => {
    const [tab] = await tabs();
    assert.equal(await evaluate(tab, "typeof window.browser + typeof require + typeof process"), "undefinedundefinedundefined");
    const ui = (await pages()).find((t) => t.url.endsWith("/ui/index.html"))!;
    assert.equal(await evaluate(ui, "typeof window.browser + typeof require"), "objectundefined", "the UI gets the bridge, never Node");
    await evaluate(tab, "location.href = 'chrome://settings'").catch(() => {}); // The page goes away.
    await sleep(500);
    assert.doesNotMatch((await tabs())[0].url, /^chrome:/);
  });

  test("a page's new window opens as a tab", async () => {
    const tab = (await tabs())[0];
    await evaluate(tab, `location.href = ${JSON.stringify(FIRST)}`).catch(() => {});
    await until(async () => (await tabs())[0].url === FIRST);
    await evaluate(tab, `window.open(${JSON.stringify(fixture("second.html"))}); true`);
    await until(async () => (await tabs()).length === 2);
    assert.deepEqual((await tabs()).map((t) => t.url).sort(), [FIRST, fixture("second.html")].sort());
  });
});
