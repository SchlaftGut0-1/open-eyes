import { homedir } from "node:os";
import { join } from "node:path";
import { app, BaseWindow, ipcMain, Menu, session, WebContentsView, type Input, type WebContents } from "electron";
import { allowedInTab, toAddress } from "./address.ts";

/**
 * open-eyes Browser: our own window around Chromium's pages. The window's UI (sidebar, tabs,
 * address bar) is a sandboxed page of ours; each tab is a separate sandboxed view with no
 * access to the app. The CLI drives the tabs over DevTools, which listens only on this machine.
 */

// Its own profile, apart from the user's browsers and from the one `open-eyes launch` uses.
const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
app.setPath("userData", process.env.OPEN_EYES_BROWSER_PROFILE ?? join(dataHome, "open-eyes", "browser"));
// A port the system picks, on loopback only; Chromium writes it to DevToolsActivePort in the profile.
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", "0");
app.setName("open-eyes Browser");

const UI = join(import.meta.dirname, "ui", "index.html");
const PRELOAD = join(import.meta.dirname, "preload.cjs");
const NEW_TAB = "about:blank";

type Tab = { id: number; view: WebContentsView };
type Bounds = { x: number; y: number; width: number; height: number };
/** What the UI asks for; anything else is ignored. */
type Request =
  | { type: "newTab"; input?: string }
  | { type: "closeTab"; id: number }
  | { type: "activate"; id: number }
  | { type: "navigate"; input: string }
  | { type: "back" | "forward" | "reload" }
  | { type: "bounds"; bounds: Bounds };

let window: BaseWindow;
let ui: WebContentsView;
const tabs: Tab[] = [];
let active: Tab | undefined;
let nextId = 1;
let page: Bounds = { x: 0, y: 0, width: 0, height: 0 };

const sandboxed = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true };

/** Sends the tabs to the UI, which draws them. */
function publish(): void {
  const history = active?.view.webContents.navigationHistory;
  ui.webContents.send("state", {
    tabs: tabs.map(({ id, view }) => ({
      id,
      title: view.webContents.getTitle() || "New tab",
      url: view.webContents.getURL(),
      loading: view.webContents.isLoading(),
      active: id === active?.id,
    })),
    canGoBack: history?.canGoBack() ?? false,
    canGoForward: history?.canGoForward() ?? false,
  });
}

function activate(tab: Tab): void {
  active = tab;
  for (const { view } of tabs) view.setVisible(view === tab.view);
  tab.view.setBounds(page);
  publish();
}

function openTab(url = NEW_TAB): Tab {
  const view = new WebContentsView({ webPreferences: sandboxed });
  const tab = { id: nextId++, view };
  view.setBorderRadius(14);
  guardTab(view.webContents);
  for (const event of ["page-title-updated", "did-navigate", "did-navigate-in-page", "did-start-loading", "did-stop-loading"] as const) {
    view.webContents.on(event as "did-stop-loading", publish);
  }
  view.webContents.on("before-input-event", (event, input) => shortcut(event, input));
  window.contentView.addChildView(view);
  tabs.push(tab);
  void view.webContents.loadURL(allowedInTab(url) ? url : NEW_TAB);
  activate(tab);
  return tab;
}

function closeTab(id: number): void {
  const at = tabs.findIndex((tab) => tab.id === id);
  if (at === -1) return;
  const [tab] = tabs.splice(at, 1);
  window.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  if (!tabs.length) return void openTab();
  if (active === tab) activate(tabs[Math.min(at, tabs.length - 1)]);
  else publish();
}

/** A page may only go where a tab is allowed to, and opens new windows as tabs. */
function guardTab(contents: WebContents): void {
  const refuse = (event: { preventDefault(): void }, url: string) => {
    if (!allowedInTab(url)) event.preventDefault();
  };
  contents.on("will-navigate", refuse);
  contents.on("will-redirect", refuse);
  contents.setWindowOpenHandler(({ url }) => {
    if (allowedInTab(url)) openTab(url);
    return { action: "deny" };
  });
}

/** Browser shortcuts, wherever the focus is. */
function shortcut(event: { preventDefault(): void }, input: Input): void {
  if (input.type !== "keyDown") return;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();
  const action =
    ctrl && key === "t" ? () => openTab()
    : ctrl && key === "w" ? () => active && closeTab(active.id)
    : ctrl && key === "l" ? () => (ui.webContents.focus(), ui.webContents.send("focusAddress"))
    : (ctrl && key === "r") || key === "f5" ? () => active?.view.webContents.reload()
    : input.alt && key === "arrowleft" ? () => active?.view.webContents.navigationHistory.goBack()
    : input.alt && key === "arrowright" ? () => active?.view.webContents.navigationHistory.goForward()
    : undefined;
  if (!action) return;
  event.preventDefault();
  action();
}

function handle(request: Request): void {
  const contents = active?.view.webContents;
  switch (request.type) {
    case "newTab":
      openTab(request.input ? toAddress(request.input) : undefined);
      break;
    case "closeTab":
      closeTab(request.id);
      break;
    case "activate": {
      const tab = tabs.find((t) => t.id === request.id);
      if (tab) activate(tab);
      break;
    }
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
      page = { x: Math.round(x), y: Math.round(y), width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) };
      active?.view.setBounds(page);
      break;
    }
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // shortcut: every permission (camera, location, notifications...) is refused until the UI can ask the user.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

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
  ui.webContents.once("did-finish-load", () => openTab(process.argv.find((arg) => /^(https?|file):/.test(arg))));
  void ui.webContents.loadFile(UI);
  window.on("closed", () => app.quit());
});
