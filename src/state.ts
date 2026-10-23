import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const stateDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "open-eyes");
export const profileDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "open-eyes", "profile");
const stateFile = join(stateDir, "state.json");

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
};

export function loadState(): State {
  let saved: Partial<State> = {};
  try {
    saved = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    // First run, or unreadable state: start fresh.
  }
  return {
    refs: {},
    ...saved,
    port: Number(process.env.OPEN_EYES_PORT) || saved.port || 9222,
  };
}

export function saveState(state: State): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}
