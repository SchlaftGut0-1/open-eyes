import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const stateDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "open-eyes");
export const profileDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "open-eyes", "profile");
const stateFile = join(stateDir, "state.json");

/**
 * Where the daemon listens. Runtime dirs are private and short (socket paths are limited
 * to ~100 characters); the hash keeps separate state dirs, like test runs, apart.
 */
export const socketPath = (() => {
  const id = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\open-eyes-${id}`;
  return join(process.env.XDG_RUNTIME_DIR ?? stateDir, `open-eyes-${id}.sock`);
})();

export type Ref = { backendNodeId: number; label: string };

/** Persisted between CLI invocations: each command is a short-lived process. */
export type State = {
  port: number;
  /** The agent's own window in the browser. */
  targetId?: string;
  /** Refs from the last snapshot, keyed by ref number. */
  refs: Record<string, Ref>;
  /** The document the refs belong to; a navigation makes them stale. */
  refsLoaderId?: string;
  /** Next ref number for this document; numbers are never reused within it. */
  nextRef?: number;
  /** Set while connected to the user's browser through the daemon (`open-eyes connect`). */
  daemonPid?: number;
  /** Show the token counter in the agent window (`open-eyes usage show`). */
  showTokens?: boolean;
};

const TARGET_ID = /^[0-9A-F]{32}$/i;

export function parsePort(value: unknown): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/**
 * Reads the state file, keeping only well-formed fields. The file feeds values into
 * browser connections, so anything unexpected is dropped rather than trusted.
 */
export function parseState(raw: unknown): Omit<State, "port"> & { port?: number } {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const refs: Record<string, Ref> = {};
  if (saved.refs && typeof saved.refs === "object") {
    for (const [key, ref] of Object.entries(saved.refs as Record<string, Partial<Ref>>)) {
      if (/^\d+$/.test(key) && Number.isInteger(ref?.backendNodeId) && typeof ref?.label === "string") {
        refs[key] = { backendNodeId: ref.backendNodeId!, label: ref.label };
      }
    }
  }
  return {
    port: parsePort(saved.port),
    targetId: typeof saved.targetId === "string" && TARGET_ID.test(saved.targetId) ? saved.targetId : undefined,
    refs,
    refsLoaderId: typeof saved.refsLoaderId === "string" && TARGET_ID.test(saved.refsLoaderId) ? saved.refsLoaderId : undefined,
    nextRef: Number.isInteger(saved.nextRef) && (saved.nextRef as number) > 0 ? (saved.nextRef as number) : undefined,
    daemonPid: Number.isInteger(saved.daemonPid) && (saved.daemonPid as number) > 0 ? (saved.daemonPid as number) : undefined,
    showTokens: saved.showTokens === true ? true : undefined,
  };
}

export function loadState(): State {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    // First run, or unreadable state: start fresh.
  }
  const saved = parseState(raw);
  if (process.env.OPEN_EYES_PORT && !parsePort(process.env.OPEN_EYES_PORT)) {
    throw new Error(`OPEN_EYES_PORT must be a port number, got "${process.env.OPEN_EYES_PORT}"`);
  }
  return { ...saved, port: parsePort(process.env.OPEN_EYES_PORT) ?? saved.port ?? 9222 };
}

export function saveState(state: State): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
