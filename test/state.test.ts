import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { parsePort, parseState } from "../src/state.ts";

const TARGET = "0123456789ABCDEF0123456789ABCDEF";

test("keeps well-formed state", () => {
  const state = {
    port: 9333,
    targetId: TARGET,
    refsLoaderId: TARGET,
    nextRef: 3,
    daemonPid: 4242,
    showTokens: true,
    refs: { 1: { backendNodeId: 7, label: 'button "Go"' } },
  };
  assert.deepEqual(parseState(state), state);
});

test("drops malformed fields instead of trusting them", () => {
  assert.deepEqual(
    parseState({
      port: "evil.example:80",
      targetId: "../../etc",
      refsLoaderId: 42,
      nextRef: -1,
      daemonPid: "4242",
      showTokens: "yes",
      refs: { 1: { backendNodeId: "7", label: "x" }, x: { backendNodeId: 1, label: "y" }, 2: null },
    }),
    { port: undefined, targetId: undefined, refsLoaderId: undefined, nextRef: undefined, daemonPid: undefined, showTokens: undefined, refs: {} },
  );
});

test("parsePort accepts only valid TCP ports", () => {
  assert.equal(parsePort("9222"), 9222);
  for (const bad of ["0", "65536", "9222.5", "abc", "", null, undefined, -1]) assert.equal(parsePort(bad), undefined);
});

test("parseState never throws and only returns valid ports", () => {
  fc.assert(
    fc.property(fc.anything(), (raw) => {
      const { port } = parseState(raw);
      assert.ok(port === undefined || (Number.isInteger(port) && port > 0 && port < 65536));
    }),
  );
});
