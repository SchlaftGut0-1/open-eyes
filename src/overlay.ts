import type { Box } from "./page.ts";

export type OverlayAction = { label: string; x?: number; y?: number; box?: Box };

// Runs inside the page. Built with DOM/CSSOM calls only (no innerHTML or <style>) so it
// survives strict CSP and Trusted Types. It is aria-hidden, so snapshots never see it,
// and pointer-events:none, so our synthetic clicks pass straight through it.
const DRAW_OVERLAY = String.raw`(action) => {
  const ID = "__open_eyes__";
  const ACCENT = "#7c5cff";
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement("div");
    host.id = ID;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });
    const part = (el, name, css) => { el.dataset.part = name; el.style.cssText = css; root.appendChild(el); return el; };

    part(document.createElement("div"), "frame",
      "position:fixed;inset:0;box-shadow:inset 0 0 0 3px " + ACCENT + ";");
    part(document.createElement("div"), "box",
      "position:fixed;opacity:0;border:2px solid " + ACCENT + ";border-radius:4px;" +
      "background:rgb(124 92 255 / .12);transition:all .25s ease;");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M3 2l17 9-7.5 2L9 20.5z");
    path.setAttribute("fill", ACCENT);
    path.setAttribute("stroke", "#fff");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    part(svg, "cursor",
      "position:fixed;left:0;top:0;opacity:0;transition:transform .3s ease;" +
      "filter:drop-shadow(0 2px 3px rgb(0 0 0 / .35));" +
      "transform:translate(" + innerWidth / 2 + "px," + innerHeight / 2 + "px);");
    part(document.createElement("div"), "banner",
      "position:fixed;top:10px;left:50%;transform:translateX(-50%);max-width:80vw;" +
      "padding:6px 14px;border-radius:999px;background:" + ACCENT + ";color:#fff;" +
      "font:500 13px/1.4 system-ui,sans-serif;white-space:nowrap;overflow:hidden;" +
      "text-overflow:ellipsis;box-shadow:0 4px 16px rgb(0 0 0 / .25);");
    (document.body ?? document.documentElement).appendChild(host);
  }

  if (!action) { host.style.display = "none"; return; }
  host.style.display = "";
  const get = (name) => host.shadowRoot.querySelector('[data-part="' + name + '"]');

  get("banner").textContent = "\u{1F441} open-eyes · " + action.label;
  const box = get("box");
  if (action.box) {
    Object.assign(box.style, {
      left: action.box.x - 3 + "px", top: action.box.y - 3 + "px",
      width: action.box.width + 6 + "px", height: action.box.height + 6 + "px", opacity: "1",
    });
  } else {
    box.style.opacity = "0";
  }
  if (action.x !== undefined) {
    const cursor = get("cursor");
    cursor.style.opacity = "1";
    cursor.style.transform = "translate(" + (action.x - 3) + "px," + (action.y - 2) + "px)";
  }
}`;

/** Shows what the agent is doing, or hides the overlay when `action` is null. */
export function overlayExpression(action: OverlayAction | null): string {
  return `(${DRAW_OVERLAY})(${JSON.stringify(action)})`;
}
