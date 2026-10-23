import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isLocalDevToolsUrl, readDevToolsActivePort } from "../src/browser.ts";

const dir = mkdtempSync(join(tmpdir(), "open-eyes-profile-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("reads the DevTools endpoint a browser writes when remote debugging is on", () => {
  assert.equal(readDevToolsActivePort(dir), undefined);
  writeFileSync(join(dir, "DevToolsActivePort"), "9333\n/devtools/browser/0b5e-41aa\n");
  assert.equal(readDevToolsActivePort(dir), "ws://127.0.0.1:9333/devtools/browser/0b5e-41aa");
});

test("ignores malformed DevToolsActivePort files", () => {
  for (const content of ["", "abc\n/devtools/browser/x", "9333\n/evil", "9333\n/devtools/browser/../x"]) {
    writeFileSync(join(dir, "DevToolsActivePort"), content);
    assert.equal(readDevToolsActivePort(dir), undefined, content);
  }
});

test("only local DevTools endpoints are trusted", () => {
  assert.ok(isLocalDevToolsUrl("ws://127.0.0.1:9222/devtools/browser/x"));
  assert.ok(isLocalDevToolsUrl("ws://localhost:9222/devtools/browser/x", 9222));
  assert.ok(!isLocalDevToolsUrl("ws://localhost:9222/devtools/browser/x", 9333));
  assert.ok(!isLocalDevToolsUrl("ws://example.com:9222/devtools/browser/x"));
  assert.ok(!isLocalDevToolsUrl("wss://127.0.0.1:9222/devtools/browser/x"));
  assert.ok(!isLocalDevToolsUrl("not a url"));
});
