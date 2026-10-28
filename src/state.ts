import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const stateDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "open-eyes");
export const profileDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "open-eyes", "profile");
const stateFile = join(stateDir, "state.json");

const SPACE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/** The space (agent window) commands work in: `--space <name>` or OPEN_EYES_SPACE, else "default". */
export function space(): string {
  const name = process.env.OPEN_EYES_SPACE || "default";
  if (!SPACE_NAME.test(name)) throw new Error(`a space name is up to 32 letters, digits, "-" or "_", got "${name}"`);
  return name;
}

/** Where a space keeps its own files; the default space keeps them where they were before spaces. */
export const spaceDir = (name = space()) => (name === "default" ? stateDir : join(stateDir, "spaces", name));

/** Every space that has kept state, the default one first. */
export function spaces(): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(stateDir, "spaces")).filter((name) => SPACE_NAME.test(name) && name !== "default");
  } catch {
    // No other space yet.
  }
  return ["default", ...names.sort()];
}

/**
 * Where a background process named `name` listens. Runtime dirs are private and short
 * (socket paths are limited to ~100 characters); the hash keeps separate state dirs, like
 * test runs, apart.
 */
export function socketPathFor(name: string): string {
  const id = createHash("sha256").update(stateDir).digest("hex").slice(0, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}-${id}`;
  return join(process.env.XDG_RUNTIME_DIR ?? stateDir, `${name}-${id}.sock`);
}

/** Where the daemon listens. */
export const socketPath = socketPathFor("open-eyes");

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * An element an agent can act on. Inside an iframe, `url` is the iframe's document, and
 * `frame` the cross-origin frame whose session holds the node.
 */
export type Ref = { backendNodeId: number; label: string; frame?: string; url?: string };

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
  /** Who was last seen in control of the agent window, kept where page scripts cannot reach. */
  owner?: "agent" | "user";
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
        if (typeof ref.frame === "string") refs[key].frame = ref.frame;
        if (typeof ref.url === "string") refs[key].url = ref.url;
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
    owner: saved.owner === "agent" || saved.owner === "user" ? saved.owner : undefined,
  };
}

function readState(file: string): ReturnType<typeof parseState> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // First run, or unreadable state: start fresh.
  }
  return parseState(raw);
}

/** The state of space `name`: the browser connection is shared, the agent window its own. */
export function loadState(name = space()): State {
  const saved = readState(stateFile);
  if (name !== "default") {
    const { targetId, refs, refsLoaderId, nextRef, owner } = readState(join(spaceDir(name), "state.json"));
    Object.assign(saved, { targetId, refs, refsLoaderId, nextRef, owner });
  }
  if (process.env.OPEN_EYES_PORT && !parsePort(process.env.OPEN_EYES_PORT)) {
    throw new Error(`OPEN_EYES_PORT must be a port number, got "${process.env.OPEN_EYES_PORT}"`);
  }
  return { ...saved, port: parsePort(process.env.OPEN_EYES_PORT) ?? saved.port ?? 9222 };
}

const write = (file: string, data: object) => writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });

export function saveState(state: State): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (space() === "default") return write(stateFile, state);
  const { port, daemonPid, showTokens, ...window } = state;
  mkdirSync(spaceDir(), { recursive: true, mode: 0o700 });
  write(join(spaceDir(), "state.json"), window);
  // The shared part is written only when it changed, so the default space's window is not overwritten.
  const shared = readState(stateFile);
  if (shared.port !== port || shared.daemonPid !== daemonPid || shared.showTokens !== showTokens) {
    write(stateFile, { ...shared, port, daemonPid, showTokens });
  }
}
