import assert from "node:assert/strict";
import { test } from "node:test";
import { COLORS, FIRST_SPACE, parseSaved, spaceName } from "../src/spaces.ts";

test("keeps well-formed spaces and their tabs", () => {
  const saved = {
    spaces: [
      { id: "work", name: "Work", color: "#0d9488", tabs: [{ url: "https://mail.example.com/", pinned: true }, { url: "https://docs.example.com/" }], active: 1 },
      { id: "personal", name: "Personal", color: "#7c5cff", tabs: [], active: 0 },
    ],
    current: "work",
  };
  assert.deepEqual(parseSaved(saved), saved);
});

test("drops what could not have been saved by the app", () => {
  const { spaces, current } = parseSaved({
    spaces: [
      { id: "../etc", name: "Bad id", tabs: [] },
      { id: "work", name: "  Work   stuff ", color: "red", tabs: [{ url: "javascript:alert(1)" }, { url: "chrome://settings" }, { url: "https://ok.example/" }], active: 9 },
      { id: "work", name: "Duplicate", tabs: [] },
      { id: "x", name: "", tabs: [] },
    ],
    current: "missing",
  });
  assert.deepEqual(spaces, [{ id: "work", name: "Work stuff", color: COLORS[0], tabs: [{ url: "https://ok.example/" }], active: 0 }]);
  assert.equal(current, "work");
});

test("a missing or broken file starts with one space", () => {
  for (const raw of [undefined, null, "text", { spaces: "no" }]) assert.deepEqual(parseSaved(raw), { spaces: [FIRST_SPACE], current: FIRST_SPACE.id });
});

test("space names are trimmed, short and printable", () => {
  assert.equal(spaceName("  Mi   trabajo "), "Mi trabajo");
  assert.equal(spaceName(""), undefined);
  assert.equal(spaceName("x".repeat(33)), undefined);
  assert.equal(spaceName("tab\u0007bell"), undefined);
  assert.equal(spaceName(42), undefined);
});
