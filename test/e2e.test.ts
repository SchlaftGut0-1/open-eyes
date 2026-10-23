import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { browserVersion, findBrowser } from "../src/browser.ts";
import { CDP } from "../src/cdp.ts";

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const fixture = (name: string) => pathToFileURL(join(import.meta.dirname, "fixtures", name)).href;

const root = mkdtempSync(join(tmpdir(), "open-eyes-e2e-"));
const port = 9400 + Math.floor(Math.random() * 500);
const env = {
  ...process.env,
  OPEN_EYES_PORT: String(port),
  OPEN_EYES_SLOWMO: "0",
  XDG_STATE_HOME: join(root, "state"),
  XDG_DATA_HOME: join(root, "data"),
};

async function cli(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env });
  return stdout.trim();
}

async function cliError(...args: string[]): Promise<string> {
  try {
    await cli(...args);
  } catch (error) {
    return (error as { stderr: string }).stderr.trim();
  }
  throw new Error(`expected "open-eyes ${args.join(" ")}" to fail`);
}

const refOf = (snapshot: string, entry: string) => {
  const line = snapshot.split("\n").find((l) => l.includes(entry));
  const ref = line?.match(/@\d+$/)?.[0];
  if (!ref) throw new Error(`no ref for ${entry} in:\n${snapshot}`);
  return ref;
};

async function until<T>(check: () => Promise<T>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Acts as the human: a separate DevTools connection to the agent window with real clicks. */
async function humanAt(): Promise<{
  evaluate: (expression: string) => Promise<any>;
  click: (part: string) => Promise<void>;
  navigate: (url: string) => Promise<void>;
  close: () => void;
}> {
  const { targetId } = JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "open-eyes", "state.json"), "utf8"));
  const cdp = await CDP.connect((await browserVersion(port))!.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression: string) =>
    (await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
  const part = (name: string) =>
    `document.getElementById("__open_eyes__")?.shadowRoot.querySelector('[data-part="${name}"]')`;
  return {
    evaluate,
    async click(name) {
      const point = await until(
        () => evaluate(`(() => { const el = ${part(name)}; if (!el?.checkVisibility()) return null;
          const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`),
        `the overlay "${name}" button`,
      );
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 }, sessionId);
      }
    },
    async navigate(url) {
      await cdp.send("Page.navigate", { url }, sessionId);
      await until(() => evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === "complete"`), url);
    },
    close: () => cdp.close(),
  };
}

describe("open-eyes against a real browser", { skip: findBrowser() ? false : "no Chromium-based browser" }, () => {
  before(() => cli("launch", "--headless"));

  after(async () => {
    const version = await browserVersion(port);
    if (version) {
      const cdp = await CDP.connect(version.webSocketDebuggerUrl);
      await cdp.send("Browser.close").catch(() => {}); // The connection drops as it closes.
      cdp.close();
      // Chromium keeps writing its profile while shutting down; wait before deleting it.
      for (let i = 0; i < 50 && (await browserVersion(port)); i++) await sleep(100);
      await sleep(500);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test("snapshot lists the page with refs, without the overlay", async () => {
    await cli("open", fixture("form.html"));
    const snapshot = await cli("snapshot");
    assert.match(snapshot, /^title: "Test form"$/m);
    assert.match(snapshot, /- heading "Sign up"/);
    assert.match(snapshot, /- textbox "Name" @\d+/);
    assert.match(snapshot, /- link "Next page" @\d+/);
    const body = snapshot.split("\n\n")[1];
    assert.doesNotMatch(body, /open-eyes/, "the overlay must stay out of the snapshot");
  });

  test("fill, check and click drive the page", async () => {
    const snapshot = await cli("snapshot");
    await cli("fill", refOf(snapshot, 'textbox "Name"'), "Ana");
    await cli("click", refOf(snapshot, 'checkbox "Accept terms"'));
    await cli("click", refOf(snapshot, 'button "Send"'));
    assert.equal(await cli("eval", "document.getElementById('out').textContent"), "Hello, Ana (accepted)");
  });

  test("refs from a page that is gone are rejected", async () => {
    const snapshot = await cli("snapshot");
    const name = refOf(snapshot, 'textbox "Name"');
    await cli("click", refOf(snapshot, 'link "Next page"'));
    assert.match(await cliError("fill", name, "x"), /no longer loaded/);
    assert.match(await cliError("click", "@999"), /unknown ref/);
  });

  test("run executes a multi-step script", async () => {
    const script = join(root, "script.js");
    writeFileSync(
      script,
      `await page.goto(${JSON.stringify(fixture("second.html"))});
       const snap = await page.snapshot();
       await page.fill(snap.match(/textbox "Search" (@\\d+)/)[1], "open-eyes");
       return page.eval("document.querySelector('input').value");`,
    );
    assert.equal(await cli("run", script), "open-eyes");
  });

  test("the user can take control, and the agent waits for them", async () => {
    await cli("open", fixture("form.html"));
    const snapshot = await cli("snapshot");
    const send = refOf(snapshot, 'button "Send"');
    const human = await humanAt();
    try {
      await human.click("take");
      assert.match(await cliError("click", send), /taken control/);
      assert.match(await cli("status"), /in control: the user/);

      const waiting = cli("wait", "--timeout", "20");
      await sleep(1000);
      await human.click("back");
      assert.match(await waiting, /handed control back/);
      assert.match(await cli("click", send), /clicked/);
    } finally {
      human.close();
    }
  });

  test("page scripts cannot take control", async () => {
    const human = await humanAt();
    try {
      await human.evaluate(`document.getElementById("__open_eyes__").shadowRoot.querySelector('[data-part="take"]').click()`);
      assert.match(await cli("status"), /in control: the agent/);
    } finally {
      human.close();
    }
  });

  test("handoff asks the user for help and survives their navigation", async () => {
    const human = await humanAt();
    try {
      const asking = cli("handoff", "Please log in", "--timeout", "30");
      const message = `document.getElementById("__open_eyes__")?.shadowRoot.querySelector('[data-part="message"]')?.textContent`;
      const asked = async () => (await human.evaluate(message)) === "Please log in";
      await until(asked, "the handoff panel");

      await human.navigate(fixture("second.html"));
      // The navigation wiped the page; the waiting agent must put the user back in control.
      await until(asked, "the handoff panel after navigating");

      await human.click("back");
      assert.match(await asking, /handed control back; now on .*second\.html/);
    } finally {
      human.close();
    }
  });

  test("screenshot writes a PNG", async () => {
    const file = await cli("screenshot", join(root, "shot.png"));
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file).subarray(1, 4).toString(), "PNG");
  });
});
