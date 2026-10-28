import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BaseWindow, ipcMain, Menu, nativeTheme, session, WebContentsView, type Input, type Session, type WebContents } from "electron";
import { allowedInTab, toAddress } from "./address.ts";
import { parseSaved, spaceColor, spaceIcon, spaceName, type Saved, type SavedTab } from "./spaces.ts";

/**
 * open-eyes Browser: our own window around Chromium's pages. The window's UI (spaces rail,
 * tabs, address bar) is a sandboxed page of ours; each tab is a separate sandboxed view with
 * no access to the app. The CLI drives the tabs over DevTools, which listens only on this machine.
 */

// Its own profile, apart from the user's browsers and from the one `open-eyes launch` uses.
const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
app.setPath("userData", process.env.OPEN_EYES_BROWSER_PROFILE ?? join(dataHome, "open-eyes", "browser"));
// A port the system picks, on loopback only; Chromium writes it to DevToolsActivePort in the profile.
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", "0");
// Thin scrollbars over the page, so a page that does not declare its colors keeps no light track.
app.commandLine.appendSwitch("enable-features", "OverlayScrollbar");
app.setName("open-eyes Browser");
// Say "Chrome", as the Chromium inside is: sites such as Google refuse to sign in browsers that say "Electron".
app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|open-eyes\S*)\/\S+/g, "");

const UI = join(import.meta.dirname, "ui", "index.html");
const PRELOAD = join(import.meta.dirname, "preload.cjs");
const NEW_TAB = pathToFileURL(join(import.meta.dirname, "newtab", "index.html")).href;
const SPACES_FILE = join(app.getPath("userData"), "spaces.json");

type Tab = { id: number; view: WebContentsView; favicon?: string; pinned?: boolean };
/** A space: its own tabs and its own sessions. Saved tabs open the first time it is shown. */
type Space = { id: string; name: string; color: string; icon: string; tabs: Tab[]; active?: Tab; saved?: { tabs: SavedTab[]; active: number } };
type Bounds = { x: number; y: number; width: number; height: number };
/** What the UI asks for; anything else is ignored. */
type Request =
  | { type: "newTab"; input?: string }
  | { type: "closeTab" | "activate" | "pin"; id: number }
  | { type: "navigate"; input: string }
  | { type: "back" | "forward" | "reload" }
  | { type: "bounds"; bounds: Bounds }
  | { type: "newSpace"; name: string; color: string; icon: string }
  | { type: "renameSpace"; id: string; name: string; color: string; icon: string }
  | { type: "switchSpace" | "deleteSpace"; id: string }
  | { type: "spaceMenu"; x: number; y: number }
  | { type: "dialog"; open: boolean };

let window: BaseWindow;
let ui: WebContentsView;
let spaces: Space[] = [];
let current: Space;
let nextId = 1;
let page: Bounds = { x: 0, y: 0, width: 0, height: 0 };
/** While the UI shows a dialog, the page steps aside so the dialog is not drawn under it. */
let dialogOpen = false;

const sandboxed = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };
const guarded = new WeakSet<Session>();

/** The space's own sessions, with the same rules as every other. */
function sessionFor(space: { id: string }): Session {
  const ses = session.fromPartition(`persist:space-${space.id}`);
  if (!guarded.has(ses)) {
    // shortcut: every permission (camera, location, notifications...) is refused until the UI can ask the user.
    ses.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
    ses.setPermissionCheckHandler(() => false);
    guarded.add(ses);
  }
  return ses;
}

let saveTimer: NodeJS.Timeout | undefined;
/** Saves spaces and their tabs a moment after the last change, whole or not at all. */
function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const saved: Saved = {
      current: current.id,
      spaces: spaces.map((space) => {
        if (space.saved) return { id: space.id, name: space.name, color: space.color, icon: space.icon, ...space.saved };
        const open = space.tabs.filter((tab) => tab.view.webContents.getURL() !== NEW_TAB);
        return {
          id: space.id,
          name: space.name,
          color: space.color,
          icon: space.icon,
          tabs: open.map((tab) => ({ url: tab.view.webContents.getURL(), ...(tab.pinned ? { pinned: true } : {}) })),
          active: Math.max(0, open.indexOf(space.active!)),
        };
      }),
    };
    const temporary = `${SPACES_FILE}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
    renameSync(temporary, SPACES_FILE);
  }, 500);
}

/** Sends the spaces and the current space's tabs to the UI, which draws them. */
function publish(): void {
  const history = current.active?.view.webContents.navigationHistory;
  ui.webContents.send("state", {
    newTab: NEW_TAB,
    spaces: spaces.map(({ id, name, color, icon, tabs, saved }) => ({ id, name, color, icon, current: id === current.id, tabs: saved?.tabs.length ?? tabs.length })),
    tabs: current.tabs.map(({ id, view, favicon, pinned }) => ({
      id,
      favicon,
      pinned: pinned ?? false,
      title: view.webContents.getTitle() || "New tab",
      url: view.webContents.getURL(),
      loading: view.webContents.isLoading(),
      active: id === current.active?.id,
    })),
    canGoBack: history?.canGoBack() ?? false,
    canGoForward: history?.canGoForward() ?? false,
  });
  save();
}

/** Shows the space's active tab and hides every other page. */
function show(): void {
  for (const space of spaces) for (const { view } of space.tabs) view.setVisible(!dialogOpen && view === current.active?.view);
  current.active?.view.setBounds(page);
  publish();
}

function activate(tab: Tab): void {
  current.active = tab;
  show();
}

function switchTo(space: Space): void {
  current = space;
  if (space.saved) {
    const { tabs, active } = space.saved;
    space.saved = undefined;
    for (const tab of tabs) openTab(space, tab.url, tab.pinned);
    if (space.tabs[active]) space.active = space.tabs[active];
  }
  if (!space.tabs.length) openTab(space);
  show();
}

function openTab(space: Space, url = NEW_TAB, pinned = false): Tab {
  const view = new WebContentsView({ webPreferences: { ...sandboxed, session: sessionFor(space) } });
  // The color shown before a page paints: the UI's, not a white flash.
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#13111d" : "#ffffff");
  const tab: Tab = { id: nextId++, view, ...(pinned ? { pinned } : {}) };
  guardTab(space, view.webContents);
  view.webContents.on("page-favicon-updated", (_event, favicons) => {
    tab.favicon = favicons.find((url) => /^(https|data):/.test(url));
    publish();
  });
  view.webContents.on("did-navigate", () => (tab.favicon = undefined));
  for (const event of ["page-title-updated", "did-navigate", "did-navigate-in-page", "did-start-loading", "did-stop-loading"] as const) {
    view.webContents.on(event as "did-stop-loading", () => space === current && publish());
  }
  view.webContents.on("before-input-event", (event, input) => shortcut(event, input));
  view.setVisible(false);
  window.contentView.addChildView(view);
  space.tabs.push(tab);
  void view.webContents.loadURL(allowedInTab(url) ? url : NEW_TAB);
  space.active = tab;
  if (space === current) show();
  return tab;
}

function closeTab(space: Space, id: number): void {
  const at = space.tabs.findIndex((tab) => tab.id === id);
  if (at === -1) return;
  const [tab] = space.tabs.splice(at, 1);
  window.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (!space.tabs.length) return void openTab(space);
  if (space.active === tab) space.active = space.tabs[Math.min(at, space.tabs.length - 1)];
  show();
}

function focusAddress(text = ""): void {
  ui.webContents.focus();
  ui.webContents.send("focusAddress", text);
}

/** Pinned tabs come first; pinning moves a tab to the end of them, unpinning to just after. */
function pin(space: Space, tab: Tab): void {
  tab.pinned = !tab.pinned;
  space.tabs.splice(space.tabs.indexOf(tab), 1);
  space.tabs.splice(space.tabs.filter((t) => t.pinned).length, 0, tab);
  publish();
}

/** A page may only go where a tab is allowed to, and opens new windows as tabs of its own space. */
function guardTab(space: Space, contents: WebContents): void {
  const refuse = (event: { preventDefault(): void }, url: string) => {
    if (allowedInTab(url)) return;
    event.preventDefault();
    // Our new tab page hands typing to the address bar; no other page may.
    if (contents.getURL() === NEW_TAB && url.startsWith("open-eyes://focus-address")) {
      focusAddress(URL.parse(url)?.searchParams.get("text") ?? "");
    }
  };
  contents.on("will-navigate", refuse);
  contents.on("will-redirect", refuse);
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (!allowedInTab(url)) return { action: "deny" };
    // A sized popup ("Sign in with Google") must stay a window tied to its opener, or the sign-in
    // cannot report back; it shares the space's sessions. Links that open a new tab become tabs.
    if (disposition === "new-window") {
      return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: "#13111d", webPreferences: { ...sandboxed, session: sessionFor(space) } } };
    }
    openTab(space, url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (popup) => guardTab(space, popup.webContents));
}

/** Browser shortcuts, wherever the focus is. */
function shortcut(event: { preventDefault(): void }, input: Input): void {
  if (input.type !== "keyDown") return;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();
  const contents = current.active?.view.webContents;
  const action =
    ctrl && key === "t" ? () => openTab(current)
    : ctrl && key === "w" ? () => current.active && closeTab(current, current.active.id)
    : ctrl && key === "l" ? () => focusAddress()
    : (ctrl && key === "r") || key === "f5" ? () => contents?.reload()
    : input.alt && key === "arrowleft" ? () => contents?.navigationHistory.goBack()
    : input.alt && key === "arrowright" ? () => contents?.navigationHistory.goForward()
    : undefined;
  if (!action) return;
  event.preventDefault();
  action();
}

const nameTaken = (name: string, except?: Space) => spaces.some((s) => s !== except && s.name.toLowerCase() === name.toLowerCase());

/** Closes a space's tabs and erases its sessions (cookies, logins, site data). */
async function deleteSpace(space: Space): Promise<void> {
  if (spaces.length === 1) return;
  for (const tab of [...space.tabs]) {
    window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
  }
  spaces = spaces.filter((s) => s !== space);
  if (current === space) switchTo(spaces[0]);
  else publish();
  const ses = sessionFor(space);
  await ses.clearStorageData();
  await ses.clearCache();
}

function handle(request: Request): void {
  const contents = current.active?.view.webContents;
  const tab = "id" in request && typeof request.id === "number" ? current.tabs.find((t) => t.id === request.id) : undefined;
  const space = "id" in request && typeof request.id === "string" ? spaces.find((s) => s.id === request.id) : undefined;
  switch (request.type) {
    case "newTab":
      openTab(current, request.input ? toAddress(request.input) : undefined);
      break;
    case "closeTab":
      if (tab) closeTab(current, tab.id);
      break;
    case "pin":
      if (tab) pin(current, tab);
      break;
    case "activate":
      if (tab) activate(tab);
      break;
    case "navigate":
      if (contents) void contents.loadURL(toAddress(request.input));
      break;
    case "back":
      contents?.navigationHistory.goBack();
      break;
    case "forward":
      contents?.navigationHistory.goForward();
      break;
    case "reload":
      contents?.reload();
      break;
    case "bounds": {
      const { x, y, width, height } = request.bounds;
      // Whole pixels that cover the box, so no sliver of the UI shows around the page.
      const left = Math.floor(x);
      const top = Math.floor(y);
      page = { x: left, y: top, width: Math.max(0, Math.ceil(x + width) - left), height: Math.max(0, Math.ceil(y + height) - top) };
      current.active?.view.setBounds(page);
      break;
    }
    case "newSpace": {
      const name = spaceName(request.name);
      if (!name || nameTaken(name)) break;
      const created: Space = { id: randomUUID().replace(/-/g, "").slice(0, 12), name, color: spaceColor(request.color), icon: spaceIcon(request.icon), tabs: [] };
      spaces.push(created);
      switchTo(created);
      break;
    }
    case "renameSpace": {
      const name = spaceName(request.name);
      if (space && name && !nameTaken(name, space)) Object.assign(space, { name, color: spaceColor(request.color), icon: spaceIcon(request.icon) });
      publish();
      break;
    }
    case "switchSpace":
      if (space) switchTo(space);
      break;
    case "deleteSpace":
      if (space) void deleteSpace(space);
      break;
    case "spaceMenu":
      // A native menu: drawn above the page, which a menu in the UI page would be hidden under.
      Menu.buildFromTemplate([
        ...spaces.map((s) => ({ label: s.name, type: "radio" as const, checked: s === current, click: () => switchTo(s) })),
        { type: "separator" },
        { label: "New space…", click: () => ui.webContents.send("spaceDialog", null) },
        { label: `Edit ${current.name}…`, click: () => ui.webContents.send("spaceDialog", current.id) },
      ]).popup({ window, x: Math.round(request.x), y: Math.round(request.y) });
      break;
    case "dialog":
      dialogOpen = request.open === true;
      show();
      break;
  }
}

function loadSpaces(): void {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(SPACES_FILE, "utf8"));
  } catch {
    // First run, or an unreadable file: start with one space.
  }
  const saved = parseSaved(raw);
  spaces = saved.spaces.map(({ id, name, color, icon, tabs, active }) => ({ id, name, color, icon, tabs: [], saved: { tabs, active } }));
  current = spaces.find((s) => s.id === saved.current)!;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // Nothing should use the default session; refuse its permissions too.
  sessionFor({ id: "default" });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  loadSpaces();

  window = new BaseWindow({ width: 1280, height: 820, minWidth: 720, minHeight: 480, title: "open-eyes Browser", backgroundColor: "#0b0a14" });
  ui = new WebContentsView({ webPreferences: { ...sandboxed, preload: PRELOAD } });
  window.contentView.addChildView(ui);
  const fit = () => {
    const [width, height] = window.getContentSize();
    ui.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  window.on("resize", fit);
  // The UI is ours alone: it never navigates or opens windows.
  ui.webContents.on("will-navigate", (event) => event.preventDefault());
  ui.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  ui.webContents.on("before-input-event", (event, input) => shortcut(event, input));
  ipcMain.on("browser", (event, request: Request) => {
    if (event.sender === ui.webContents) handle(request);
  });
  ui.webContents.once("did-finish-load", () => {
    // An address given on the command line opens as the space's active tab.
    const url = process.argv.find((arg) => /^(https?|file):/.test(arg));
    if (url && current.saved) {
      current.saved.tabs.push({ url });
      current.saved.active = current.saved.tabs.length - 1;
    }
    switchTo(current);
  });
  void ui.webContents.loadFile(UI);
  window.on("closed", () => app.quit());
});
