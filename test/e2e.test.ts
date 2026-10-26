import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  XDG_CONFIG_HOME: join(root, "config"),
  OPEN_EYES_DOWNLOADS: join(root, "downloads"),
  OPEN_EYES_CONFIRM: "never", // Tests that need approvals turn it on.
};

async function cli(...args: string[]): Promise<string> {
  return cliWith({}, ...args);
}

async function cliWith(extra: Record<string, string>, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], { env: { ...env, ...extra } });
  return stdout.trim();
}

async function cliError(...args: string[]): Promise<string> {
  return cliErrorWith({}, ...args);
}

async function cliErrorWith(extra: Record<string, string>, ...args: string[]): Promise<string> {
  try {
    await cliWith(extra, ...args);
  } catch (error) {
    return (error as { stderr: string }).stderr.trim();
  }
  throw new Error(`expected "open-eyes ${args.join(" ")}" to fail`);
}

const refLine = (snapshot: string) => snapshot.split("\n").find((l) => / @\d+$/.test(l));

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
  /** Evaluates in open-eyes' isolated world, where the overlay lives. */
  overlay: (expression: string) => Promise<any>;
  click: (part: string) => Promise<void>;
  navigate: (url: string) => Promise<void>;
  close: () => void;
}> {
  const { targetId } = JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "open-eyes", "state.json"), "utf8"));
  const cdp = await CDP.connect((await browserVersion(port))!.webSocketDebuggerUrl);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression: string, contextId?: number) =>
    (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, contextId }, sessionId)).result.value;
  // Asking for the world by name returns open-eyes' own, with its state.
  const overlay = async (expression: string) => {
    const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
    const world = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "open-eyes" }, sessionId);
    return evaluate(expression, world.executionContextId);
  };
  const part = (name: string) => `window.__openEyes?.root?.querySelector('[data-part="${name}"]')`;
  return {
    evaluate,
    overlay,
    async click(name) {
      const point = await until(
        () => overlay(`(() => { const el = ${part(name)}; if (!el?.checkVisibility()) return null;
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
    assert.match(snapshot, /heading Sign up/);
    assert.match(snapshot, /textbox Name @\d+/);
    assert.match(snapshot, /link Next page @\d+/);
    const body = snapshot.split("\n\n")[1];
    assert.doesNotMatch(body, /open-eyes/, "the overlay must stay out of the snapshot");
  });

  test("fill, check and click drive the page", async () => {
    const snapshot = await cli("snapshot");
    await cli("fill", refOf(snapshot, 'textbox Name'), "Ana");
    await cli("click", refOf(snapshot, 'checkbox Accept terms'));
    await cli("click", refOf(snapshot, 'button Send'));
    assert.equal(await cli("eval", "document.getElementById('out').textContent"), "Hello, Ana (accepted)");
  });

  test("refs stay stable and actions report what changed", async () => {
    await cli("open", fixture("form.html"));
    const first = await cli("snapshot");
    const send = refOf(first, 'button Send');

    assert.match(await cli("fill", refOf(first, 'textbox Name'), "Bo"), /changes:\n.*value=Bo/s);
    assert.match(await cli("click", send), /clicked button "Send"\nchanges:\n.*\+ "Hello, Bo"/s);

    assert.equal(refOf(await cli("snapshot"), 'button Send'), send);
    assert.match(await cli("snapshot", "--diff"), /no changes since the last snapshot/);
  });

  test("snapshots can be searched, scoped and paged", async () => {
    const all = await cli("snapshot");
    const found = await cli("snapshot", "--find", "terms");
    assert.match(found, /checkbox Accept terms/);
    assert.doesNotMatch(found, /heading Sign up/);

    const name = refOf(all, 'textbox Name');
    const scoped = (await cli("snapshot", "--scope", name)).split("\n\n")[1];
    assert.match(scoped, new RegExp(`^textbox Name.* ${name}`));
    assert.doesNotMatch(scoped, /button/);

    assert.match(await cli("snapshot", "--limit", "2"), /page 1 of \d+ .*next: --page 2/);
    assert.match(await cli("snapshot", "--limit", "2", "--page", "2"), /page 2 of/);
    assert.match(await cliError("snapshot", "--bogus"), /unknown snapshot option/);
  });

  test("refs from a page that is gone are rejected", async () => {
    const snapshot = await cli("snapshot");
    const name = refOf(snapshot, 'textbox Name');
    assert.match(await cli("click", refOf(snapshot, 'link Next page')), /the page changed to .*second\.html/);
    assert.match(await cliError("fill", name, "x"), /no longer loaded/);
    assert.match(await cliError("click", "@999"), /unknown ref/);
  });

  test("run executes a multi-step script", async () => {
    const script = join(root, "script.js");
    writeFileSync(
      script,
      `await page.goto(${JSON.stringify(fixture("second.html"))});
       const snap = await page.snapshot();
       await page.fill(snap.match(/textbox Search (@\\d+)/)[1], "open-eyes");
       return page.eval("document.querySelector('input').value");`,
    );
    assert.equal(await cli("run", script), "open-eyes");
  });

  test("the user can take control, and the agent waits for them", async () => {
    await cli("open", fixture("form.html"));
    const snapshot = await cli("snapshot");
    const send = refOf(snapshot, 'button Send');
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

  test("page scripts cannot take control or reach the overlay", async () => {
    const human = await humanAt();
    try {
      // The page sees the overlay's element but neither its buttons nor its state.
      assert.equal(await human.evaluate(`document.getElementById("__open_eyes__")?.shadowRoot ?? "closed"`), "closed");
      assert.equal(await human.evaluate(`typeof window.__openEyes`), "undefined");
      await human.evaluate(`window.__openEyes = { owner: "user" }; sessionStorage.setItem("open-eyes:owner", "agent")`);
      assert.match(await cli("status"), /in control: the agent/);
    } finally {
      human.close();
    }
  });

  test("handoff asks the user for help and survives their navigation", async () => {
    const human = await humanAt();
    try {
      const asking = cli("handoff", "Please log in", "--timeout", "30");
      const message = `window.__openEyes?.root?.querySelector('[data-part="message"]')?.textContent`;
      const asked = async () => (await human.overlay(message)) === "Please log in";
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

  test("connect drives a browser through the daemon, and disconnect stops it", async () => {
    const endpoint = (await browserVersion(port))!.webSocketDebuggerUrl;
    assert.match(await cli("connect", "--endpoint", endpoint), /connected to .*Chrome/);
    const { daemonPid } = JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "open-eyes", "state.json"), "utf8"));
    assert.ok(daemonPid > 0);
    try {
      assert.match(await cli("status"), /connected through the open-eyes daemon/);
      await cli("open", fixture("form.html"));
      const snapshot = await cli("snapshot");
      await cli("fill", refOf(snapshot, 'textbox Name'), "Daemon");
      assert.match(await cli("click", refOf(snapshot, 'button Send')), /Hello, Daemon/);
      assert.match(await cliError("connect", "--endpoint", endpoint), /already connected/);
      // Download events are browser-wide: the daemon must pass them on.
      await cli("open", fixture("files.html"));
      assert.match(await cli("click", refOf(await cli("snapshot"), "link Download notes")), /downloaded .*notes/);
    } finally {
      assert.match(await cli("disconnect"), /disconnected/);
    }
    assert.throws(() => process.kill(daemonPid, 0), "the daemon should have exited");
    assert.match(await cli("status"), new RegExp(`on port ${port}`));
  });

  test("connect refuses endpoints on other machines", async () => {
    assert.match(await cliError("connect", "--endpoint", "ws://example.com:9222/devtools/browser/x"), /non-local/);
  });

  test("the policy keeps the agent off sites it does not allow", async () => {
    await cli("open", fixture("form.html"));
    try {
      await cli("policy", "block", "example.com");
      assert.match(await cliError("open", "https://www.example.com/"), /www\.example\.com is blocked/);

      await cli("policy", "allow", "example.org");
      assert.match(await cliError("snapshot"), /not in your open-eyes allow list/);
      assert.match(await cliError("open", fixture("second.html")), /not in your open-eyes allow list/);
    } finally {
      await cli("policy", "reset");
    }
    assert.match(await cli("snapshot"), /heading Sign up/);
  });

  test("risky actions wait for the user to allow them on screen", async () => {
    const ask = { OPEN_EYES_CONFIRM: "risky" };
    await cli("open", fixture("form.html"));
    const snapshot = await cli("snapshot");
    const human = await humanAt();
    try {
      // Not risky: goes through without asking.
      await cliWith(ask, "click", refOf(snapshot, 'checkbox Accept terms'));

      const sending = cliWith(ask, "click", refOf(snapshot, 'button Send'));
      await human.click("allow");
      assert.match(await sending, /clicked button "Send"/);

      const again = cliErrorWith(ask, "click", refOf(snapshot, 'button Send'));
      await human.click("deny");
      assert.match(await again, /the user denied: click button "Send"/);

      const password = cliWith(ask, "fill", refOf(snapshot, 'textbox Password'), "hunter2-secret");
      await human.click("allow");
      assert.match(await password, /filled textbox "Password"/);

      // A page script cannot answer for the user: not by writing the answer where open-eyes
      // used to keep it, nor by clicking Allow.
      await human.evaluate(`setInterval(() => {
        const state = window.__openEyes;
        if (state?.confirm) state.decisions[state.confirm.id] = "allow";
        document.getElementById("__open_eyes__")?.shadowRoot?.querySelector('[data-part="allow"]')?.click();
      }, 50)`);
      const sneaky = cliErrorWith(ask, "click", refOf(snapshot, 'button Send'));
      await until(() => human.overlay(`!!window.__openEyes?.root?.querySelector('[data-part="allow"]')?.checkVisibility()`), "the question");
      await sleep(1000);
      await human.click("deny");
      assert.match(await sneaky, /denied/);
    } finally {
      human.close();
    }
  });

  test("an approved Enter still reaches the field that had focus", async () => {
    const ask = { OPEN_EYES_CONFIRM: "risky" };
    await cli("open", fixture("search.html"));
    await cli("fill", refOf(await cli("snapshot"), 'textbox Query'), "chromium");
    const human = await humanAt();
    try {
      const pressing = cliWith(ask, "press", "Enter");
      await human.click("allow");
      assert.match(await pressing, /the page changed to .*second\.html\?q=chromium/);
    } finally {
      human.close();
    }
  });

  test("the token counter steps aside while a panel asks the user", async () => {
    await cli("usage", "show");
    await cli("open", fixture("search.html"));
    await cli("fill", refOf(await cli("snapshot"), "textbox Query"), "x");
    const human = await humanAt();
    const visible = (part: string) =>
      human.overlay(`!!window.__openEyes?.root?.querySelector('[data-part="${part}"]')?.checkVisibility()`);
    try {
      assert.equal(await visible("usage"), true);
      const pressing = cliWith({ OPEN_EYES_CONFIRM: "risky" }, "press", "Enter");
      await until(() => visible("allow"), "the question");
      assert.equal(await visible("usage"), false, "the counter must not cover Allow or Deny");
      await human.click("deny");
      await pressing.catch(() => {});
      await until(() => visible("usage"), "the counter coming back");
    } finally {
      human.close();
      await cli("usage", "hide");
    }
  });

  test("the audit log records actions and outcomes, never typed text", async () => {
    await cli("open", `${fixture("form.html")}?phone=0991234567&token=hunter3#code=42`);
    const log = await cli("log", "--limit", "50");
    assert.match(log, /OK +open +file:\/\/\S*form\.html +on/, "the page is logged without its query");
    assert.doesNotMatch(log, /0991234567|hunter3|code=42/);
    assert.match(log, /OK +click +button "Send"/);
    assert.match(log, /DENIED +click +button "Send"/);
    assert.match(log, /BLOCKED +open +https:\/\/www\.example\.com\//);
    assert.match(log, /fill +textbox "Password" \(14 characters\)/);
    assert.doesNotMatch(log, /hunter2-secret/);
  });

  test("status never opens an agent window", async () => {
    await cli("open", fixture("form.html"));
    assert.match(await cli("close"), /closed the agent window/);
    assert.match(await cli("status"), /agent window: none/);
    assert.match(await cli("status"), /agent window: none/, "the first status must not have opened one");
    await cli("open", fixture("form.html"));
    assert.match(await cli("status"), /agent window: file:.*form\.html/);
  });

  test("token usage is recorded per command and shown in the window", async () => {
    await cli("usage", "reset");
    assert.match(await cli("usage", "show"), /shown/);
    await cli("open", fixture("form.html"));
    const snapshot = await cli("snapshot");
    await cli("fill", refOf(snapshot, 'textbox Name'), "super-secret-name");

    const usage = await cli("usage");
    assert.match(usage, /^open file:.*form\.html +\d+ tok/m);
    assert.match(usage, /^snapshot +\d+ tok/m);
    assert.match(usage, /^fill @\d+ +\d+ tok/m);
    assert.match(usage, /total +[\d,]+ tok +in 3 actions/);
    assert.doesNotMatch(usage, /super-secret-name/);

    const human = await humanAt();
    try {
      const counter = `window.__openEyes?.root?.querySelector('[data-part="usage"]')`;
      assert.match(await human.overlay(`${counter}?.textContent`), /last \d+ tok \u00B7 total [\d,]+ tok \u00B7 3 actions/);
      await cli("usage", "hide");
      assert.equal(await human.overlay(`${counter}?.checkVisibility()`), false);
    } finally {
      human.close();
    }
    assert.match(await cli("usage", "reset"), /reset/);
  });

  test("the default snapshot shows what is on screen and outlines the rest", async () => {
    await cli("open", fixture("tall.html"));
    const onScreen = await cli("snapshot");
    assert.match(onScreen, /^on screen: 0-\d+ px of [\d,]+ \(\d+%\)$/m);
    assert.match(onScreen, /heading Top/);
    assert.match(onScreen, /link Home @\d+/);
    assert.doesNotMatch(onScreen, /Bottom button/);
    assert.match(onScreen, /^heading Bottom \(below\)$/m);
    assert.match(onScreen, /--full/);

    assert.match(await cli("snapshot", "--full"), /button Bottom button @\d+/);
    const button = refOf(await cli("snapshot", "--find", "Bottom button"), "button Bottom button");
    assert.match(await cli("click", button), /clicked button "Bottom button"/);

    // The click scrolled the button into view: now the top is off screen.
    const scrolled = await cli("snapshot");
    assert.match(scrolled, /button Pressed (\[focused\] )?@\d+/);
    assert.match(scrolled, /^heading Top \(above\)$/m);
  });

  test("navigating without a reload is reported as a page change, not a diff", async () => {
    await cli("open", fixture("app.html"));
    const snapshot = await cli("snapshot");
    const toggle = refOf(snapshot, "button Show details");

    const navigated = await cli("click", refOf(snapshot, "link Issues"));
    assert.match(navigated, /^clicked link "Issues"\nthe page changed to .*app\.html\?view=issues; run "open-eyes snapshot"/);
    assert.ok(navigated.length < 250, `one line, not a diff: ${navigated}`);
    // Same document: refs from before still work.
    assert.match(await cli("click", toggle), /\+ +button Hide details/);

    const rewritten = await cli("click", refOf(await cli("snapshot"), "button Rewrite"));
    assert.match(rewritten, /most of the page changed \(\d+ lines\)/);

    await cli("open", fixture("tall.html"));
    const jumped = await cli("click", refOf(await cli("snapshot"), "link Home"));
    assert.doesNotMatch(jumped, /page changed/, "a #fragment jump is not a page change");
  });

  test("snapshot --interactive keeps only what an agent can act on", async () => {
    await cli("open", fixture("form.html"));
    const body = (await cli("snapshot", "--interactive")).split("\n\n")[1];
    for (const line of ["heading Sign up", "textbox Name", "checkbox Accept terms", "textbox Password", "button Send", "link Next page"]) {
      assert.match(body, new RegExp(line));
    }
    assert.doesNotMatch(body, /^\s*"/m, "no plain text lines");
    assert.equal((await cli("snapshot", "--interactive", "--find", "Send")).split("\n\n")[1], refLine(await cli("snapshot", "--find", "Send")));
    assert.match(await cliError("snapshot", "--interactive", "--diff"), /cannot be combined/);
  });

  test("scroll moves the page or a container and shows what is on screen", async () => {
    await cli("open", fixture("tall.html"));
    const down = await cli("scroll", "down", "3000");
    assert.match(down, /^scrolled down 3000 px in the page$/m);
    assert.match(down, /button Bottom button @\d+/);
    assert.match(down, /^heading Top \(above\)$/m);

    assert.match(await cli("scroll", "up", "99999"), /scrolled up 99999 px/);
    assert.match(await cli("scroll", "up"), /the page did not move \(already at the top/);

    const button = refOf(await cli("snapshot", "--find", "Bottom button"), "button Bottom button");
    const intoView = await cli("scroll", button);
    assert.match(intoView, /^scrolled to button "Bottom button"$/m);
    assert.match(intoView, /button Bottom button/);

    await cli("open", fixture("list.html"));
    const first = refOf(await cli("snapshot"), "button Message 1 ");
    const inList = await cli("scroll", first, "down", "400");
    assert.match(inList, /scrolled down 400 px in the area of button "Message 1"/);
    assert.ok(Number(await cli("eval", "document.getElementById('list').scrollTop")) > 0, "the list scrolled");
    assert.match(inList, /button Message 1\d @\d+/);
    assert.match(await cliError("scroll", "sideways"), /usage: open-eyes scroll/);
  });

  test("the agent follows a tab its action opened", async () => {
    for (const opener of ["link New tab", "link No opener", "button Pop up"]) {
      await cli("open", fixture("popups.html"));
      const opened = await cli("click", refOf(await cli("snapshot"), opener));
      assert.match(opened, /it opened a new tab, which is now the agent window: .*second\.html;/, opener);
      assert.match(await cli("snapshot"), /^title: "Second page"$/m, opener);
    }

    // The policy applies to the new tab too.
    const server = createServer((_, response) => {
      const port = (server.address() as AddressInfo).port;
      response.end(`<a href="http://localhost:${port}/" target="_blank">Elsewhere</a>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await cli("open", `http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      await cli("policy", "block", "localhost");
      assert.match(await cliError("click", refOf(await cli("snapshot"), "link Elsewhere")), /localhost is blocked by your open-eyes policy; open-eyes left it/);
    } finally {
      await cli("policy", "reset");
      server.close();
    }
  });

  test("select chooses options in native and custom dropdowns", async () => {
    await cli("open", fixture("dropdowns.html"));
    const snapshot = await cli("snapshot");
    const country = refOf(snapshot, "combobox Country");

    assert.match(await cli("select", country, "argentina"), /^chose "Argentina" in combobox "Country"/);
    assert.equal(await cli("eval", "document.getElementById('picked').textContent"), "Picked ar");
    assert.match(await cliError("select", country, "Peru"), /no option "Peru" in combobox "Country"; options: Choose one, Ecuador, Argentina/);

    const size = refOf(snapshot, "button Size: none");
    assert.match(await cli("select", size, "Large"), /^chose "Large" in button "Size: none"/);
    assert.equal(await cli("eval", "document.getElementById('size').textContent"), "Size: Large");
    assert.match(await cliError("select", size, "Huge"), /no option "Huge".*options: Small, Large/);
  });

  test("fill chooses in a native dropdown and refuses what cannot be typed into", async () => {
    await cli("open", fixture("dropdowns.html"));
    const dropdowns = await cli("snapshot");
    assert.match(await cli("fill", refOf(dropdowns, "combobox Country"), "Argentina"), /^chose "Argentina" in combobox "Country"/);
    assert.equal(await cli("eval", "document.getElementById('picked').textContent"), "Picked ar");
    assert.match(await cliError("fill", refOf(dropdowns, "combobox Country"), "Peru"), /no option "Peru" in combobox "Country"; options: Choose one, Ecuador, Argentina/);

    await cli("open", fixture("form.html"));
    const form = await cli("snapshot");
    for (const [entry, what] of [["link Next page", 'link "Next page"'], ["checkbox Accept terms", 'checkbox "Accept terms"'], ["button Send", 'button "Send"']]) {
      const ref = refOf(form, entry);
      assert.match(await cliError("fill", ref, "x"), new RegExp(`${what} cannot be typed into; use click ${ref}`));
    }
    assert.equal(await cli("eval", "document.querySelector('a').textContent"), "Next page", "nothing was typed into the link");

    await cli("open", fixture("files.html"));
    const resume = refOf(await cli("snapshot"), "button Resume");
    assert.match(await cliError("fill", resume, "cv.pdf"), new RegExp(`cannot be typed into; use upload ${resume} <file>`));
  });

  test("clicking an option of a native dropdown chooses it", async () => {
    await cli("open", fixture("dropdowns.html"));
    const snapshot = await cli("snapshot", "--full"); // A closed dropdown's options are not on screen.

    assert.match(await cli("click", refOf(snapshot, "option Ecuador")), /^chose "Ecuador" in combobox "Country"/);
    assert.equal(await cli("eval", "document.getElementById('picked').textContent"), "Picked ec");
    assert.match(await cli("click", "--name", "Argentina", "--role", "option"), /^chose "Argentina" in combobox "Country"/);
    assert.equal(await cli("eval", "document.getElementById('picked').textContent"), "Picked ar");
    assert.match(await cli("log", "--limit", "2"), /OK +select +combobox "Country" → Argentina/);

    // Clicking the dropdown itself, and options of a list that shows them, stay real clicks.
    assert.match(await cli("click", refOf(snapshot, "combobox Country")), /^clicked combobox "Country"/);
    assert.match(await cli("click", refOf(snapshot, "option Olives")), /^clicked option "Olives"/);
    assert.equal(await cli("eval", "document.getElementById('toppings').value"), "Olives");
  });

  describe("do, with a stub model", () => {
    // Answers each request with the next scripted tool call, and keeps the requests.
    let script: ({ command: string } | { answer: string; success: boolean } | { text: string } | { invalid: true })[] = [];
    const requests: { messages: { role: string; content: string }[]; tools: unknown[] }[] = [];
    const model = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push(JSON.parse(body));
        const next = script.shift() ?? { command: "snapshot" };
        res.setHeader("content-type", "application/json");
        // What llama-server answers when it cannot parse the model's tool call.
        if ("invalid" in next) return res.writeHead(500).end('{"error":{"code":500,"message":"Failed to parse tool call arguments as JSON"}}');
        if ("text" in next) return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: next.text } }] }));
        const name = "command" in next ? "open_eyes" : "finish";
        const call = { id: `call${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(next) } };
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "", tool_calls: [call] } }] }));
      });
    });
    let modelEnv: Record<string, string>;
    before(async () => {
      await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
      modelEnv = { OPEN_EYES_MODEL_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1` };
    });
    after(() => model.close());

    test("carries out a goal and reports the actions", async () => {
      await cli("open", fixture("form.html"));
      requests.length = 0;
      script = [
        { command: 'fill --name Name "Ana"' },
        { command: "click --name 'Accept terms'" },
        { command: "open-eyes click --name Send" },
        { answer: "Hello, Ana (accepted)", success: true },
      ];
      const report = await cliWith(modelEnv, "do", "Sign up as Ana, accept the terms and send");
      assert.match(report, /^done: Hello, Ana \(accepted\)\nactions:\n/);
      assert.match(report, /  fill --name Name "Ana" → filled textbox "Name"/);
      assert.match(report, /  open-eyes click --name Send → clicked button "Send"/);
      assert.match(report, /page: file:.*form\.html$/);
      assert.equal(await cli("eval", "document.getElementById('out').textContent"), "Hello, Ana (accepted)");

      const [first] = requests;
      assert.match(first.messages[1].content, /^Goal: Sign up as Ana[^]*textbox Name @\d+/);
      assert.equal(first.tools.length, 2);
    });

    test("refuses commands outside its list and does not trust a success after a failure", async () => {
      await cli("open", fixture("form.html"));
      script = [{ command: "eval document.cookie" }, { answer: "Done", success: true }];
      const report = await cliWith(modelEnv, "do", "Read the cookies");
      assert.match(report, /^not sure: the model says "Done", but its last step failed/);
      assert.match(report, /eval document.cookie → error: "eval" is not available; use one of: snapshot, click/);
    });

    test("stops at the step limit, and says when it is not done", async () => {
      script = [];
      assert.match(await cliWith(modelEnv, "do", "Loop forever", "--steps", "2"), /^stopped: reached the limit of 2 steps\nactions: none/);
      script = [{ answer: "There is no such button", success: false }];
      assert.match(await cliWith(modelEnv, "do", "Press Buy"), /^not done: There is no such button/);
    });

    test("reminds the model once to use its tools, and reports what it did when it cannot go on", async () => {
      await cli("open", fixture("form.html"));
      requests.length = 0;
      script = [{ text: "The page asks for a name." }, { invalid: true }, { answer: "A sign-up form", success: true }];
      assert.match(await cliWith(modelEnv, "do", "What is this page?"), /^done: A sign-up form/);
      assert.match(requests[1].messages.at(-1)!.content, /^Use a tool: call open_eyes to continue, or finish/);
      assert.match(requests[2].messages.at(-1)!.content, /^Your last tool call could not be read/);

      script = [{ command: "click --name Send" }, { invalid: true }, { invalid: true }];
      const report = await cliWith(modelEnv, "do", "Send the form");
      assert.match(report, /^stopped: the model sent tool calls that could not be read\nactions:\n  click --name Send → clicked button "Send"/);
      script = [{ text: "Done." }, { text: "Really done." }];
      assert.match(await cliWith(modelEnv, "do", "Anything"), /^stopped: the model answered without finishing: Really done\./);
    });

    test("explains how to set up a model when none is configured", async () => {
      assert.match(await cliErrorWith({ OPEN_EYES_MODEL_URL: "" }, "do", "anything"), /needs a local model[^]*open-eyes model install[^]*OPEN_EYES_MODEL_URL/);
      assert.match(await cli("model"), /^navigator model: not installed/);
      // Only the user may agree to a download this big: without a terminal it needs --yes.
      const refused = await cliError("model", "install");
      assert.match(refused, /will download:\n  open-eyes navigator v1 \(Gemma 4 E2B\), 2\.2 GB, license: Apache 2\.0/);
      assert.match(refused, /run "open-eyes model install --yes" yourself/);
    });
  });

  test("traces record a session on request, never a password, and export what the local model can learn", async () => {
    assert.match(await cli("trace"), /^no traces/);
    assert.match(await cli("trace", "start", "Sign up as Ana"), /^recording trace [\w-]+: each open-eyes command/);
    assert.match(await cliError("trace", "start", "Another"), /already recording trace/);
    await cli("open", fixture("form.html"));
    const snapshot = await cli("snapshot");
    await cli("fill", refOf(snapshot, "textbox Name"), "Ana");
    await cli("click", "--name", "Accept terms");
    await cli("click", "--name", "Send");
    assert.match(await cli("trace", "stop", "done", "Hello, Ana (accepted)"), /^stopped trace [\w-]+: done, 5 commands$/);

    await cli("trace", "start", "Log in");
    await cli("fill", "--name", "Password", "hunter2-secret");
    await cli("trace", "stop", "failed");

    const list = await cli("trace");
    assert.match(list, /done +5 commands  Sign up as Ana/);
    assert.match(list, /failed +1 commands  Log in/);
    const [first, second] = list.split("\n").map((line) => line.split(" ")[0]);
    const shown = await cli("trace", "show", first);
    assert.match(shown, /^goal: Sign up as Ana\noutcome: done \(Hello, Ana \(accepted\)\)/);
    assert.match(shown, /\$ open-eyes fill @\d+ Ana\nfilled textbox "Name"/);
    assert.match(await cli("trace", "show", second), /\$ open-eyes fill \(typed into a password field, not stored\)/);
    const stored = readFileSync(join(root, "state", "open-eyes", "traces", `${second}.jsonl`), "utf8");
    assert.doesNotMatch(stored, /hunter2/);

    const out = join(root, "traces.jsonl");
    const exported = await execFileAsync(process.execPath, [CLI, "trace", "export", out], { env });
    assert.match(exported.stderr, /exported 1 traces to .*\nskipped 1:\n  [\w-]+: typed into a password field/);
    const [example] = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.match(example.messages[1].content, /^Goal: Sign up as Ana\n\nCurrent snapshot:\n[^]*textbox Name/);
    assert.equal(example.messages.at(-1).tool_calls[0].function.arguments, '{"answer":"Hello, Ana (accepted)","success":true}');

    assert.equal(await cli("trace", "delete", "--all"), "deleted 2 traces");
    assert.match(await cli("trace"), /^no traces/);
  });

  test("Enter in a search box goes through, Enter in other forms asks", async () => {
    const ask = { OPEN_EYES_CONFIRM: "risky" };
    for (const field of ["textbox Search the site", "searchbox Find"]) {
      await cli("open", fixture("site-search.html"));
      await cli("fill", refOf(await cli("snapshot"), field), "open eyes");
      assert.match(await cliWith(ask, "press", "Enter"), /pressed Enter\nthe page changed to .*second\.html/);
    }
    await cli("open", fixture("site-search.html"));
    await cli("fill", refOf(await cli("snapshot"), "textbox User"), "ana");
    const human = await humanAt();
    try {
      const pressing = cliErrorWith(ask, "press", "Enter");
      await human.click("deny");
      assert.match(await pressing, /the user denied: press Enter, which submits a form/);
    } finally {
      human.close();
    }
  });

  test("hover opens menus and tooltips and reports them", async () => {
    await cli("open", fixture("hover.html"));
    const snapshot = await cli("snapshot");
    assert.doesNotMatch(snapshot, /Laptops/);

    const menu = await cli("hover", refOf(snapshot, "link Products"));
    assert.match(menu, /^hovered over link "Products"\nchanges:/);
    assert.match(menu, /\+ +link Laptops @\d+/);
    assert.match(menu, /\+ +link Phones @\d+/);

    const tip = await cli("hover", refOf(snapshot, "button Help"));
    assert.match(tip, /\+ +tooltip Opens the user guide/);
  });

  test("upload attaches files after the user allows it, and logs only their names", async () => {
    const file = join(root, "cv-secret-contents.pdf");
    writeFileSync(file, "top secret file body");
    await cli("open", fixture("files.html"));
    const snapshot = await cli("snapshot");
    const resume = refOf(snapshot, "button Resume");

    assert.match(await cli("upload", resume, file), /^uploaded cv-secret-contents\.pdf to button "Resume"/);
    assert.equal(await cli("eval", "document.getElementById('names').textContent"), "cv: cv-secret-contents.pdf");

    // A styled button whose file input is hidden: the form's only file input is used.
    await cli("upload", refOf(snapshot, "button Attach"), file);
    assert.equal(await cli("eval", "document.getElementById('names').textContent"), "hidden: cv-secret-contents.pdf");

    assert.match(await cliError("upload", resume, join(root, "missing.pdf")), /no such file/);
    assert.match(await cliError("upload", refOf(snapshot, "link Download notes"), file), /no file input belongs to it/);

    const human = await humanAt();
    try {
      const asking = cliErrorWith({ OPEN_EYES_CONFIRM: "risky" }, "upload", resume, file);
      await human.click("deny");
      assert.match(await asking, /the user denied: upload cv-secret-contents\.pdf/);
    } finally {
      human.close();
    }
    const log = await cli("log", "--limit", "10");
    assert.match(log, /upload +button "Resume" <- cv-secret-contents\.pdf/);
    assert.doesNotMatch(log, /top secret file body/);
  });

  test("downloads are saved to a known folder and reported", async () => {
    await cli("open", fixture("files.html"));
    const link = refOf(await cli("snapshot"), "link Download notes");
    const first = await cli("click", link);
    const saved = first.match(/\ndownloaded (.+)$/)?.[1] ?? "";
    assert.equal(dirname(saved), env.OPEN_EYES_DOWNLOADS);
    assert.match(basename(saved), /^notes( \(\d+\))?\.txt$/);
    assert.equal(readFileSync(saved, "utf8"), "hello from open-eyes");
    // Another download never overwrites an earlier one.
    const second = (await cli("click", link)).match(/\ndownloaded (.+)$/)?.[1];
    assert.ok(second && second !== saved, `a new file, not ${saved}`);
    assert.equal(readFileSync(second, "utf8"), "hello from open-eyes");
    assert.match(await cli("log", "--limit", "1"), /click +link "Download notes" \(downloaded notes \(\d+\)\.txt\)/);
  });

  test("actions wait for the content they fetched, but never hang on a request", async () => {
    // A search box that, like Wikipedia's, fetches suggestions after a debounce.
    const page = `<!doctype html><title>Search</title><input aria-label="Query"><button>Poll forever</button><ul></ul>
      <script>
        let timer;
        document.querySelector("input").addEventListener("input", (event) => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            const items = await (await fetch("/suggest?q=" + event.target.value)).json();
            document.querySelector("ul").innerHTML = items.map((i) => "<li>" + i + "</li>").join("");
          }, 200);
        });
        document.querySelector("button").addEventListener("click", () => fetch("/never"));
      </script>`;
    const server = createServer((request, response) => {
      if (request.url === "/") return response.end(page);
      if (request.url?.startsWith("/suggest")) {
        return setTimeout(() => response.end(JSON.stringify(["Chromium browser", "Chromium element"])), 700);
      }
      // /never: keep the request open.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await cli("open", `http://127.0.0.1:${port}/`);
      const snapshot = await cli("snapshot");
      const filled = await cli("fill", refOf(snapshot, "textbox Query"), "chromium");
      assert.match(filled, /\+ +"Chromium browser"/, "suggestions fetched after a debounce are reported");

      const started = Date.now();
      await cli("click", refOf(snapshot, "button Poll forever"));
      assert.ok(Date.now() - started < 6000, "a request that never ends does not hold the action");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  test("screenshot writes a PNG", async () => {
    const file = await cli("screenshot", join(root, "shot.png"));
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file).subarray(1, 4).toString(), "PNG");
  });

  test("screenshot --scope captures only that element, even off screen", async () => {
    await cli("open", fixture("tall.html"));
    const ref = (await cli("snapshot", "--find", "Bottom button")).match(/button Bottom button @(\d+)/)?.[1];
    assert.ok(ref, "the button has a ref");
    const file = await cli("screenshot", join(root, "button.png"), "--scope", `@${ref}`);
    const png = readFileSync(file);
    const size = JSON.parse(await cli("eval", "JSON.stringify((({ width, height }) => [width, height])(document.querySelector('button').getBoundingClientRect()))"));
    const captured = [png.readUInt32BE(16), png.readUInt32BE(20)];
    captured.forEach((px, i) => assert.ok(Math.abs(px - size[i]) <= 1, `captured ${captured} for an element of ${size}`)); // Fractional sizes round either way.
    assert.match(await cliError("screenshot", "--scope", "@99999"), /@99999/);
  });

  test("actions find elements by name, without a snapshot", async () => {
    await cli("open", fixture("form.html"));
    assert.match(await cli("fill", "--name", "Name", "Eva"), /filled textbox "Name"/);
    await cli("click", "--name", "accept terms", "--role", "checkbox");
    await cli("click", "--name", "Send");
    assert.equal(await cli("eval", "document.getElementById('out').textContent"), "Hello, Eva (accepted)");
    const ambiguous = await cliError("click", "--name", "e");
    assert.match(ambiguous, /elements match "e"; use a ref or add a role/);
    assert.match(ambiguous, /button "Send" @\d+/);
    assert.match(await cliError("click", "--name", "Nowhere"), /nothing named "Nowhere"/);
    assert.match(await cliError("click", "--name", "Send", "--role", "link"), /nothing named link "Send"/);
    const script = join(root, "by-name.js");
    writeFileSync(script, `await page.click({ name: "Next page", role: "link" }); return page.url();`);
    assert.match(await cli("run", script), /second\.html$/);
  });
  test("iframes, same-origin and cross-origin, are read and driven like the page", async () => {
    // localhost and 127.0.0.1 are different sites, so the second iframe runs in its own process.
    const server = createServer((request, response) => {
      const port = (server.address() as { port: number }).port;
      const pages: Record<string, string> = {
        "/": `<title>Shop</title><h1>Checkout</h1>
          <iframe src="/same" title="Coupon" style="border: 4px solid; margin: 20px"></iframe>
          <div style="height: 1500px"></div>
          <iframe src="http://127.0.0.1:${port}/cross" style="margin-left: 120px" width="400" height="200"></iframe>`,
        "/same": `<button onclick="this.textContent = 'Applied'">Apply coupon</button>`,
        "/cross": `<title>Payment</title><div style="height: 100px"></div>
          <label>Card number <input></label>
          <button onclick="document.querySelector('p').textContent = 'Paid with ' + document.querySelector('input').value">Pay</button><p></p>`,
      };
      response.setHeader("content-type", "text/html");
      response.end(pages[request.url ?? ""] ?? "");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      await cli("open", `http://localhost:${port}/`);
      const full = await cli("snapshot", "--full");
      assert.match(full, /^iframe Coupon\n  button Apply coupon @\d+$/m);
      assert.match(full, /^iframe Payment\n  "Card number"\n  textbox Card number @\d+\n  button Pay @\d+$/m);
      assert.match(await cli("snapshot", "--find", "Card"), /iframe Payment\n  "Card number"\n  textbox Card number @\d+/);
      const onScreen = await cli("snapshot");
      assert.doesNotMatch(onScreen, /Card number/);
      assert.match(onScreen, /off screen: 4 more lines\. Outline:\niframe Payment \(below\)/);

      // Clicks land at the element's real position in the window, also below the fold.
      assert.match(await cli("click", refOf(full, "button Apply coupon")), /\+ +button Applied( \[focused\])? @\d+/);
      await cli("fill", refOf(full, "textbox Card number"), "42424");
      await cli("press", "Backspace"); // Keys go to the focused field, inside the iframe.
      assert.match(await cli("click", "--name", "Pay"), /\+ +"Paid with 4242"/);
      assert.match(await cli("snapshot", "--scope", refOf(full, "button Pay")), /^button Pay( \[focused\])? @\d+$/m);

      await cli("policy", "block", "127.0.0.1");
      assert.match(await cliError("click", refOf(full, "button Pay")), /in an iframe from http:\/\/127\.0\.0\.1:\d+\/cross, but 127\.0\.0\.1 is blocked/);
    } finally {
      await cli("policy", "reset");
      server.close();
    }
  });
});
