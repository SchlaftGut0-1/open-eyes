const $ = (id) => document.getElementById(id);
const send = (request) => window.browser.send(request);
const SITE_COLORS = ["#3b82f6", "#e11d48", "#0d9488", "#d97706", "#7c3aed", "#db2777"];
let state = { spaces: [], tabs: [] };

const icon = (name) => {
  const svg = lucide.createElement(lucide[name.replace(/(^|-)(\w)/g, (_, _dash, c) => c.toUpperCase())]);
  svg.classList.add("lucide"); // createIcons adds it to the static ones; the CSS sizes by it.
  return svg;
};

function favicon(tab, newTab) {
  const box = document.createElement("span");
  box.className = "favicon";
  if (tab.loading) {
    box.append(Object.assign(document.createElement("span"), { className: "spinner" }));
    return box;
  }
  if (tab.url === newTab) tab = { ...tab, favicon: "icon.svg" };
  const host = URL.parse(tab.url)?.hostname.replace(/^www\./, "") ?? "";
  const letter = () => {
    let hash = 0;
    for (const char of host) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    box.style.background = host ? SITE_COLORS[hash % SITE_COLORS.length] : "var(--faint)";
    box.textContent = host.charAt(0).toUpperCase();
  };
  if (tab.favicon) {
    const img = Object.assign(document.createElement("img"), { src: tab.favicon, alt: "" });
    img.addEventListener("error", () => (img.remove(), letter()));
    box.append(img);
  } else letter();
  return box;
}

function tabElement(tab, newTab) {
  const element = document.createElement("div");
  element.className = tab.pinned ? "tab pinned" : "tab";
  element.setAttribute("role", "tab");
  element.setAttribute("aria-selected", String(tab.active));
  element.tabIndex = tab.active ? 0 : -1;
  element.title = tab.title;
  element.addEventListener("mousedown", (event) => {
    if (event.button === 1) send({ type: "closeTab", id: tab.id });
    else if (event.button === 0) send({ type: "activate", id: tab.id });
  });
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") send({ type: "activate", id: tab.id });
  });
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    send({ type: "pin", id: tab.id });
  });
  element.setAttribute("aria-label", tab.pinned ? `${tab.title} (pinned)` : tab.title);
  const close = Object.assign(document.createElement("button"), { className: "close" });
  close.setAttribute("aria-label", `Close ${tab.title}`);
  close.append(icon("X"));
  close.addEventListener("mousedown", (event) => event.stopPropagation());
  close.addEventListener("click", () => send({ type: "closeTab", id: tab.id }));
  const title = Object.assign(document.createElement("span"), { className: "label", textContent: tab.title });
  element.append(favicon(tab, newTab), title, close);
  return element;
}

function showCurrentSpace(space) {
  const button = $("space-current");
  button.style.setProperty("--space", space.color);
  button.title = `${space.name} (click to switch spaces)`;
  button.setAttribute("aria-label", `Space: ${space.name}. Switch or add a space`);
  const name = Object.assign(document.createElement("span"), { className: "label", textContent: space.name });
  const chevron = icon("chevrons-up-down");
  chevron.classList.add("chevron");
  button.replaceChildren(icon(space.icon), name, chevron);
}
const syncOverlay = () => send({ type: "raiseUi", raised: !!document.querySelector("dialog[open]") || !$("space-menu").hidden });

function menuItem(label, iconName, onClick, extra = {}) {
  const item = Object.assign(document.createElement("button"), { className: `menu-item ${extra.className ?? ""}` });
  item.setAttribute("role", extra.checked === undefined ? "menuitem" : "menuitemradio");
  if (extra.checked !== undefined) item.setAttribute("aria-checked", String(extra.checked));
  const glyph = icon(iconName);
  if (extra.color) glyph.style.color = extra.color;
  const name = Object.assign(document.createElement("span"), { className: "name", textContent: label });
  item.append(glyph, name);
  if (extra.checked) {
    const check = icon("check");
    check.classList.add("check");
    item.append(check);
  }
  item.addEventListener("click", () => {
    closeSpaceMenu();
    onClick();
  });
  return item;
}

function openSpaceMenu() {
  const current = state.spaces.find((s) => s.current);
  const separator = Object.assign(document.createElement("div"), { className: "menu-sep", role: "separator" });
  $("space-menu").replaceChildren(
    ...state.spaces.map((s) => menuItem(s.name, s.icon, () => send({ type: "switchSpace", id: s.id }), { color: s.color, checked: s.current })),
    separator,
    menuItem("New space", "plus", () => openSpaceDialog(), { className: "secondary" }),
    menuItem(`Edit ${current.name}`, "pencil", () => openSpaceDialog(current), { className: "secondary" }),
  );
  $("space-menu").hidden = false;
  $("space-current").setAttribute("aria-expanded", "true");
  syncOverlay();
  $("space-menu").querySelector("[aria-checked=true]")?.focus();
}
function closeSpaceMenu() {
  if ($("space-menu").hidden) return;
  $("space-menu").hidden = true;
  $("space-current").setAttribute("aria-expanded", "false");
  syncOverlay();
}
$("space-current").addEventListener("click", () => ($("space-menu").hidden ? openSpaceMenu() : closeSpaceMenu()));
document.addEventListener("mousedown", (event) => {
  if (!$("space-menu").contains(event.target) && !$("space-current").contains(event.target)) closeSpaceMenu();
});
$("space-menu").addEventListener("keydown", (event) => {
  const items = [...$("space-menu").querySelectorAll(".menu-item")];
  const at = items.indexOf(document.activeElement);
  if (event.key === "Escape") {
    closeSpaceMenu();
    $("space-current").focus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }
});
$("space-current").addEventListener("contextmenu", (event) => {
  event.preventDefault();
  openSpaceDialog(state.spaces.find((s) => s.current));
});

function expand(open) {
  document.body.classList.toggle("expanded", open);
  $("expand").setAttribute("aria-expanded", String(open));
  $("expand").setAttribute("aria-label", open ? "Collapse the sidebar" : "Expand the sidebar");
  $("expand").title = $("expand").getAttribute("aria-label");
  $("expand").replaceChildren(icon(open ? "panel-left-close" : "panel-left-open"));
  try {
    localStorage.setItem("expanded", String(open));
  } catch {}
}
$("expand").addEventListener("click", () => expand(!document.body.classList.contains("expanded")));
try {
  if (localStorage.getItem("expanded") === "true") expand(true);
} catch {}

function showAddress(url, newTab) {
  if (url === newTab) url = "about:blank";
  const parsed = URL.parse(url);
  const web = parsed && /^https?:$/.test(parsed.protocol);
  $("address").value = url === "about:blank" ? "" : url;
  $("host").textContent = web ? parsed.host.replace(/^www\./, "") : "";
  $("rest").textContent = web && `${parsed.pathname}${parsed.search}` !== "/" ? `${parsed.pathname}${parsed.search}` : "";
  const insecure = parsed?.protocol === "http:";
  $("security").className = `security${insecure ? " insecure" : ""}`;
  $("security").title = insecure ? "Not secure: this site does not use HTTPS" : "";
  $("security").replaceChildren(icon(parsed?.protocol === "https:" ? "Lock" : insecure ? "TriangleAlert" : "Search"));
}

window.browser.onState((next) => {
  state = next;
  showCurrentSpace(state.spaces.find((s) => s.current));
  $("tabs").replaceChildren(...state.tabs.map((tab) => tabElement(tab, state.newTab)));
  $("back").disabled = !state.canGoBack;
  $("forward").disabled = !state.canGoForward;
  const active = state.tabs.find((tab) => tab.active);
  $("loading").hidden = !active?.loading;
  if (active && document.activeElement !== $("address")) showAddress(active.url, state.newTab);
});

window.browser.onFocusAddress((text) => {
  $("address").focus();
  if (text) $("address").value = text;
  else $("address").select();
});

function openDialog(dialog) {
  dialog.showModal();
  syncOverlay();
}
for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("close", syncOverlay);

let editing;
let chosenColor;
let chosenIcon;
function pickIcon(name) {
  chosenIcon = name;
  for (const choice of $("space-icons").children) choice.setAttribute("aria-pressed", String(choice.dataset.icon === name));
}
function pickColor(color) {
  chosenColor = color;
  for (const swatch of $("space-colors").children) swatch.setAttribute("aria-pressed", String(swatch.dataset.color === color));
}
function buildChoices() {
  $("space-icons").replaceChildren(
    ...state.icons.map((name) => {
      const choice = Object.assign(document.createElement("button"), { type: "button", className: "icon-choice" });
      choice.dataset.icon = name;
      choice.setAttribute("aria-label", `Icon ${name.replace(/-/g, " ")}`);
      choice.append(icon(name));
      choice.addEventListener("click", () => pickIcon(name));
      return choice;
    }),
  );
  $("space-colors").replaceChildren(
    ...state.colors.map((color, i) => {
      const swatch = Object.assign(document.createElement("button"), { type: "button", className: "swatch" });
      swatch.dataset.color = color;
      swatch.style.setProperty("--swatch", color);
      swatch.setAttribute("aria-label", `Color ${i + 1}`);
      swatch.addEventListener("click", () => pickColor(color));
      return swatch;
    }),
  );
}
function openSpaceDialog(space) {
  editing = space;
  $("space-dialog-title").textContent = space ? `Edit ${space.name}` : "New space";
  $("space-save").textContent = space ? "Save" : "Create";
  $("space-name").value = space?.name ?? "";
  $("space-error").textContent = "";
  $("space-delete").hidden = !space || state.spaces.length === 1;
  buildChoices();
  pickColor(space?.color ?? state.colors[state.spaces.length % state.colors.length]);
  pickIcon(space?.icon ?? state.icons[state.spaces.length % state.icons.length]);
  openDialog($("space-dialog"));
  $("space-name").focus();
}
$("space-cancel").addEventListener("click", () => $("space-dialog").close());
$("space-form").addEventListener("submit", (event) => {
  const name = $("space-name").value.trim().replace(/\s+/g, " ");
  const taken = state.spaces.some((s) => s.id !== editing?.id && s.name.toLowerCase() === name.toLowerCase());
  if (!name || taken) {
    event.preventDefault();
    $("space-error").textContent = name ? `There is already a space called ${name}.` : "Give the space a name.";
    return;
  }
  if (editing) send({ type: "renameSpace", id: editing.id, name, color: chosenColor, icon: chosenIcon });
  else send({ type: "newSpace", name, color: chosenColor, icon: chosenIcon });
});
$("space-delete").addEventListener("click", () => {
  $("space-dialog").close();
  const tabs = `${editing.tabs} ${editing.tabs === 1 ? "tab" : "tabs"}`;
  $("delete-text").textContent = `${editing.name} closes its ${tabs} and erases its logins, cookies and site data. This cannot be undone.`;
  openDialog($("delete-dialog"));
});
$("delete-cancel").addEventListener("click", () => $("delete-dialog").close());
$("delete-confirm").addEventListener("click", () => {
  send({ type: "deleteSpace", id: editing.id });
  $("delete-dialog").close();
});

$("toolbar").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("address").value.trim();
  if (input) send({ type: "navigate", input });
  $("address").blur();
});
$("address").addEventListener("mouseup", (event) => {
  if ($("address").selectionStart === $("address").selectionEnd) event.preventDefault();
});
$("address").addEventListener("focus", () => $("address").select());
$("address").addEventListener("keydown", (event) => {
  if (event.key === "Escape") $("address").blur();
});
$("new-tab").addEventListener("click", () => send({ type: "newTab" }));
const showPanel = (open) => {
  $("panel").hidden = !open;
  $("agent").setAttribute("aria-expanded", String(open));
};
$("agent").addEventListener("click", () => showPanel($("panel").hidden));
$("panel-close").addEventListener("click", () => showPanel(false));
$("back").addEventListener("click", () => send({ type: "back" }));
$("forward").addEventListener("click", () => send({ type: "forward" }));
$("reload").addEventListener("click", () => send({ type: "reload" }));

new ResizeObserver(() => {
  const { x, y, width, height } = $("page").getBoundingClientRect();
  send({ type: "bounds", bounds: { x, y, width, height } });
}).observe($("page"));

lucide.createIcons();
