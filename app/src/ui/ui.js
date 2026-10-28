// Draws what the app sends (spaces, tabs) and passes the user's requests back. It holds no
// state of its own beyond what a dialog is editing.
const $ = (id) => document.getElementById(id);
const send = (request) => window.browser.send(request);
const COLORS = ["#7c5cff", "#0d9488", "#d97706", "#e11d48", "#3b82f6", "#db2777"];
const SITE_COLORS = ["#3b82f6", "#e11d48", "#0d9488", "#d97706", "#7c3aed", "#db2777"];
let state = { spaces: [], tabs: [] };

/** A Lucide icon by its name (as in lucide.dev), sized and colored by CSS. */
const icon = (name) => {
  const svg = lucide.createElement(lucide[name]);
  svg.classList.add("lucide"); // createIcons adds it to the static ones; the CSS sizes by it.
  return svg;
};

/** The site's own icon, or its first letter on a color that stays the same for that site. */
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
  if (tab.pinned) element.setAttribute("aria-label", `${tab.title} (pinned)`);
  element.addEventListener("mousedown", (event) => {
    if (event.button === 1) send({ type: "closeTab", id: tab.id }); // Middle click closes.
    else if (event.button === 0) send({ type: "activate", id: tab.id });
  });
  element.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") send({ type: "activate", id: tab.id });
  });
  // Right click pins the tab: it moves to the front and shows only its icon.
  element.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    send({ type: "pin", id: tab.id });
  });
  const title = Object.assign(document.createElement("span"), { className: "title", textContent: tab.title });
  const close = Object.assign(document.createElement("button"), { className: "close" });
  close.setAttribute("aria-label", `Close ${tab.title}`);
  close.append(icon("X"));
  close.addEventListener("mousedown", (event) => event.stopPropagation());
  close.addEventListener("click", () => send({ type: "closeTab", id: tab.id }));
  element.append(favicon(tab, newTab), title, close);
  return element;
}

function spaceElement(space) {
  const tabs = `${space.tabs} ${space.tabs === 1 ? "tab" : "tabs"}`;
  const button = document.createElement("button");
  button.className = "space";
  button.style.setProperty("--space", space.color);
  button.textContent = space.name.charAt(0).toUpperCase();
  button.title = `${space.name} · ${tabs} (right click to edit)`;
  button.setAttribute("aria-label", `${space.name}, ${tabs}`);
  if (space.current) button.setAttribute("aria-current", "true");
  button.addEventListener("click", () => send({ type: "switchSpace", id: space.id }));
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openSpaceDialog(space);
  });
  return button;
}

/** The address as the user reads it: the site, then the rest, quieter. Our new tab page has none. */
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
  $("spaces").replaceChildren(...state.spaces.map(spaceElement));
  $("tabs").replaceChildren(...state.tabs.map((tab) => tabElement(tab, state.newTab)));
  $("back").disabled = !state.canGoBack;
  $("forward").disabled = !state.canGoForward;
  const active = state.tabs.find((tab) => tab.active);
  $("loading").hidden = !active?.loading;
  // Leave the address alone while the user is typing in it.
  if (active && document.activeElement !== $("address")) showAddress(active.url, state.newTab);
});

window.browser.onFocusAddress((text) => {
  $("address").focus();
  // Typing that started on the new tab page carries on here.
  if (text) $("address").value = text;
  else $("address").select();
});

// Dialogs: the page is a separate view drawn over the UI, so it steps aside while one is open.
function openDialog(dialog) {
  send({ type: "dialog", open: true });
  dialog.showModal();
}
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("close", () => {
    if (!document.querySelector("dialog[open]")) send({ type: "dialog", open: false });
  });
}

/** The space a dialog is editing; none while creating one. */
let editing;
let chosenColor = COLORS[0];
function pickColor(color) {
  chosenColor = color;
  for (const swatch of $("space-colors").children) swatch.setAttribute("aria-pressed", String(swatch.dataset.color === color));
}
$("space-colors").replaceChildren(
  ...COLORS.map((color, i) => {
    const swatch = Object.assign(document.createElement("button"), { type: "button", className: "swatch" });
    swatch.dataset.color = color;
    swatch.style.setProperty("--swatch", color);
    swatch.setAttribute("aria-label", `Color ${i + 1}`);
    swatch.addEventListener("click", () => pickColor(color));
    return swatch;
  }),
);
function openSpaceDialog(space) {
  editing = space;
  $("space-dialog-title").textContent = space ? `Edit ${space.name}` : "New space";
  $("space-save").textContent = space ? "Save" : "Create";
  $("space-name").value = space?.name ?? "";
  $("space-error").textContent = "";
  $("space-delete").hidden = !space || state.spaces.length === 1;
  pickColor(space?.color ?? COLORS[state.spaces.length % COLORS.length]);
  openDialog($("space-dialog"));
  $("space-name").focus();
}
$("new-space").addEventListener("click", () => openSpaceDialog());
$("space-cancel").addEventListener("click", () => $("space-dialog").close());
$("space-form").addEventListener("submit", (event) => {
  const name = $("space-name").value.trim().replace(/\s+/g, " ");
  const taken = state.spaces.some((s) => s.id !== editing?.id && s.name.toLowerCase() === name.toLowerCase());
  if (!name || taken) {
    event.preventDefault();
    $("space-error").textContent = name ? `There is already a space called ${name}.` : "Give the space a name.";
    return;
  }
  if (editing) send({ type: "renameSpace", id: editing.id, name, color: chosenColor });
  else send({ type: "newSpace", name, color: chosenColor });
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

// The app draws the tab's page over this box, so it needs to know where the box is.
new ResizeObserver(() => {
  const { x, y, width, height } = $("page").getBoundingClientRect();
  send({ type: "bounds", bounds: { x, y, width, height } });
}).observe($("page"));

lucide.createIcons();
