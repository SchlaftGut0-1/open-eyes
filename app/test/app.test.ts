import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  test("a new tab shows our own page, and a pinned tab moves to the front", async () => {
    const ui = (await pages()).find((t) => t.url.endsWith("/ui/index.html"))!;
    const before = (await tabs()).length;
    await evaluate(ui, "window.browser.send({ type: 'newTab' })");
    await until(async () => (await tabs()).some((t) => t.url.endsWith("/newtab/index.html")));
    assert.equal((await tabs()).length, before + 1);
    const titles = () => evaluate(ui, "[...document.querySelectorAll('.tab')].map((t) => t.className + ' ' + t.title)") as Promise<string[]>;
    await evaluate(ui, "document.querySelectorAll('.tab')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))");
    await until(async () => (await titles())[0].startsWith("tab pinned"));
    assert.equal((await titles()).filter((t) => t.startsWith("tab pinned")).length, 1);
    assert.equal((await evaluate(ui, "document.getElementById('address').value")), "", "the new tab page shows no address");
  });

  test("each space has its own tabs and its own site data, and is saved", async () => {
    const ui = (await pages()).find((t) => t.url.endsWith("/ui/index.html"))!;
    await until(async () => (await tabs()).some((t) => t.url === FIRST));
    const firstTab = (await tabs()).find((t) => t.url === FIRST)!;
    await evaluate(firstTab, "localStorage.setItem('who', 'first space'); true");
    await evaluate(ui, "window.browser.send({ type: 'newSpace', name: 'Work', color: '#0d9488' })");
    await until(async () => String(await evaluate(ui, "document.getElementById('space-current').title")).startsWith("Work"));
    assert.equal(await evaluate(ui, "document.querySelectorAll('.tab').length"), 1, "a new space starts with one tab");
    // The Work space's tab is the one that reaches the same page now.
    const before = new Set((await tabs()).filter((t) => t.url === FIRST).map((t) => t.targetId));
    await evaluate(ui, `window.browser.send({ type: 'navigate', input: ${JSON.stringify(FIRST)} })`);
    let workTab: Target | undefined;
    await until(async () => (workTab = (await tabs()).find((t) => t.url === FIRST && !before.has(t.targetId))) !== undefined);
    assert.equal(await evaluate(workTab!, "localStorage.getItem('who')"), null, "the Work space does not see the first space's data");
    // Saved half a second after the last change.
    await until(async () => existsSync(join(profile, "spaces.json")) && readFileSync(join(profile, "spaces.json"), "utf8").includes('"Work"'));
    const saved = JSON.parse(readFileSync(join(profile, "spaces.json"), "utf8"));
    assert.deepEqual(saved.spaces.map((s: { name: string }) => s.name), ["Personal", "Work"]);
  });

  test("sign-in works as in Chrome: no Electron in the user agent, and popups keep their opener", async () => {
    await until(async () => (await tabs()).some((t) => t.url === FIRST));
    const tab = (await tabs()).find((t) => t.url === FIRST)!;
    assert.doesNotMatch(String(await evaluate(tab, "navigator.userAgent")), /Electron|open-eyes/);
    // A sized window.open, as "Sign in with ..." buttons do, reports back to the page that opened it.
    const before = new Set((await pages()).map((t) => t.targetId));
    await evaluate(tab, `window.addEventListener("message", (e) => (document.title = "signed in: " + e.data)); window.open(${JSON.stringify(fixture("second.html"))}, "signin", "popup,width=420,height=560"); true`);
    let popup: Target | undefined;
    await until(async () => (popup = (await pages()).find((t) => t.url === fixture("second.html") && !before.has(t.targetId))) !== undefined);
    await evaluate(popup!, "window.opener.postMessage('ok', '*'); true");
    await until(async () => (await evaluate(tab, "document.title")) === "signed in: ok");
    assert.equal(await evaluate(tab, "document.title"), "signed in: ok");
  });
});
