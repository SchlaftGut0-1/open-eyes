import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { audit, type AuditEntry } from "./audit.ts";
import { describeDialog, openDialog, type Dialog } from "./dialogs.ts";
import type { CDP } from "./cdp.ts";
import { decisionExpression, OVERLAY_WORLD, OWNER_EXPRESSION, overlayExpression, type OverlayAction, type OverlayCommand, type Owner } from "./overlay.ts";
import { blockedReason, isRiskyClick, loadPolicy, PolicyError, type Policy } from "./policy.ts";
import { formatSnapshot, nodeKey, type AXNode, type Frame, type LineNode } from "./snapshot.ts";
import { stateDir, type Ref, type State } from "./state.ts";
import { diffLines, findLines, interactiveIndexes, paginate, refsByName, subtree, viewportView, type Position } from "./view.ts";

export type Box = { x: number; y: number; width: number; height: number };

/** An element to act on: a ref from a snapshot ("@3"), or its accessible name and role. */
export type Target = string | { name: string; role?: string };
const describeTarget = (target: Target) =>
  typeof target === "string" ? target : `${target.role ? `${target.role} ` : ""}${JSON.stringify(target.name)}`;

/** Pause after showing an action so the human can follow along. 0 disables it. */
const SLOWMO_MS = Number(process.env.OPEN_EYES_SLOWMO ?? 400);

/** Default snapshot page size in lines; 0 shows everything. */
const SNAPSHOT_LIMIT = Number(process.env.OPEN_EYES_SNAPSHOT_LIMIT ?? 400);
/** After an action, report what changed on the page (off with OPEN_EYES_OBSERVE=0). */
const OBSERVE = process.env.OPEN_EYES_OBSERVE !== "0";
const OBSERVE_LIMIT = 80;
/** A diff this large (in changed lines, and as a share of the page) is reported as a page change. */
const PAGE_CHANGE_LINES = 40;
const PAGE_CHANGE_SHARE = 0.5;

/** The URL without its #fragment: jumping to a section is not a page change. */
const withoutHash = (url: string) => url.replace(/#.*$/, "");
/** The last snapshot's text, the baseline for diffs. */
const baselineFile = join(stateDir, "snapshot.txt");

export type SnapshotOptions = {
  /** The whole page instead of what is on screen. */
  full?: boolean;
  /** Only elements with refs, headings and the containers that place them. */
  interactive?: boolean;
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

export const USER_IN_CONTROL =
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

// Picks the <option> matching `wanted` (exact text, then ignoring case, then contained) in a
// native <select>, through the native setter so frameworks like React see the change.
const CHOOSE_OPTION = `function (wanted) {
  if (!(this instanceof HTMLSelectElement)) return { native: false };
  const options = [...this.options];
  const norm = (text) => text.trim().toLowerCase();
  const option =
    options.find((o) => o.text.trim() === wanted) ??
    options.find((o) => norm(o.text) === norm(wanted)) ??
    options.find((o) => norm(o.text).includes(norm(wanted)));
  if (!option) return { native: true, available: options.map((o) => o.text.trim()) };
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(this, option.value);
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return { native: true, chosen: option.text.trim() };
}`;

// A native <select> shows its options in a browser popup, where a click on an option does
// nothing; clicking one should choose it instead. Lists (multiple or size > 1) take real clicks.
const DROPDOWN_OF_OPTION = `function () {
  const select = this instanceof HTMLOptionElement && this.closest("select");
  return select && !select.multiple && select.size <= 1 ? select : null;
}`;
const CHOOSE_THIS_OPTION = `function () {
  const select = this.closest("select");
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex").set.call(select, this.index);
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return this.text.trim();
}`;

// After an action, wait until the page has had no content request (fetch or XHR) in flight
// for QUIET_MS, at most MAX_NETWORK_WAIT_MS: searches often fire after a debounce, and their
// results should be in the page before its changes are reported. Images, sockets and the
// like are ignored, so they never hold an action up.
const MAX_NETWORK_WAIT_MS = 2000;
const CONTENT_REQUESTS = new Set(["Fetch", "XHR"]);

// What fill can do with an element: type into it, choose in it (a native <select>), or
// nothing, with what to use instead. Agents and small models trust a "filled" report, so
// fill must fail on a link or a checkbox instead of pretending it typed.
const FIELD_KIND = `function () {
  if (this instanceof HTMLSelectElement) return { kind: "select" };
  if (this.isContentEditable) return { kind: "text" };
  if (this instanceof HTMLTextAreaElement || this instanceof HTMLInputElement) {
    const type = this instanceof HTMLInputElement ? this.type : "textarea";
    if (type === "file") return { kind: "none", instead: "upload" };
    if (["checkbox", "radio", "button", "submit", "reset", "image", "range", "color", "hidden"].includes(type)) {
      return { kind: "none", instead: "click" };
    }
    if (this.readOnly || this.disabled) return { kind: "none", readOnly: true };
    return { kind: type === "password" ? "password" : "text" };
  }
  return { kind: "none", instead: "click" };
}`;

// Whether submitting a form is worth asking about. A search is not: a form in a search
// landmark, or one whose only field is a search box. A form with a password field always
// is, and so is any other form. Enter and a click on the form's submit button use the same
// rule, so neither is a way around the other.
const RISKY_FORM = `(form) => {
  if (form.querySelector("input[type=password]")) return true;
  if (form.closest("search, [role=search]")) return false;
  const fields = [...form.querySelectorAll("input, textarea, select")]
    .filter((f) => !["hidden", "submit", "button", "reset", "image"].includes(f.type));
  return !(fields.length === 1 && fields[0].type === "search");
}`;

// Whether Enter in the focused field submits a form worth asking about.
const SUBMITS_RISKY_FORM = `(() => {
  const form = document.activeElement?.closest?.("form");
  return !!form && (${RISKY_FORM})(form);
})()`;

// Whether clicking this element submits a form worth asking about: a submit button (a
// <button> without a type is one) or a submit/image input, of a form.
const CLICK_SUBMITS_RISKY_FORM = `function () {
  const submits =
    (this instanceof HTMLButtonElement && this.type === "submit") ||
    (this instanceof HTMLInputElement && (this.type === "submit" || this.type === "image"));
  return submits && !!this.form && (${RISKY_FORM})(this.form);
}`;

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

// Scrolls the element into view so a person sees the page move, and resolves once it stopped
// (or after a second, for pages that never say so).
const SMOOTH_INTO_VIEW = `function () {
  const r = this.getBoundingClientRect();
  if (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) return;
  return new Promise((resolve) => {
    const done = () => resolve();
    document.addEventListener("scrollend", done, { once: true, capture: true });
    setTimeout(done, 1000);
    this.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  });
}`;

/** Where downloads started by agent actions are saved. */
const DOWNLOADS_DIR = process.env.OPEN_EYES_DOWNLOADS ?? join(homedir(), "Downloads", "open-eyes");
const DOWNLOAD_TIMEOUT_MS = 120_000;

// The file input an upload goes to: the element itself, one inside it, the control of a
// label, or the only file input of its form or page (styled "Attach" buttons hide theirs).
const FIND_FILE_INPUT = `function () {
  const isFile = (el) => el instanceof HTMLInputElement && el.type === "file";
  if (isFile(this)) return this;
  const inside = this.querySelector?.('input[type="file"]');
  if (inside) return inside;
  if (isFile(this.control)) return this.control;
  for (const scope of [this.closest?.("form"), document]) {
    const inputs = scope ? scope.querySelectorAll('input[type="file"]') : [];
    if (inputs.length === 1) return inputs[0];
  }
  return null;
}`;

/** How long a risky action waits for the user to allow it before it is denied. */
const CONFIRM_TIMEOUT_MS = 120_000;

/** How long a page may take to answer before open-eyes says it is blocked. */
const BLOCKED_MS = 2000;

const BLOCKED_BY_DIALOG =
  "the page is not responding: it is probably showing a dialog (alert, confirm or prompt) that " +
  "open-eyes cannot answer. Ask the user to answer it in the agent window, or run " +
  '"open-eyes close" to close the window';

/** The agent's window. Every action is drawn on the page before it happens. */
export class Page {
  /** Set once text is typed into a password field, so traces can leave it out. */
  typedSecret = false;
  /** What the user allowed during the current action, for the audit log. */
  #allowed: string[] = [];
  /** Tabs the agent's window opened during the current action. */
  #opened: string[] = [];
  #cdp: CDP;
  #sessionId: string;
  #state: State;
  #policy: Policy;
  /** Cross-origin iframes, by frame id: their session, the frame holding them, and their <iframe>. */
  #frames = new Map<string, { session: string; parent?: string; owner?: number }>();
  /** Sessions already told to attach to their cross-origin iframes. */
  #autoAttached = new Set<string>();

  constructor(cdp: CDP, sessionId: string, state: State) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
    this.#state = state;
    this.#policy = loadPolicy();
    cdp.on("Target.attachedToTarget", ({ sessionId: session, targetInfo }, parentSession) => {
      if (targetInfo.type !== "iframe") return;
      const parent = [...this.#frames].find(([, info]) => info.session === parentSession)?.[0];
      if (parentSession === this.#sessionId || parent) this.#frames.set(targetInfo.targetId, { session, parent });
    });
    cdp.on("Target.detachedFromTarget", ({ sessionId: session }) => {
      for (const [frame, info] of this.#frames) if (info.session === session) this.#frames.delete(frame);
    });
    cdp.on("Target.targetCreated", ({ targetInfo }) => {
      if (targetInfo.type === "page" && targetInfo.openerId === this.#state.targetId) this.#opened.push(targetInfo.targetId);
    });
  }

  async init(): Promise<void> {
    this.#refuseIfDialog();
    // A dialog nobody watched (opened before open-eyes was) blocks the page: say so in
    // seconds instead of hanging.
    let timer: NodeJS.Timeout | undefined;
    const blocked = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(BLOCKED_BY_DIALOG)), BLOCKED_MS)));
    try {
      await Promise.race([
        (async () => {
          // The agent's window is usually not focused; make the page behave as if it were.
          await this.#send("Emulation.setFocusEmulationEnabled", { enabled: true });
          await this.#evaluate("1");
        })(),
        blocked,
      ]);
    } finally {
      clearTimeout(timer);
    }
    await this.#cdp.send("Target.setDiscoverTargets", { discover: true });
  }

  /** While a dialog is open the page cannot do anything else: the agent must answer it. */
  #refuseIfDialog(): void {
    const dialog = openDialog(this.#state.targetId);
    if (dialog) throw new Error(describeDialog(dialog));
  }

  /** Resolves with the dialog the page opens, if it opens one before `stop` is called. */
  #watchForDialog(): { opened: Promise<Dialog>; stop: () => void } {
    let timer: NodeJS.Timeout | undefined;
    const opened = new Promise<Dialog>((resolve) => {
      timer = setInterval(() => {
        const dialog = openDialog(this.#state.targetId);
        if (dialog) resolve(dialog);
      }, 100);
    });
    return { opened, stop: () => clearInterval(timer) };
  }

  /**
   * After an action that opened a tab from the agent's window (a link with target=_blank,
   * window.open), the agent follows it: that tab becomes the agent window.
   */
  async #followOpenedTab(): Promise<string> {
    const targetId = this.#opened.at(-1);
    this.#opened = [];
    if (!targetId) return "";
    await this.#overlay({ type: "hide" }); // The old tab is no longer the agent's.
    const { sessionId } = await this.#cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    this.#sessionId = sessionId;
    this.#frames.clear();
    this.#autoAttached.clear();
    Object.assign(this.#state, { targetId, refs: {}, refsLoaderId: undefined });
    await this.init();
    await this.#settle(10_000);
    await this.#leaveIfBlocked();
    const url = await this.url();
    await this.#announce({ label: `on ${url}` }, false);
    return `\nit opened a new tab, which is now the agent window: ${url}; run "open-eyes snapshot" to see it`;
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
    this.#refuseIfDialog();
    await this.#guard();
    if (options.interactive && options.diff) throw new Error("--interactive cannot be combined with --diff");
    const captured = await this.#capture();
    const { previous } = captured;
    let { lines, lineNodes } = captured;
    if (options.interactive) {
      const keep = interactiveIndexes(lines, lineNodes.map((n) => n.role));
      lines = keep.map((i) => lines[i]);
      lineNodes = keep.map((i) => lineNodes[i]);
    }
    let header = "";
    let body: string[];
    let footer: string[] = [];
    if (!options.full && !options.diff && !options.scope && !options.find) {
      // The default: what the user would see, which is usually what the agent needs.
      const { positions, viewport } = await this.#positions(lineNodes);
      const { shown, hidden, outline } = viewportView(lines, lineNodes.map((n) => n.role), positions);
      body = shown;
      if (viewport.pageHeight > viewport.height) {
        const percent = Math.round((100 * viewport.height) / viewport.pageHeight);
        header = `\non screen: ${viewport.top}-${viewport.top + viewport.height} px of ${viewport.pageHeight.toLocaleString("en-US")} (${percent}%)`;
      }
      if (hidden) {
        footer = [
          "",
          `off screen: ${hidden.toLocaleString("en-US")} more lines${outline.length ? ". Outline:" : ""}`,
          ...outline,
          "search them with --find <text>, or see everything with --full",
        ];
      }
    } else if (options.diff) {
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
    const shown = [...paginate(body, options.limit ?? SNAPSHOT_LIMIT, options.page), ...footer];
    return `url: ${await this.url()}\ntitle: ${JSON.stringify(title)}${header}\n\n${shown.join("\n")}`;
  }

  click(target: Target): Promise<string> {
    return this.#audited("click", describeTarget(target), async (entry) => {
      await this.#guard();
      const { backendNodeId, label, ref, frame } = await this.#resolve(target);
      entry.target = label;
      if (label.startsWith("option ")) {
        const chosen = await this.#chooseNativeOption(backendNodeId, label, frame, entry);
        if (chosen) return chosen;
      }
      const box = await this.#locate(backendNodeId, ref, frame);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await this.#announce({ label: `click ${label}`, x, y, busy: true });
      const submits = await this.#clickSubmitsRiskyForm(backendNodeId, frame);
      await this.#confirm(submits ? `click ${label}, which submits a form` : `click ${label}`, submits || isRiskyClick(label));
      const finishDownload = await this.#watchDownloads();
      const network = await this.#trackNetwork();
      await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (const type of ["mousePressed", "mouseReleased"]) {
        await this.#send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      await this.#overlay({ type: "idle" });
      await sleep(150);
      await this.#settle(10_000);
      await this.#leaveIfBlocked();
      const observed = await this.#observe(entry.url, network);
      const download = await finishDownload();
      if (download.saved) entry.target += ` (downloaded ${basename(download.saved)})`;
      return `clicked ${label}${observed}${download.report}`;
    });
  }

  fill(target: Target, text: string): Promise<string> {
    return this.#audited("fill", describeTarget(target), async (entry) => {
      await this.#guard();
      const { backendNodeId, label, ref, frame } = await this.#resolve(target);
      entry.target = `${label} (${text.length} characters)`; // Never the text: it may be a secret.
      const { object } = await this.#sendIn<{ object: { objectId: string } }>(frame, "DOM.resolveNode", { backendNodeId });
      const { result: field } = await this.#sendIn<{ result: { value: { kind: string; instead?: string; readOnly?: boolean } } }>(
        frame,
        "Runtime.callFunctionOn",
        { objectId: object.objectId, functionDeclaration: FIELD_KIND, returnByValue: true },
      );
      const { kind, instead, readOnly } = field.value;
      if (kind === "none") {
        if (readOnly) throw new Error(`${label} is read-only, so nothing can be typed into it`);
        const hint = instead === "upload" ? `use upload ${ref} <file>` : `use click ${ref}; if that opens a field, fill the field`;
        throw new Error(`${label} cannot be typed into; ${hint}`);
      }
      const box = await this.#locate(backendNodeId, ref, frame);
      if (kind === "select") {
        // Typing into a native dropdown means choosing the option with that text.
        entry.action = "select";
        entry.target = `${label} → ${text}`;
        await this.#announce({ label: `choose "${text}" in ${label}`, x: box.x + box.width / 2, y: box.y + box.height / 2 });
        const { result } = await this.#sendIn(frame, "Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: CHOOSE_OPTION,
          arguments: [{ value: text }],
          returnByValue: true,
        });
        const chosen = result.value as { chosen?: string; available: string[] };
        if (!chosen.chosen) throw new Error(`no option "${text}" in ${label}; options: ${chosen.available.join(", ")}`);
        return `chose "${chosen.chosen}" in ${label}${await this.#observe(entry.url)}`;
      }
      await this.#announce({ label: `typing into ${label}`, x: box.x + 8, y: box.y + box.height / 2 });
      await this.#confirm(`type into ${label}, a password field`, kind === "password");
      if (kind === "password") this.typedSecret = true;
      await this.#sendIn(frame, "DOM.focus", { backendNodeId });
      const network = await this.#trackNetwork();
      await this.#sendIn(frame, "Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: SELECT_CONTENTS });
      // Inserting over the selection replaces existing content and fires real input events.
      if (text) await this.#send("Input.insertText", { text });
      else await this.press("Backspace", false);
      return `filled ${label}${await this.#observe(entry.url, network)}`;
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
    return this.#audited("press", key, async (entry) => {
      await this.#guard();
      await this.#announce({ label: `press ${key}` });
      const submits = key === "Enter" && (await this.#evaluate(SUBMITS_RISKY_FORM));
      await this.#confirm("press Enter, which submits a form", submits === true);
      const finishDownload = await this.#watchDownloads();
      const network = await this.#trackNetwork();
      await dispatch();
      await this.#settle(10_000);
      await this.#leaveIfBlocked();
      const observed = await this.#observe(entry.url, network);
      const download = await finishDownload();
      if (download.saved) entry.target += ` (downloaded ${basename(download.saved)})`;
      return `pressed ${key}${observed}${download.report}`;
    });
  }

  /**
   * Sets local files on a file input, after the user allows it: it sends files to the site.
   * The audit log gets the file names, never their contents.
   */
  upload(target: Target, files: string[]): Promise<string> {
    return this.#audited("upload", describeTarget(target), async (entry) => {
      await this.#guard();
      const paths = files.map((file) => resolve(file));
      for (const path of paths) {
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`no such file: ${path}`);
      }
      const names = paths.map((path) => basename(path)).join(", ");
      const { backendNodeId, label, ref, frame } = await this.#resolve(target);
      entry.target = `${label} <- ${names}`;
      const box = await this.#locate(backendNodeId, ref, frame);
      await this.#announce({ label: `upload ${names} to ${label}`, x: box.x + box.width / 2, y: box.y + box.height / 2 });
      const { object } = await this.#sendIn<{ object: { objectId: string } }>(frame, "DOM.resolveNode", { backendNodeId });
      const { result } = await this.#sendIn(frame, "Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: FIND_FILE_INPUT });
      if (!result.objectId) throw new Error(`${label} is not a file input and no file input belongs to it`);
      const host = URL.parse(await this.url())?.host || "this page";
      await this.#confirm(`upload ${names} to ${host}`, true);
      await this.#sendIn(frame, "DOM.setFileInputFiles", { files: paths, objectId: result.objectId });
      return `uploaded ${names} to ${label}${await this.#observe(entry.url)}`;
    });
  }

  /** Moves the mouse over an element (menus, tooltips) and reports what appeared. */
  hover(target: Target): Promise<string> {
    return this.#audited("hover", describeTarget(target), async (entry) => {
      await this.#guard();
      const { backendNodeId, label, ref, frame } = await this.#resolve(target);
      entry.target = label;
      const box = await this.#locate(backendNodeId, ref, frame);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await this.#announce({ label: `hover over ${label}`, x, y, busy: true });
      // A real mouse move fires CSS :hover and mouseenter/mouseover listeners alike.
      const network = await this.#trackNetwork();
      await this.#send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.#overlay({ type: "idle" });
      return `hovered over ${label}${await this.#observe(entry.url, network)}`;
    });
  }

  /**
   * A click on an option of a native dropdown chooses it, like `select` does, since the click
   * itself would do nothing. Returns undefined for any other option, which takes a real click.
   */
  async #chooseNativeOption(backendNodeId: number, label: string, frame: string | undefined, entry: AuditEntry): Promise<string | undefined> {
    const { object } = await this.#sendIn<{ object: { objectId: string } }>(frame, "DOM.resolveNode", { backendNodeId });
    const { result: select } = await this.#sendIn<{ result: { objectId?: string } }>(frame, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: DROPDOWN_OF_OPTION,
    });
    if (!select.objectId) return undefined;
    const { node } = await this.#sendIn<{ node: { backendNodeId: number } }>(frame, "DOM.describeNode", { objectId: select.objectId });
    const [selectRef, selectInfo] = Object.entries(this.#state.refs).find(
      ([, ref]) => ref.backendNodeId === node.backendNodeId && ref.frame === frame,
    ) ?? [undefined, undefined];
    const selectLabel = selectInfo?.label ?? "a dropdown";
    const name = label.replace(/^option /, "");
    entry.action = "select";
    entry.target = `${selectLabel} → ${name.replace(/^"|"$/g, "")}`;
    const box = await this.#locate(node.backendNodeId, selectRef ? `@${selectRef}` : "the dropdown", frame);
    await this.#announce({ label: `choose ${name} in ${selectLabel}`, x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const { result } = await this.#sendIn(frame, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: CHOOSE_THIS_OPTION,
      returnByValue: true,
    });
    return `chose "${result.value}" in ${selectLabel}${await this.#observe(entry.url)}`;
  }

  /**
   * Chooses `option` (by its visible text) in a dropdown: a native <select> directly, or a
   * custom listbox/combobox by opening it and clicking the matching option.
   */
  select(target: Target, option: string): Promise<string> {
    return this.#audited("select", describeTarget(target), async (entry) => {
      await this.#guard();
      const { backendNodeId, label, ref, frame } = await this.#resolve(target);
      entry.target = `${label} → ${option}`;
      const box = await this.#locate(backendNodeId, ref, frame);
      await this.#announce({ label: `choose "${option}" in ${label}`, x: box.x + box.width / 2, y: box.y + box.height / 2 });
      const { object } = await this.#sendIn<{ object: { objectId: string } }>(frame, "DOM.resolveNode", { backendNodeId });
      const { result } = await this.#sendIn(frame, "Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: CHOOSE_OPTION,
        arguments: [{ value: option }],
        returnByValue: true,
      });
      const native = result.value as { native: boolean; chosen?: string; available?: string[] };
      if (native.native) {
        if (!native.chosen) throw new Error(`no option "${option}" in ${label}; options: ${native.available!.join(", ")}`);
        return `chose "${native.chosen}" in ${label}${await this.#observe(entry.url)}`;
      }

      // A custom dropdown: open it, then click one of the options that appeared. Options that
      // were already there belong to other dropdowns on the page.
      const isOption = (line: string) => /^\s*option /.test(line) && / @\d+$/.test(line);
      const before = new Set((await this.#capture()).lines.filter(isOption));
      await this.click(ref);
      const shown = (await this.#capture()).lines.filter(isOption);
      const appeared = shown.filter((line) => !before.has(line));
      const optionLines = appeared.length ? appeared : shown;
      const nameOf = (line: string) => line.trim().replace(/^option /, "").replace(/( \[[^\]]*\])? @\d+$/, "").replace(/^"|"$/g, "");
      const norm = (text: string) => text.trim().toLowerCase();
      const match =
        optionLines.find((line) => nameOf(line) === option) ??
        optionLines.find((line) => norm(nameOf(line)) === norm(option)) ??
        optionLines.find((line) => norm(nameOf(line)).includes(norm(option)));
      if (!match) {
        const available = optionLines.map(nameOf);
        throw new Error(
          available.length
            ? `no option "${option}" in ${label}; options: ${available.join(", ")}`
            : `${label} did not show any options after opening it`,
        );
      }
      const clicked = await this.click(match.match(/@\d+$/)![0]);
      // Keep the changes the click reported, under a line that says what was chosen.
      return `chose "${nameOf(match)}" in ${label}${clicked.replace(/^clicked [^\n]*/, "")}`;
    });
  }

  /**
   * Scrolls with real mouse-wheel events, so lazy loading triggers and apps that scroll
   * inside a container move too. Without a ref the wheel turns at the center of the page;
   * with one it turns over that element, scrolling whatever container holds it; a ref and
   * no direction brings the element into view. Returns what is on screen afterwards.
   */
  scroll(ref?: string, direction?: "down" | "up", pixels?: number): Promise<string> {
    const target = [ref, direction, pixels].filter((part) => part !== undefined).join(" ") || "down";
    return this.#audited("scroll", target, async (entry) => {
      await this.#guard();
      const [width, height, before] = (await this.#evaluate("[innerWidth, innerHeight, scrollY]")) as number[];
      let summary: string;
      let network: (() => Promise<boolean>) | undefined;
      let check: (() => Promise<void>) | undefined;
      if (ref && !direction) {
        const { backendNodeId, label, frame } = await this.#resolve(ref);
        entry.target = label;
        await this.#smoothIntoView(backendNodeId, frame);
        const box = await this.#locate(backendNodeId, ref, frame); // Already in view, unless in an iframe.
        await this.#announce({ label: `scroll to ${label}`, x: box.x + box.width / 2, y: box.y + box.height / 2 });
        summary = `scrolled to ${label}`;
        // Only claim it once it is still on screen when the page has settled.
        check = async () => {
          const now = await this.#locate(backendNodeId, ref, frame, { scroll: false });
          if (await this.#inWindow(now)) return;
          const where = now.y + now.height <= 0 ? "above" : "below";
          summary = `could not bring ${label} into view: it is still ${where} the screen; try scroll ${where === "above" ? "up" : "down"}`;
        };
      } else {
        let x = width / 2;
        let y = height / 2;
        let where = "the page";
        if (ref) {
          const { backendNodeId, label, frame } = await this.#resolve(ref);
          const box = await this.#locate(backendNodeId, ref, frame);
          x = box.x + box.width / 2;
          y = box.y + box.height / 2;
          where = `the area of ${label}`;
        }
        const distance = Math.round(pixels ?? height * 0.85);
        const dir = direction ?? "down";
        await this.#announce({ label: `scroll ${dir} ${where}`, x, y, busy: true });
        network = await this.#trackNetwork(); // Lazy loading fetches as the page moves.
        await this.#wheel(x, y, dir === "down" ? distance : -distance);
        await this.#overlay({ type: "idle" });
        summary = `scrolled ${dir} ${distance} px in ${where}`;
      }
      await this.#settleAfterAction(network);
      await sleep(150); // Let smooth scrolling settle.
      await check?.();
      const after = (await this.#evaluate("scrollY")) as number;
      if (!ref && after === before) {
        summary += ` but the page did not move (already at the ${direction === "up" ? "top" : "bottom"}, or the content scrolls inside a container: try scroll @N ${direction ?? "down"})`;
      }
      return `${summary}\n${await this.snapshot()}`;
    });
  }

  /**
   * Turns the mouse wheel by `delta` pixels over (x, y) in small steps that speed up and slow
   * down, as a person scrolling does, instead of one jump.
   */
  async #wheel(x: number, y: number, delta: number): Promise<void> {
    const steps = Math.min(Math.max(Math.round(Math.abs(delta) / 30), 6), 24);
    const pause = Math.min(Math.max(Math.abs(delta) * 0.6, 250), 600) / steps;
    const ease = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
    let done = 0;
    for (let step = 1; step <= steps; step++) {
      const next = Math.round(delta * ease(step / steps));
      await this.#send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: next - done });
      done = next;
      await sleep(pause);
    }
  }

  /** Scrolls the element to the middle of its scroller smoothly, if it is not on screen. */
  async #smoothIntoView(backendNodeId: number, frame?: string): Promise<void> {
    const { object } = await this.#sendIn<{ object: { objectId: string } }>(frame, "DOM.resolveNode", { backendNodeId });
    await this.#sendIn(frame, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      awaitPromise: true,
      functionDeclaration: SMOOTH_INTO_VIEW,
    }).catch(() => {}); // #locate scrolls it anyway.
  }

  /**
   * Saves a PNG of the visible page (without the overlay) and returns its path. With a ref,
   * only that element, scrolled into view first: far fewer image tokens than a full screen.
   */
  async screenshot(path?: string, ref?: string): Promise<string> {
    await this.#guard();
    const file = path ?? join(stateDir, "screenshots", `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (ref) {
      const { backendNodeId, frame } = await this.#resolve(ref);
      const box = await this.#locate(backendNodeId, ref, frame); // Scrolls it into view.
      if (box.width < 1 || box.height < 1) throw new Error(`${ref} has no visible size to capture`);
      // The box is relative to the viewport; the clip is in page coordinates.
      const [scrollX, scrollY] = (await this.#evaluate("[scrollX, scrollY]")) as number[];
      clip = { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height, scale: 1 };
    }
    await this.#overlay({ type: "hide" });
    try {
      const { data } = await this.#send<{ data: string }>("Page.captureScreenshot", { format: "png", ...(clip && { clip }) });
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

  /** Shows the token counter in the agent window, or hides it with null. */
  async showUsage(text: string | null): Promise<void> {
    if (openDialog(this.#state.targetId)) return; // The overlay cannot draw until it is answered.
    await this.#overlay({ type: "usage", text });
  }

  async owner(): Promise<Owner> {
    const owner = ((await this.#evaluateInOverlayWorld(OWNER_EXPRESSION).catch(() => null)) as Owner) ?? null;
    return owner ?? (this.#state.owner === "user" ? "user" : null);
  }

  async url(): Promise<string> {
    return String(await this.#evaluate("location.href"));
  }

  #send<T = any>(method: string, params: object = {}): Promise<T> {
    return this.#cdp.send<T>(method, params, this.#sessionId);
  }

  /** Sends to the session holding `frame`'s nodes: a cross-origin iframe's own, or the page's. */
  async #sendIn<T = any>(frame: string | undefined, method: string, params: object = {}): Promise<T> {
    if (frame && !this.#frames.has(frame)) await this.#frameContents(); // Attaches to the iframes.
    const session = frame ? this.#frames.get(frame)?.session : this.#sessionId;
    if (!session) throw new Error(`that iframe is gone; run "open-eyes snapshot" again`);
    return this.#cdp.send<T>(method, params, session);
  }

  /**
   * The accessibility trees of every iframe in the page, keyed by their <iframe> element.
   * Same-process frames are read through their parent's session; cross-origin ones run in
   * other processes, so each is attached and read through its own.
   */
  async #frameContents(): Promise<Map<string, Frame>> {
    const contents = new Map<string, Frame>();
    type FrameTree = { frame: { id: string; url: string }; childFrames?: FrameTree[] };
    const walk = async (frame: string | undefined) => {
      const send = <T = any>(method: string, params: object = {}) => this.#sendIn<T>(frame, method, params);
      const local = async (tree: FrameTree) => {
        for (const child of tree.childFrames ?? []) {
          try {
            const { backendNodeId } = await send("DOM.getFrameOwner", { frameId: child.frame.id });
            const { nodes } = await send("Accessibility.getFullAXTree", { frameId: child.frame.id });
            contents.set(nodeKey(frame, backendNodeId), { nodes, url: child.frame.url, frame });
          } catch {
            continue; // It went away while we looked.
          }
          await local(child);
        }
      };
      await local((await send<{ frameTree: FrameTree }>("Page.getFrameTree")).frameTree);

      const session = frame ? this.#frames.get(frame)!.session : this.#sessionId;
      if (!this.#autoAttached.has(session)) {
        // Reports the iframes already there before it returns, and new ones as they appear.
        await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        this.#autoAttached.add(session);
      }
      for (const [child, info] of [...this.#frames].filter(([, info]) => info.parent === frame)) {
        try {
          info.owner = (await send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: child })).backendNodeId;
          await this.#sendIn(child, "Accessibility.enable");
          const { nodes } = await this.#sendIn<{ nodes: AXNode[] }>(child, "Accessibility.getFullAXTree");
          const { frameTree } = await this.#sendIn<{ frameTree: FrameTree }>(child, "Page.getFrameTree");
          contents.set(nodeKey(frame, info.owner), { nodes, url: frameTree.frame.url, frame: child });
        } catch {
          continue;
        }
        await walk(child);
      }
    };
    await walk(undefined);
    return contents;
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
   * Evaluates in open-eyes' own isolated world of the page (OVERLAY_WORLD): it shares the DOM
   * but not JavaScript with the page, so page scripts cannot read or forge the overlay's
   * state, such as the user's answer to a confirmation. Chromium hands back the same world on
   * every call for the same document, also to later CLI runs, so its state persists.
   */
  async #evaluateInOverlayWorld(expression: string): Promise<unknown> {
    const { frameTree } = await this.#send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const { executionContextId } = await this.#send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: OVERLAY_WORLD,
    });
    const { result, exceptionDetails } = await this.#send("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  /**
   * Reads the page and numbers its elements, keeping the refs of elements already seen
   * on this document. Returns the lines and, for the same document, the previous ones.
   */
  async #capture(): Promise<{ lines: string[]; previous?: string[]; lineNodes: LineNode[] }> {
    const loaderId = await this.#loaderId();
    const sameDocument = this.#state.refsLoaderId === loaderId;
    const byNode = new Map<string, number>();
    if (sameDocument) {
      for (const [ref, { backendNodeId, frame }] of Object.entries(this.#state.refs)) byNode.set(nodeKey(frame, backendNodeId), Number(ref));
    }
    await this.#send("Accessibility.enable");
    const { nodes } = await this.#send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    const frames = await this.#frameContents();
    const { text, refs, nextRef, lineNodes } = formatSnapshot(
      nodes,
      { byNode, nextRef: sameDocument ? (this.#state.nextRef ?? 1) : 1 },
      frames,
    );

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
    return { lines: text ? text.split("\n") : [], previous, lineNodes };
  }

  /** Where each line's element is relative to the viewport, from the page's layout. */
  async #positions(lineNodes: LineNode[]): Promise<{
    positions: Position[];
    viewport: { top: number; height: number; pageHeight: number };
  }> {
    const [left, top, width, height, pageHeight] = (await this.#evaluate(
      "[scrollX, scrollY, innerWidth, innerHeight, document.documentElement.scrollHeight]",
    )) as number[];
    // Layout bounds are in page coordinates; fixed elements appear at the current scroll.
    const { documents } = await this.#send<{
      documents: {
        nodes: { backendNodeId: number[] };
        layout: { nodeIndex: number[]; bounds: number[][] };
        contentHeight?: number;
      }[];
    }>("DOMSnapshot.captureSnapshot", { computedStyles: [] });
    const main = documents[0];
    // On a scaled screen (125%, 200%) the bounds are in device pixels, not the page's CSS
    // pixels (#99). The page's height in both units gives the factor.
    const scale = main?.contentHeight && pageHeight ? main.contentHeight / pageHeight : 1;
    const boxes = new Map<number, [number, number, number, number]>(); // left, top, right, bottom
    main?.layout.nodeIndex.forEach((nodeIndex, i) => {
      const [x, y, w, h] = main.layout.bounds[i].map((value) => value / scale);
      if (w <= 0 && h <= 0) return;
      const id = main.nodes.backendNodeId[nodeIndex];
      const box = boxes.get(id);
      boxes.set(id, box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + w), Math.max(box[3], y + h)] : [x, y, x + w, y + h]);
    });
    const positions = lineNodes.map(({ backendNodeId }): Position => {
      const box = backendNodeId === undefined ? undefined : boxes.get(backendNodeId);
      if (!box) return undefined;
      if (box[3] <= top) return "above";
      if (box[1] >= top + height) return "below";
      if (box[2] <= left || box[0] >= left + width) return "beside";
      return "visible";
    });
    return { positions, viewport: { top: Math.round(top), height: Math.round(height), pageHeight: Math.round(pageHeight) } };
  }

  /**
   * What an action changed, so the agent rarely needs a separate snapshot. A move to another
   * page is one line, also when the site navigates without reloading (GitHub, most apps):
   * a diff of the whole page would cost hundreds of tokens and help nobody.
   */
  async #observe(urlBefore?: string, network?: () => Promise<boolean>): Promise<string> {
    await this.#settleAfterAction(network);
    if (!OBSERVE || !this.#state.refsLoaderId) return "";
    if (this.#state.refsLoaderId !== (await this.#loaderId())) {
      return `\nthe page changed to ${await this.url()}; run "open-eyes snapshot" to see it`;
    }
    const { lines, previous } = await this.#capture();
    if (!previous) return "";
    const url = await this.url();
    if (urlBefore && withoutHash(url) !== withoutHash(urlBefore)) {
      return `\nthe page changed to ${url}; run "open-eyes snapshot" to see it`;
    }
    const changes = diffLines(previous, lines);
    if (!changes) return `\nthe page changed a lot; run "open-eyes snapshot" to see it`;
    if (!changes.length) return "\nno visible changes";
    const changed = changes.filter((line) => !line.startsWith("  ")).length;
    if (changed > Math.max(PAGE_CHANGE_LINES, PAGE_CHANGE_SHARE * Math.max(previous.length, lines.length))) {
      return `\nmost of the page changed (${changed} lines); run "open-eyes snapshot" to see it`;
    }
    const more = changes.length - OBSERVE_LIMIT;
    const tail = more > 0 ? [`… ${more} more changed lines; run "open-eyes snapshot" to see the page`] : [];
    return `\nchanges:\n${[...changes.slice(0, OBSERVE_LIMIT), ...tail].join("\n")}`;
  }

  /**
   * Counts the page's content requests from now on. The returned function waits until none
   * has been in flight for QUIET_MS after the action (at most MAX_NETWORK_WAIT_MS) and says
   * whether any were seen.
   */
  async #trackNetwork(): Promise<() => Promise<boolean>> {
    const inflight = new Set<string>();
    let seen = false;
    let lastChange = Date.now();
    const mine = (sessionId?: string) => sessionId === this.#sessionId;
    const done = (p: { requestId: string }, sessionId?: string) => {
      if (mine(sessionId) && inflight.delete(p.requestId)) lastChange = Date.now();
    };
    const stops = [
      this.#cdp.on("Network.requestWillBeSent", (p, sessionId) => {
        if (!mine(sessionId) || !CONTENT_REQUESTS.has(p.type)) return;
        inflight.add(p.requestId);
        seen = true;
        lastChange = Date.now();
      }),
      this.#cdp.on("Network.loadingFinished", done),
      this.#cdp.on("Network.loadingFailed", done),
    ];
    await this.#send("Network.enable").catch(() => {});
    return async () => {
      // Count quiet time from the end of the action, so a debounced request still starts in it.
      lastChange = Math.max(lastChange, Date.now());
      const deadline = Date.now() + MAX_NETWORK_WAIT_MS;
      try {
        while (Date.now() < deadline && (inflight.size > 0 || Date.now() - lastChange < QUIET_MS)) await sleep(50);
      } finally {
        for (const stop of stops) stop();
      }
      return seen;
    };
  }

  /** Waits for the DOM, and the network if tracked, to settle; fails quietly mid-navigation. */
  async #settleAfterAction(network?: () => Promise<boolean>): Promise<void> {
    const quietDom = this.#evaluate(WAIT_FOR_QUIET_DOM).catch(() => {});
    if (!network) return void (await quietDom);
    const [fetched] = await Promise.all([network(), quietDom]);
    if (fetched) await this.#evaluate(WAIT_FOR_QUIET_DOM).catch(() => {}); // Let the results render.
  }

  /**
   * Routes downloads to DOWNLOADS_DIR while an action runs. The returned function waits for a
   * download the action started, saves it under its suggested name (made unique) and puts
   * the browser's download behavior back to normal, so the user's own downloads are untouched.
   */
  async #watchDownloads(): Promise<() => Promise<{ saved?: string; report: string }>> {
    let began: { guid: string; name: string } | undefined;
    let state: string | undefined;
    const stopBegin = this.#cdp.on("Browser.downloadWillBegin", (p) => (began ??= { guid: p.guid, name: p.suggestedFilename }));
    const stopProgress = this.#cdp.on("Browser.downloadProgress", (p) => {
      if (began && p.guid === began.guid && p.state !== "inProgress") state = p.state;
    });
    mkdirSync(DOWNLOADS_DIR, { recursive: true });
    await this.#cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: DOWNLOADS_DIR, eventsEnabled: true });
    return async () => {
      try {
        if (!began) return { report: "" };
        const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
        while (!state && Date.now() < deadline) await sleep(100);
        if (state !== "completed") return { report: `\nthe download of ${began.name} did not finish (${state ?? "timed out"})` };
        // allowAndName saves under the download's id; give it its real name without overwriting.
        const name = basename(began.name) || "download";
        let saved = join(DOWNLOADS_DIR, name);
        for (let n = 1; existsSync(saved); n++) {
          saved = join(DOWNLOADS_DIR, `${basename(name, extname(name))} (${n})${extname(name)}`);
        }
        renameSync(join(DOWNLOADS_DIR, began.guid), saved);
        return { saved, report: `\ndownloaded ${saved}` };
      } finally {
        stopBegin();
        stopProgress();
        await this.#cdp.send("Browser.setDownloadBehavior", { behavior: "default" }).catch(() => {});
      }
    };
  }

  async #clickSubmitsRiskyForm(backendNodeId: number, frame?: string): Promise<boolean> {
    const { object } = await this.#sendIn<{ object: { objectId: string } }>(frame, "DOM.resolveNode", { backendNodeId });
    const { result } = await this.#sendIn<{ result: { value?: unknown } }>(frame, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: CLICK_SUBMITS_RISKY_FORM,
      returnByValue: true,
    });
    return result.value === true;
  }

  /** Runs an action and records it in the audit log, whatever the outcome. */
  async #audited<T>(action: string, target: string, run: (entry: AuditEntry) => Promise<T>): Promise<T> {
    this.#refuseIfDialog();
    const entry: AuditEntry = { action, target, outcome: "ok" };
    this.#allowed = [];
    entry.url = await this.url().catch(() => undefined);
    this.#opened = [];
    // An action that opens a dialog does not finish until it is answered: report it instead.
    const watch = this.#watchForDialog();
    try {
      const running = run(entry);
      running.catch(() => {}); // If a dialog wins, the rest of the action is dropped.
      const outcome = await Promise.race([running.then((result) => ({ result })), watch.opened.then((dialog) => ({ dialog }))]);
      if ("result" in outcome) {
        const { result } = outcome;
        return typeof result === "string" ? (`${result}${await this.#followOpenedTab()}` as T) : result;
      }
      entry.detail = `the page opened a ${outcome.dialog.type}`;
      return `${action} ${entry.target}: ${describeDialog(outcome.dialog)}` as T;
    } catch (error) {
      entry.outcome = error instanceof PolicyError ? error.outcome : "error";
      entry.detail = (error as Error).message;
      throw error;
    } finally {
      watch.stop();
      if (this.#allowed.length) entry.allowed = this.#allowed;
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
      const decision = await this.#evaluateInOverlayWorld(decisionExpression(id)).catch(() => null);
      if (decision === "allow") {
        this.#allowed.push(action);
        return;
      }
      if (decision === "deny") throw new PolicyError("denied", `the user denied: ${action}`);
      await sleep(300);
    }
    throw new PolicyError("denied", `the user did not allow "${action}" within ${CONFIRM_TIMEOUT_MS / 1000}s`);
  }

  /** Updates the overlay and returns who is in control; never fails over drawing. */
  async #overlay(cmd: OverlayCommand): Promise<Owner> {
    const owner = ((await this.#evaluateInOverlayWorld(overlayExpression(cmd, this.#state.owner)).catch(() => null)) as Owner) ?? null;
    if (owner) this.#state.owner = owner;
    return owner;
  }

  /** Shows the next action to the human, or refuses it if the human is in control. */
  async #announce(action: OverlayAction & { busy?: boolean }, pause = true): Promise<void> {
    if ((await this.#overlay({ type: "action", ...action })) === "user") throw new Error(USER_IN_CONTROL);
    if (pause && SLOWMO_MS > 0) await sleep(SLOWMO_MS);
  }

  async #resolve(target: Target): Promise<Ref & { ref: string }> {
    if (typeof target !== "string") {
      await this.#capture(); // Fresh refs for the page as it is now.
      const matches = refsByName(this.#state.refs, target.name, target.role);
      const what = describeTarget(target);
      if (!matches.length) throw new Error(`nothing named ${what} on the page; try "open-eyes snapshot --find"`);
      if (matches.length > 1) {
        const shown = matches.slice(0, 10).map((ref) => `  ${this.#state.refs[ref.slice(1)].label} ${ref}`);
        const more = matches.length > 10 ? [`  ... and ${matches.length - 10} more`] : [];
        throw new Error([`${matches.length} elements match ${what}; use a ref or add a role:`, ...shown, ...more].join("\n"));
      }
      target = matches[0];
    }
    const key = target.replace(/^@/, "");
    const found = this.#state.refs[key];
    if (!found) throw new Error(`unknown ref @${key}; run "open-eyes snapshot" to get current refs`);
    // Node ids can be reused by a new document, so a ref from before a navigation
    // could silently point at an unrelated element.
    if (this.#state.refsLoaderId !== (await this.#loaderId())) {
      throw new Error(`@${key} is from a page that is no longer loaded; run "open-eyes snapshot" again`);
    }
    // Content in an iframe comes from the iframe's site, which the policy may not allow.
    const reason = found.url && blockedReason(this.#policy, found.url);
    if (reason) throw new PolicyError("blocked", `@${key} is in an iframe from ${found.url}, but ${reason}`);
    return { ...found, ref: `@${key}` };
  }

  async #loaderId(): Promise<string> {
    const { frameTree } = await this.#send<{ frameTree: { frame: { loaderId: string } } }>("Page.getFrameTree");
    return frameTree.frame.loaderId;
  }

  /**
   * Where the element is in the window, after scrolling it (and any iframe holding it) into
   * view. Without `scroll`, only measures it.
   */
  async #locate(backendNodeId: number, ref: string, frame?: string, { scroll = true } = {}): Promise<Box> {
    try {
      // A cross-origin iframe measures from its own corner: find where each <iframe> sits.
      const owners: { frame?: string; owner: number }[] = [];
      for (let at = frame; at; at = this.#frames.get(at)?.parent) {
        const info = this.#frames.get(at);
        if (info?.owner === undefined) await this.#frameContents();
        const found = this.#frames.get(at);
        if (found?.owner === undefined) throw new Error("iframe gone");
        owners.unshift({ frame: found.parent, owner: found.owner });
      }
      const measure = async (): Promise<Box> => {
        let offsetX = 0;
        let offsetY = 0;
        for (const { frame: parent, owner } of owners) {
          const { model } = await this.#sendIn<{ model: { content: number[] } }>(parent, "DOM.getBoxModel", { backendNodeId: owner });
          offsetX += model.content[0];
          offsetY += model.content[1];
        }
        const { model } = await this.#sendIn<{ model: { border: number[] } }>(frame, "DOM.getBoxModel", { backendNodeId });
        const xs = model.border.filter((_, i) => i % 2 === 0);
        const ys = model.border.filter((_, i) => i % 2 === 1);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        return { x: x + offsetX, y: y + offsetY, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
      };
      if (!scroll) return await measure();
      for (const { frame: parent, owner } of owners) {
        await this.#sendIn(parent, "DOM.scrollIntoViewIfNeeded", { backendNodeId: owner });
      }
      await this.#sendIn(frame, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
      return await measure();
    } catch {
      throw new Error(`${ref} is gone or not visible; the page changed, run "open-eyes snapshot" again`);
    }
  }

  /** Whether any part of the box is inside the window. */
  async #inWindow(box: Box): Promise<boolean> {
    const [width, height] = (await this.#evaluate("[innerWidth, innerHeight]")) as number[];
    return box.y < height && box.y + box.height > 0 && box.x < width && box.x + box.width > 0;
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
