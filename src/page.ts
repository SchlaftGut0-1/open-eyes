import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CDP } from "./cdp.ts";
import { overlayExpression, type OverlayAction } from "./overlay.ts";
import { formatSnapshot, type AXNode } from "./snapshot.ts";
import { stateDir, type Ref, type State } from "./state.ts";

export type Box = { x: number; y: number; width: number; height: number };

/** Pause after showing an action so the human can follow along. 0 disables it. */
const SLOWMO_MS = Number(process.env.OPEN_EYES_SLOWMO ?? 400);

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

/** The agent's window. Every action is drawn on the page before it happens. */
export class Page {
  #cdp: CDP;
  #sessionId: string;
  #state: State;

  constructor(cdp: CDP, sessionId: string, state: State) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
    this.#state = state;
  }

  async init(): Promise<void> {
    // The agent's window is usually not focused; make the page behave as if it were.
    await this.#send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }

  async goto(url: string): Promise<string> {
    const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
    await this.#show({ label: `opening ${target}` });
    const { errorText } = await this.#send<{ errorText?: string }>("Page.navigate", { url: target });
    if (errorText) throw new Error(`could not open ${target}: ${errorText}`);
    this.#state.refs = {};
    await this.#settle(30_000);
    const current = await this.url();
    await this.#show({ label: `on ${current}` }, false);
    return current;
  }

  async snapshot(): Promise<string> {
    await this.#send("Accessibility.enable");
    const { nodes } = await this.#send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    const { text, refs } = formatSnapshot(nodes);
    this.#state.refs = refs;
    this.#state.refsLoaderId = await this.#loaderId();
    const title = await this.eval("document.title");
    return `url: ${await this.url()}\ntitle: ${JSON.stringify(title)}\n\n${text}`;
  }

  async click(ref: string): Promise<string> {
    const { backendNodeId, label } = await this.#resolve(ref);
    const box = await this.#locate(backendNodeId, ref);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.#show({ label: `click ${label}`, x, y, box });
    await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.#send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
    await sleep(150);
    await this.#settle(10_000);
    return `clicked ${label}`;
  }

  async fill(ref: string, text: string): Promise<string> {
    const { backendNodeId, label } = await this.#resolve(ref);
    const box = await this.#locate(backendNodeId, ref);
    await this.#show({ label: `typing into ${label}`, x: box.x + 8, y: box.y + box.height / 2, box });
    await this.#send("DOM.focus", { backendNodeId });
    const { object } = await this.#send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId });
    await this.#send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: SELECT_CONTENTS });
    // Inserting over the selection replaces existing content and fires real input events.
    if (text) await this.#send("Input.insertText", { text });
    else await this.press("Backspace", false);
    return `filled ${label}`;
  }

  async press(key: string, announce = true): Promise<string> {
    const def = KEYS[key] ?? (key.length === 1 ? { code: "", keyCode: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!def) throw new Error(`unknown key "${key}"; use a single character or one of: ${Object.keys(KEYS).join(", ")}`);
    if (announce) await this.#show({ label: `press ${key}` });
    const common = { key: key === "Space" ? " " : key, code: def.code, windowsVirtualKeyCode: def.keyCode };
    await this.#send("Input.dispatchKeyEvent", { type: def.text ? "keyDown" : "rawKeyDown", text: def.text, ...common });
    await this.#send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    if (announce) await this.#settle(10_000);
    return `pressed ${key}`;
  }

  /** Saves a PNG of the visible page (without the overlay) and returns its path. */
  async screenshot(path?: string): Promise<string> {
    const file = path ?? join(stateDir, "screenshots", `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await this.#evaluate(overlayExpression(null));
    try {
      const { data } = await this.#send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, "base64"));
    } finally {
      await this.#show({ label: "took a screenshot" }, false);
    }
    return file;
  }

  /** Evaluates a JavaScript expression in the page and returns its JSON value. */
  eval(expression: string): Promise<unknown> {
    return this.#evaluate(expression);
  }

  async waitForText(text: string, timeoutMs = 10_000): Promise<void> {
    await this.#show({ label: `waiting for "${text}"` });
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

  async #show(action: OverlayAction, pause = true): Promise<void> {
    // The overlay is a courtesy to the human watching; never fail an action over it.
    await this.#evaluate(overlayExpression(action)).catch(() => {});
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
