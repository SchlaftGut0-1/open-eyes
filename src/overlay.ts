import type { Box } from "./page.ts";

export type OverlayAction = { label: string; x?: number; y?: number; box?: Box };

/** Who drives the agent window. null: unknown, e.g. a navigation wiped the page state. */
export type Owner = "agent" | "user" | null;

export type OverlayCommand =
  | ({ type: "action"; busy?: boolean } & OverlayAction)
  | { type: "idle" } // Re-enable the overlay buttons after a synthetic mouse event.
  | { type: "show" }
  | { type: "hide" }
  | { type: "handoff"; message?: string } // Give control to the user.
  | { type: "claim"; message?: string } // Keep the user in control if a navigation forgot it.
  | { type: "confirm"; id: string; message: string } // Ask the user to allow a risky action.
  | { type: "usage"; text: string | null }; // Token counter; null hides it.

const OWNER_KEY = "open-eyes:owner";
const MESSAGE_KEY = "open-eyes:message";

// Runs inside the page and returns the current owner. Built with DOM/CSSOM calls only (no
// innerHTML or <style>) so it survives strict CSP and Trusted Types. It is aria-hidden, so
// snapshots never see it, and pointer-events:none except on its buttons, which are disabled
// while the agent clicks so synthetic clicks pass straight through. Ownership lives in
// sessionStorage so it survives reloads, and only trusted (real user) clicks change it.
const OVERLAY = String.raw`(cmd) => {
  const ID = "__open_eyes__";
  const AGENT = "#7c5cff";
  const USER = "#16a34a";
  const store = {
    get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(key, value) {
      try { value == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch {}
    },
  };
  const state = (window.__openEyes ??= {
    owner: store.get(${JSON.stringify(OWNER_KEY)}),
    message: store.get(${JSON.stringify(MESSAGE_KEY)}),
    label: "agent working",
    confirm: null,
    decisions: {},
    usage: null,
  });
  const setOwner = (owner, message) => {
    state.owner = owner;
    state.message = message ?? null;
    store.set(${JSON.stringify(OWNER_KEY)}, owner);
    store.set(${JSON.stringify(MESSAGE_KEY)}, state.message);
  };

  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement("div");
    host.id = ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });
    const part = (el, name, css) => { el.dataset.part = name; el.style.cssText = css; root.appendChild(el); return el; };
    // What the overlay's buttons do. Only real user input runs them (see the shield below).
    const actions = {
      take: () => setOwner("user", null),
      back: () => setOwner("agent", null),
      allow: () => decide("allow"),
      deny: () => decide("deny"),
    };
    const decide = (decision) => {
      if (!state.confirm) return;
      state.decisions[state.confirm.id] = decision;
      state.confirm = null;
    };
    // Input on the overlay must never reach the page: sites close menus and search boxes on
    // a click "outside" them, and a pressed button takes keyboard focus, either of which
    // would undo what the agent was doing (an approved Enter would go nowhere). The shield
    // runs before the page's own document listeners, handles our buttons and stops the event.
    const shield = (event) => {
      if (!event.composedPath().includes(host)) return;
      event.stopImmediatePropagation();
      if (event.type === "mousedown" || event.type === "pointerdown") event.preventDefault(); // Keep focus.
      if (event.type !== "click" || !event.isTrusted) return; // Page scripts cannot press our buttons.
      const button = event.composedPath().find((el) => el.dataset && el.dataset.part in actions);
      if (!button) return;
      actions[button.dataset.part]();
      render();
    };
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend"]) {
      window.addEventListener(type, shield, true);
    }
    const font = "font:500 13px/1.4 system-ui,sans-serif;";
    const pill = "border-radius:999px;color:#fff;box-shadow:0 4px 16px rgb(0 0 0 / .25);" + font;

    part(document.createElement("div"), "frame", "position:fixed;inset:0;");
    part(document.createElement("div"), "box",
      "position:fixed;opacity:0;border:2px solid " + AGENT + ";border-radius:4px;" +
      "background:rgb(124 92 255 / .12);transition:all .25s ease;");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3 2l17 9-7.5 2L9 20.5z");
    path.setAttribute("fill", AGENT);
    path.setAttribute("stroke", "#fff");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    part(svg, "cursor",
      "position:fixed;left:0;top:0;opacity:0;transition:transform .3s ease;" +
      "filter:drop-shadow(0 2px 3px rgb(0 0 0 / .35));" +
      "transform:translate(" + innerWidth / 2 + "px," + innerHeight / 2 + "px);");
    part(document.createElement("div"), "banner",
      "position:fixed;top:10px;left:50%;transform:translateX(-50%);max-width:80vw;padding:6px 14px;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" + pill);

    const take = part(document.createElement("button"), "take",
      "position:fixed;right:16px;bottom:16px;padding:8px 14px;border:0;cursor:pointer;" +
      "pointer-events:auto;background:" + AGENT + ";" + pill);
    take.textContent = "✋ Take control";

    const panel = part(document.createElement("div"), "panel",
      "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:min(480px,90vw);" +
      "padding:14px 16px;border-radius:12px;background:#fff;color:#111;pointer-events:auto;" +
      "box-shadow:0 8px 32px rgb(0 0 0 / .3);border:2px solid " + USER + ";" + font);
    const message = document.createElement("div");
    message.dataset.part = "message";
    message.style.cssText = "margin-bottom:10px;white-space:pre-wrap;";
    panel.appendChild(message);
    const back = document.createElement("button");
    back.dataset.part = "back";
    back.textContent = "Hand back to agent ↩";
    back.style.cssText = "padding:8px 14px;border:0;cursor:pointer;background:" + USER + ";" + pill;
    panel.appendChild(back);

    const ask = part(document.createElement("div"), "ask",
      "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:min(480px,90vw);" +
      "padding:14px 16px;border-radius:12px;background:#fff;color:#111;pointer-events:auto;" +
      "box-shadow:0 8px 32px rgb(0 0 0 / .3);border:2px solid " + AGENT + ";" + font);
    const question = document.createElement("div");
    question.dataset.part = "question";
    question.style.cssText = "margin-bottom:10px;white-space:pre-wrap;";
    ask.appendChild(question);
    const choice = (name, label, color) => {
      const button = document.createElement("button");
      button.dataset.part = name;
      button.textContent = label;
      button.style.cssText = "margin-right:8px;padding:8px 14px;border:0;cursor:pointer;background:" + color + ";" + pill;
      ask.appendChild(button);
    };
    choice("allow", "Allow", USER);
    choice("deny", "Deny", "#dc2626");

    part(document.createElement("div"), "usage",
      "position:fixed;left:16px;bottom:16px;padding:6px 12px;border-radius:8px;" +
      "background:rgb(17 17 17 / .85);color:#fff;font:500 12px/1.4 ui-monospace,monospace;" +
      "box-shadow:0 4px 16px rgb(0 0 0 / .25);");

    (document.body ?? document.documentElement).appendChild(host);
  }
  const get = (name) => host.shadowRoot.querySelector('[data-part="' + name + '"]');

  function render() {
    const user = state.owner === "user";
    get("frame").style.boxShadow = "inset 0 0 0 3px " + (user ? USER : AGENT);
    const banner = get("banner");
    banner.style.background = user ? USER : AGENT;
    banner.textContent = user
      ? "\u{1F464} You are in control · the agent is paused"
      : "\u{1F441} open-eyes · " + state.label;
    const asking = !user && state.confirm;
    get("take").style.display = user || asking ? "none" : "";
    get("panel").style.display = user ? "" : "none";
    get("ask").style.display = asking ? "" : "none";
    get("usage").style.display = state.usage ? "" : "none";
    get("usage").textContent = state.usage ? "\u{1FA99} " + state.usage : "";
    if (asking) get("question").textContent = "\u26A0\uFE0F The agent wants to " + state.confirm.message + ". Allow it?";
    get("message").textContent = state.message || "Do what you need, then hand control back to the agent.";
    if (user) {
      get("box").style.opacity = "0";
      get("cursor").style.opacity = "0";
    }
  }

  switch (cmd.type) {
    case "hide":
      host.style.display = "none";
      return state.owner;
    case "handoff":
      setOwner("user", cmd.message);
      break;
    case "claim":
      if (state.owner == null) setOwner("user", cmd.message);
      break;
    case "confirm":
      if (!(cmd.id in state.decisions)) state.confirm = { id: cmd.id, message: cmd.message };
      break;
    case "usage":
      state.usage = cmd.text;
      break;
    case "idle":
      get("take").style.pointerEvents = "auto";
      break;
    case "action": {
      if (state.owner === "user") break;
      state.label = cmd.label;
      get("take").style.pointerEvents = cmd.busy ? "none" : "auto";
      const box = get("box");
      if (cmd.box) {
        Object.assign(box.style, {
          left: cmd.box.x - 3 + "px", top: cmd.box.y - 3 + "px",
          width: cmd.box.width + 6 + "px", height: cmd.box.height + 6 + "px", opacity: "1",
        });
      } else {
        box.style.opacity = "0";
      }
      if (cmd.x !== undefined) {
        const cursor = get("cursor");
        cursor.style.opacity = "1";
        cursor.style.transform = "translate(" + (cmd.x - 3) + "px," + (cmd.y - 2) + "px)";
      }
      break;
    }
  }
  host.style.display = "";
  render();
  return state.owner;
}`;

export function overlayExpression(cmd: OverlayCommand): string {
  return `(${OVERLAY})(${JSON.stringify(cmd)})`;
}

/** The user's answer to confirmation `id`: "allow", "deny", or null while undecided. */
export function decisionExpression(id: string): string {
  return `window.__openEyes?.decisions?.[${JSON.stringify(id)}] ?? null`;
}

/** Reads the owner without drawing anything. */
export const OWNER_EXPRESSION = `window.__openEyes?.owner ?? (() => {
  try { return sessionStorage.getItem(${JSON.stringify(OWNER_KEY)}); } catch { return null; }
})()`;
