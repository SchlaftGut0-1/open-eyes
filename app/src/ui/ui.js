// Draws the tabs the app sends and passes the user's requests back. It holds no state of its own.
const $ = (id) => document.getElementById(id);
const send = (request) => window.browser.send(request);
const COLORS = ["#3b82f6", "#ef4444", "#22c3a6", "#f59e0b", "#a855f7", "#ec4899"];

/** A steady color per site, so its tab is easy to find again. */
function colorFor(url) {
  const host = URL.parse(url)?.host ?? "";
  let hash = 0;
  for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return host ? COLORS[hash % COLORS.length] : "#4c4878";
}

function icon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function tabElement(tab) {
  const element = document.createElement("div");
  element.className = "tab";
  element.setAttribute("role", "tab");
  element.setAttribute("aria-selected", String(tab.active));
  element.tabIndex = tab.active ? 0 : -1;
  element.title = tab.url;
  element.addEventListener("click", () => send({ type: "activate", id: tab.id }));
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") send({ type: "activate", id: tab.id });
  });
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = colorFor(tab.url);
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = tab.loading ? `${tab.title} …` : tab.title;
  const close = document.createElement("button");
  close.className = "close";
  close.setAttribute("aria-label", `Close ${tab.title}`);
  close.append(icon("M7 7l10 10M17 7L7 17"));
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    send({ type: "closeTab", id: tab.id });
  });
  element.append(dot, title, close);
  return element;
}

window.browser.onState((state) => {
  $("tabs").setAttribute("role", "tablist");
  $("tabs").replaceChildren(...state.tabs.map(tabElement));
  $("tab-count").textContent = `${state.tabs.length} ${state.tabs.length === 1 ? "tab" : "tabs"}`;
  $("back").disabled = !state.canGoBack;
  $("forward").disabled = !state.canGoForward;
  const active = state.tabs.find((tab) => tab.active);
  // Leave the address alone while the user is typing in it.
  if (active && document.activeElement !== $("address")) $("address").value = active.url === "about:blank" ? "" : active.url;
});

window.browser.onFocusAddress(() => {
  $("address").focus();
  $("address").select();
});

$("toolbar").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("address").value.trim();
  if (input) send({ type: "navigate", input });
  $("address").blur();
});
$("address").addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("address").blur();
});
$("new-tab").addEventListener("click", () => send({ type: "newTab" }));
$("back").addEventListener("click", () => send({ type: "back" }));
$("forward").addEventListener("click", () => send({ type: "forward" }));
$("reload").addEventListener("click", () => send({ type: "reload" }));

// The app draws the tab's page over this box, so it needs to know where the box is.
new ResizeObserver(() => {
  const { x, y, width, height } = $("page").getBoundingClientRect();
  send({ type: "bounds", bounds: { x, y, width, height } });
}).observe($("page"));
