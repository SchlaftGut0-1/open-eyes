import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { audit, type AuditEntry } from "./audit.ts";
import type { CDP } from "./cdp.ts";
import { decisionExpression, OWNER_EXPRESSION, overlayExpression, type OverlayAction, type OverlayCommand, type Owner } from "./overlay.ts";
import { blockedReason, isRiskyClick, loadPolicy, PolicyError, type Policy } from "./policy.ts";
import { formatSnapshot, type AXNode } from "./snapshot.ts";
import { stateDir, type Ref, type State } from "./state.ts";
import { diffLines, findLines, paginate, subtree } from "./view.ts";

export type Box = { x: number; y: number; width: number; height: number };

/** Pause after showing an action so the human can follow along. 0 disables it. */
const SLOWMO_MS = Number(process.env.OPEN_EYES_SLOWMO ?? 400);

/** Default snapshot page size in lines; 0 shows everything. */
const SNAPSHOT_LIMIT = Number(process.env.OPEN_EYES_SNAPSHOT_LIMIT ?? 400);
/** After an action, report what changed on the page (off with OPEN_EYES_OBSERVE=0). */
const OBSERVE = process.env.OPEN_EYES_OBSERVE !== "0";
const OBSERVE_LIMIT = 80;
/** The last snapshot's text, the baseline for diffs. */
const baselineFile = join(stateDir, "snapshot.txt");

export type SnapshotOptions = {
  /** Only what changed since the last snapshot of this page. */
  diff?: boolean;
  /** Page size in lines; 0 shows everything. */
  limit?: number;
  page?: number;
  /** Only the element with this ref and what is inside it. */
  scope?: string;
  /** Only lines containing this text, with their ancestors. */
  find?: string;
};

const USER_IN_CONTROL =
  'the user has taken control of the agent window; run "open-eyes wait" to wait until they hand it back';

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};

// Resolves once the DOM has gone QUIET_MS without changes (or after MAX_MS for pages that
// never stop, like carousels), so frameworks can finish re-rendering after an action.
const QUIET_MS = 300;
const MAX_QUIET_WAIT_MS = 2000;
const WAIT_FOR_QUIET_DOM = `new Promise((resolve) => {
  let timer;
  const done = () => { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(true); };
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, ${QUIET_MS}); });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  timer = setTimeout(done, ${QUIET_MS});
  const cap = setTimeout(done, ${MAX_QUIET_WAIT_MS});
})`;

const SELECT_CONTENTS = `function () {
  if (typeof this.select === "function") return this.select();
  if (this.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(this);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}`;

/** How long a risky action waits for the user to allow it before it is denied. */
const CONFIRM_TIMEOUT_MS = 120_000;

/** The agent's window. Every action is drawn on the page before it happens. */
export class Page {
  #cdp: CDP;
  #sessionId: string;
  #state: State;
  #policy: Policy;

  constructor(cdp: CDP, sessionId: string, state: State) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
    this.#state = state;
    this.#policy = loadPolicy();
  }

  async init(): Promise<void> {
    // The agent's window is usually not focused; make the page behave as if it were.
    await this.#send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }

  goto(url: string): Promise<string> {
    const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    return this.#audited("open", target, async () => {
      const reason = blockedReason(this.#policy, target);
      if (reason) throw new PolicyError("blocked", reason);
      await this.#announce({ label: `opening ${target}` });
      const { errorText } = await this.#send<{ errorText?: string }>("Page.navigate", { url: target });
      if (errorText) throw new Error(`could not open ${target}: ${errorText}`);
      this.#state.refs = {};
      await this.#settle(30_000);
      await this.#leaveIfBlocked(); // A redirect may have gone somewhere else.
      const current = await this.url();
      await this.#announce({ label: `on ${current}` }, false);
      return current;
    });
  }

  async snapshot(options: SnapshotOptions = {}): Promise<string> {
    await this.#guard();
    const { lines, previous } = await this.#capture();
    let body: string[];
    if (options.diff) {
      const changes = previous && diffLines(previous, lines);
      if (!previous) body = ["(first snapshot of this page, so all of it)", ...lines];
      else if (!changes) body = ["(too many changes to diff, so all of it)", ...lines];
      else body = changes.length ? changes : ["no changes since the last snapshot"];
    } else {
      body = options.scope ? subtree(lines, options.scope) : lines;
      if (options.find) {
        body = findLines(body, options.find);
        if (!body.length) body = [`nothing matches "${options.find}"`];
      }
    }
    const title = await this.#evaluate("document.title");
    const shown = paginate(body, options.limit ?? SNAPSHOT_LIMIT, options.page);
    return `url: ${await this.url()}\ntitle: ${JSON.stringify(title)}\n\n${shown.join("\n")}`;
  }

  click(ref: string): Promise<string> {
    return this.#audited("click", ref, async (entry) => {
      await this.#guard();
      const { backendNodeId, label } = await this.#resolve(ref);
      entry.target = label;
      const box = await this.#locate(backendNodeId, ref);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await this.#announce({ label: `click ${label}`, x, y, box, busy: true });
      await this.#confirm(`click ${label}`, isRiskyClick(label));
      await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (const type of ["mousePressed", "mouseReleased"]) {
        await this.#send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      await this.#overlay({ type: "idle" });
      await sleep(150);
      await this.#settle(10_000);
      await this.#leaveIfBlocked();
      return `clicked ${label}${await this.#observe()}`;
    });
  }

  fill(ref: string, text: string): Promise<string> {
    return this.#audited("fill", ref, async (entry) => {
      await this.#guard();
      const { backendNodeId, label } = await this.#resolve(ref);
      entry.target = `${label} (${text.length} characters)`; // Never the text: it may be a secret.
      const box = await this.#locate(backendNodeId, ref);
      await this.#announce({ label: `typing into ${label}`, x: box.x + 8, y: box.y + box.height / 2, box });
      const { object } = await this.#send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId });
      const { result } = await this.#send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function () { return this.type === "password"; }`,
        returnByValue: true,
      });
      await this.#confirm(`type into ${label}, a password field`, result.value === true);
      await this.#send("DOM.focus", { backendNodeId });
      await this.#send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: SELECT_CONTENTS });
      // Inserting over the selection replaces existing content and fires real input events.
      if (text) await this.#send("Input.insertText", { text });
      else await this.press("Backspace", false);
      return `filled ${label}${await this.#observe()}`;
    });
  }

  async press(key: string, announce = true): Promise<string> {
    const def = KEYS[key] ?? (key.length === 1 ? { code: "", keyCode: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!def) throw new Error(`unknown key "${key}"; use a single character or one of: ${Object.keys(KEYS).join(", ")}`);
    const dispatch = async () => {
      const common = { key: key === "Space" ? " " : key, code: def.code, windowsVirtualKeyCode: def.keyCode };
      await this.#send("Input.dispatchKeyEvent", { type: def.text ? "keyDown" : "rawKeyDown", text: def.text, ...common });
      await this.#send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    };
    if (!announce) {
      await dispatch(); // Part of another action, which was already checked.
      return `pressed ${key}`;
    }
    return this.#audited("press", key, async () => {
      await this.#guard();
      await this.#announce({ label: `press ${key}` });
      const submits = key === "Enter" && (await this.#evaluate(`!!document.activeElement?.closest?.("form")`));
      await this.#confirm("press Enter, which submits a form", submits === true);
      await dispatch();
      await this.#settle(10_000);
      await this.#leaveIfBlocked();
      return `pressed ${key}${await this.#observe()}`;
    });
  }

  /** Saves a PNG of the visible page (without the overlay) and returns its path. */
  async screenshot(path?: string): Promise<string> {
    await this.#guard();
    const file = path ?? join(stateDir, "screenshots", `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await this.#overlay({ type: "hide" });
    try {
      const { data } = await this.#send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, "base64"));
    } finally {
      await this.#overlay({ type: "show" });
    }
    return file;
  }

  /** Evaluates a JavaScript expression in the page and returns its JSON value. */
  eval(expression: string): Promise<unknown> {
    const target = expression.length > 200 ? `${expression.slice(0, 200)}…` : expression;
    return this.#audited("eval", target, async () => {
      await this.#guard();
      return this.#evaluate(expression);
    });
  }

  async waitForText(text: string, timeoutMs = 10_000): Promise<void> {
    await this.#guard();
    await this.#announce({ label: `waiting for "${text}"` });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.#evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})`).catch(() => false);
      if (found) return;
      await sleep(200);
    }
    throw new Error(`"${text}" did not appear within ${timeoutMs}ms`);
  }

  wait(ms: number): Promise<void> {
    return sleep(ms);
  }

  /**
   * Waits until the user hands control back. With a message, first asks the user for help
   * (log in, solve a captcha...); without one, waits only if the user took control.
   */
  async handoff(message: string | undefined, timeoutMs = 600_000): Promise<string> {
    const owner = await this.#overlay(message === undefined ? { type: "show" } : { type: "handoff", message });
    if (owner !== "user") return "the agent is in control; the user has not taken over";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      // A navigation wipes the page's memory of who is in control: claim it again for the user.
      if ((await this.#overlay({ type: "claim", message })) === "agent") {
        return `the user handed control back; now on ${await this.url()}. Take a new snapshot before acting.`;
      }
    }
    throw new Error(`the user has not handed control back after ${timeoutMs / 1000}s; run "open-eyes wait" to keep waiting`);
  }

  async owner(): Promise<Owner> {
    return ((await this.#evaluate(OWNER_EXPRESSION).catch(() => null)) as Owner) ?? null;
  }

  async url(): Promise<string> {
    return String(await this.#evaluate("location.href"));
  }

  #send<T = any>(method: string, params: object = {}): Promise<T> {
    return this.#cdp.send<T>(method, params, this.#sessionId);
  }

  async #evaluate(expression: string): Promise<unknown> {
    const { result, exceptionDetails } = await this.#send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    }
    return result.value;
  }

  /**
   * Reads the page and numbers its elements, keeping the refs of elements already seen
   * on this document. Returns the lines and, for the same document, the previous ones.
   */
  async #capture(): Promise<{ lines: string[]; previous?: string[] }> {
    const loaderId = await this.#loaderId();
    const sameDocument = this.#state.refsLoaderId === loaderId;
    const byNode = new Map<number, number>();
    if (sameDocument) {
      for (const [ref, { backendNodeId }] of Object.entries(this.#state.refs)) byNode.set(backendNodeId, Number(ref));
    }
    await this.#send("Accessibility.enable");
    const { nodes } = await this.#send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    const { text, refs, nextRef } = formatSnapshot(nodes, {
      byNode,
      nextRef: sameDocument ? (this.#state.nextRef ?? 1) : 1,
    });

    let previous: string[] | undefined;
    if (sameDocument) {
      try {
        const saved = readFileSync(baselineFile, "utf8");
        previous = saved ? saved.split("\n") : [];
      } catch {
        // No baseline yet.
      }
    }
    Object.assign(this.#state, { refs, refsLoaderId: loaderId, nextRef });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(baselineFile, text);
    return { lines: text ? text.split("\n") : [], previous };
  }

  /** What an action changed, so the agent rarely needs a separate snapshot. */
  async #observe(): Promise<string> {
    await this.#evaluate(WAIT_FOR_QUIET_DOM).catch(() => {}); // Fails if the page navigated.
    if (!OBSERVE || !this.#state.refsLoaderId) return "";
    if (this.#state.refsLoaderId !== (await this.#loaderId())) {
      return `\nthe page changed to ${await this.url()}; run "open-eyes snapshot" to see it`;
    }
    const { lines, previous } = await this.#capture();
    if (!previous) return "";
    const changes = diffLines(previous, lines);
    if (!changes) return `\nthe page changed a lot; run "open-eyes snapshot" to see it`;
    if (!changes.length) return "\nno visible changes";
    const more = changes.length - OBSERVE_LIMIT;
    const tail = more > 0 ? [`… ${more} more changed lines; run "open-eyes snapshot" to see the page`] : [];
    return `\nchanges:\n${[...changes.slice(0, OBSERVE_LIMIT), ...tail].join("\n")}`;
  }

  /** Runs an action and records it in the audit log, whatever the outcome. */
  async #audited<T>(action: string, target: string, run: (entry: AuditEntry) => Promise<T>): Promise<T> {
    const entry: AuditEntry = { action, target, outcome: "ok" };
    entry.url = await this.url().catch(() => undefined);
    try {
      return await run(entry);
    } catch (error) {
      entry.outcome = error instanceof PolicyError ? error.outcome : "error";
      entry.detail = (error as Error).message;
      throw error;
    } finally {
      audit(entry);
    }
  }

  /** Refuses to read or act on a page the policy does not allow. */
  async #guard(): Promise<void> {
    const reason = blockedReason(this.#policy, await this.url());
    if (reason) throw new PolicyError("blocked", `${reason}; open a page that is allowed`);
  }

  /** After an action that may navigate: if it landed somewhere not allowed, leave. */
  async #leaveIfBlocked(): Promise<void> {
    const url = await this.url().catch(() => "about:blank");
    const reason = blockedReason(this.#policy, url);
    if (!reason) return;
    await this.#send("Page.navigate", { url: "about:blank" });
    this.#state.refs = {};
    throw new PolicyError("blocked", `the page went to ${url}, but ${reason}; open-eyes left it`);
  }

  /** Waits for the user to allow a risky action on screen; throws if they deny it. */
  async #confirm(action: string, risky: boolean): Promise<void> {
    const mode = this.#policy.confirm;
    if (mode === "never" || (mode === "risky" && !risky)) return;
    const id = randomUUID();
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Asked again every round, so the question comes back if the page reloads.
      await this.#overlay({ type: "confirm", id, message: action });
      const decision = await this.#evaluate(decisionExpression(id)).catch(() => null);
      if (decision === "allow") return;
      if (decision === "deny") throw new PolicyError("denied", `the user denied: ${action}`);
      await sleep(300);
    }
    throw new PolicyError("denied", `the user did not allow "${action}" within ${CONFIRM_TIMEOUT_MS / 1000}s`);
  }

  /** Updates the overlay and returns who is in control; never fails over drawing. */
  async #overlay(cmd: OverlayCommand): Promise<Owner> {
    return ((await this.#evaluate(overlayExpression(cmd)).catch(() => null)) as Owner) ?? null;
  }

  /** Shows the next action to the human, or refuses it if the human is in control. */
  async #announce(action: OverlayAction & { busy?: boolean }, pause = true): Promise<void> {
    if ((await this.#overlay({ type: "action", ...action })) === "user") throw new Error(USER_IN_CONTROL);
    if (pause && SLOWMO_MS > 0) await sleep(SLOWMO_MS);
  }

  async #resolve(ref: string): Promise<Ref> {
    const key = ref.replace(/^@/, "");
    const found = this.#state.refs[key];
    if (!found) throw new Error(`unknown ref @${key}; run "open-eyes snapshot" to get current refs`);
    // Node ids can be reused by a new document, so a ref from before a navigation
    // could silently point at an unrelated element.
    if (this.#state.refsLoaderId !== (await this.#loaderId())) {
      throw new Error(`@${key} is from a page that is no longer loaded; run "open-eyes snapshot" again`);
    }
    return found;
  }

  async #loaderId(): Promise<string> {
    const { frameTree } = await this.#send<{ frameTree: { frame: { loaderId: string } } }>("Page.getFrameTree");
    return frameTree.frame.loaderId;
  }

  async #locate(backendNodeId: number, ref: string): Promise<Box> {
    try {
      await this.#send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
      const { model } = await this.#send<{ model: { border: number[] } }>("DOM.getBoxModel", { backendNodeId });
      const xs = model.border.filter((_, i) => i % 2 === 0);
      const ys = model.border.filter((_, i) => i % 2 === 1);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    } catch {
      throw new Error(`${ref} is gone or not visible; the page changed, run "open-eyes snapshot" again`);
    }
  }

  /** Waits for the document to finish loading, tolerating navigations in progress. */
  async #settle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.#evaluate("document.readyState").catch(() => "loading");
      if (ready === "complete") return;
      await sleep(100);
    }
  }
}
