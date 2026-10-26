import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CDP } from "./cdp.ts";
import { stateDir } from "./state.ts";

/**
 * A dialog (alert, confirm, prompt) stops the page until it is answered, and Chromium lets
 * only the DevTools connection that saw it open answer it. Each CLI command is a new
 * connection, so a watcher process keeps one open to the agent window: it records the open
 * dialog in `dialogFile` and answers it when `open-eyes dialog` asks.
 */
export type Dialog = { targetId: string; type: string; message: string; defaultPrompt?: string };

const dialogFile = join(stateDir, "dialog.json");
const watcherFile = join(stateDir, "dialog-watcher.json");
const WATCHER_READY_MS = 2000;

const dialogSocketPath = (() => {
  const id = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\open-eyes-dialogs-${id}`;
  return join(process.env.XDG_RUNTIME_DIR ?? stateDir, `open-eyes-dialogs-${id}.sock`);
})();

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function watcher(): { pid: number; targetId: string } | undefined {
  const found = readJson<{ pid: number; targetId: string }>(watcherFile);
  return found && Number.isInteger(found.pid) && isAlive(found.pid) ? found : undefined;
}

/** The dialog open in the agent window `targetId`, if a live watcher saw one. */
export function openDialog(targetId?: string): Dialog | undefined {
  const dialog = readJson<Dialog>(dialogFile);
  if (!dialog || (targetId && dialog.targetId !== targetId)) return undefined;
  if (!watcher()) {
    rmSync(dialogFile, { force: true }); // Its watcher is gone: nobody can answer it any more.
    return undefined;
  }
  return dialog;
}

/** How the agent answers a dialog, for messages. */
export function describeDialog({ type, message }: Dialog): string {
  const answer =
    type === "alert"
      ? 'close it with "open-eyes dialog accept"'
      : type === "prompt"
        ? 'answer it with "open-eyes dialog accept <text>" or "open-eyes dialog dismiss"'
        : 'answer it with "open-eyes dialog accept" (OK) or "open-eyes dialog dismiss" (Cancel)';
  return `the page is showing ${type === "alert" ? "an" : "a"} ${type}: ${JSON.stringify(message)}. It stays open until answered: ${answer}`;
}

/** Makes sure a watcher sees the dialogs of `targetId`, starting one if needed. */
export async function ensureWatcher(endpoint: string, targetId: string): Promise<void> {
  const running = watcher();
  if (running?.targetId === targetId) return;
  if (running) process.kill(running.pid, "SIGTERM"); // It watched a window the agent left.
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  rmSync(watcherFile, { force: true });
  const log = openSync(join(stateDir, "dialogs.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "__dialogs", endpoint, targetId], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  child.unref();
  // It is ready once it watches the page; with a dialog already open it never is, and the
  // page reports itself blocked.
  const deadline = Date.now() + WATCHER_READY_MS;
  while (Date.now() < deadline && watcher()?.targetId !== targetId) await sleep(50);
}

/** Answers the open dialog through its watcher. */
export function answerDialog(accept: boolean, text?: string): Promise<Dialog> {
  const dialog = openDialog();
  if (!dialog) return Promise.reject(new Error("no dialog is open"));
  return new Promise((resolve, reject) => {
    const socket = createConnection(dialogSocketPath);
    socket.setEncoding("utf8");
    let reply = "";
    socket.on("data", (chunk: string) => (reply += chunk));
    socket.on("end", () => {
      let error: string | undefined;
      try {
        error = (JSON.parse(reply) as { error?: string }).error;
      } catch {
        error = "the dialog watcher gave no answer";
      }
      if (error) reject(new Error(error));
      else resolve(dialog);
    });
    socket.on("error", () => reject(new Error("the dialog watcher is not answering; ask the user to answer the dialog")));
    // Accepting a prompt without text keeps what the page suggested, as pressing OK does.
    const promptText = dialog.type === "prompt" && accept ? (text ?? dialog.defaultPrompt ?? "") : undefined;
    socket.end(`${JSON.stringify({ accept, text: promptText })}\n`);
  });
}

/** The watcher process: `open-eyes __dialogs <endpoint> <targetId>`. */
export async function runWatcher(endpoint: string, targetId: string): Promise<void> {
  const cdp = await CDP.connect(endpoint);
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  let current: Dialog | undefined;

  // Half-open: the client ends its request, then reads the reply.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding("utf8");
    let request = "";
    socket.on("data", (chunk: string) => (request += chunk));
    socket.on("end", async () => {
      let error: string | undefined;
      try {
        const { accept, text } = JSON.parse(request) as { accept: boolean; text?: string };
        if (!current) throw new Error("no dialog is open");
        await cdp.send("Page.handleJavaScriptDialog", { accept, ...(text !== undefined && { promptText: text }) }, sessionId);
      } catch (e) {
        error = (e as Error).message;
      }
      socket.end(JSON.stringify(error ? { error } : {}));
    });
    socket.on("error", () => socket.destroy());
  });

  const shutdown = () => {
    server.close();
    if (process.platform !== "win32") rmSync(dialogSocketPath, { force: true });
    if (readJson<Dialog>(dialogFile)?.targetId === targetId) rmSync(dialogFile, { force: true });
    if (readJson<{ pid: number }>(watcherFile)?.pid === process.pid) rmSync(watcherFile, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  cdp.on("Target.detachedFromTarget", (params) => {
    if (params.sessionId === sessionId) shutdown(); // The window was closed.
  });
  // Also leave when the browser is gone, which closes the connection without an event.
  setInterval(async () => {
    const alive = await Promise.race([
      cdp.send("Target.getTargetInfo", { targetId }).then(() => true, () => false),
      sleep(3000).then(() => false),
    ]);
    if (!alive) shutdown();
  }, 5000).unref();
  cdp.on("Page.javascriptDialogOpening", ({ type, message, defaultPrompt }, session) => {
    if (session !== sessionId) return;
    current = { targetId, type, message, defaultPrompt };
    writeFileSync(dialogFile, JSON.stringify(current), { mode: 0o600 });
  });
  cdp.on("Page.javascriptDialogClosed", (_, session) => {
    if (session !== sessionId) return;
    current = undefined;
    rmSync(dialogFile, { force: true });
  });

  if (process.platform !== "win32" && existsSync(dialogSocketPath)) rmSync(dialogSocketPath, { force: true });
  process.umask(0o077);
  await new Promise<void>((resolve) => server.listen(dialogSocketPath, resolve));
  if (process.platform !== "win32") chmodSync(dialogSocketPath, 0o600);
  await cdp.send("Page.enable", {}, sessionId);
  writeFileSync(watcherFile, JSON.stringify({ pid: process.pid, targetId }), { mode: 0o600 });
}
