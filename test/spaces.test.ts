import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// state.ts reads the state dir when it loads, so set it first.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "open-eyes-spaces-"));
delete process.env.OPEN_EYES_PORT;
const { loadState, saveState, stateDir } = await import("../src/state.ts");

const TARGET = (n: number) => String(n).repeat(32);
const inSpace = <T>(name: string, run: () => T): T => {
  process.env.OPEN_EYES_SPACE = name;
  try {
    return run();
  } finally {
    delete process.env.OPEN_EYES_SPACE;
  }
};

test("the default space finds its window in a state file from before 0.7.0", () => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ port: 9333, targetId: TARGET(1), refs: {} }));
  const state = loadState();
  assert.equal(state.targetId, TARGET(1));
  assert.equal(state.port, 9333);
});

test("spaces keep their own windows and never undo each other's shared changes", () => {
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ port: 9333, daemonPid: 42 }));
  const main = loadState();
  const other = inSpace("a", () => loadState());
  // Space a sees the daemon is gone while the default space is still working.
  inSpace("a", () => saveState({ ...other, daemonPid: undefined, targetId: TARGET(2) }));
  saveState({ ...main, targetId: TARGET(3) });

  assert.equal(JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")).daemonPid, undefined);
  assert.equal(loadState().targetId, TARGET(3));
  assert.equal(inSpace("a", () => loadState()).targetId, TARGET(2));
});
