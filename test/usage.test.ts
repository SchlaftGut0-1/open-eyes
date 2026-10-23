import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// usage.ts resolves its file from XDG_STATE_HOME when imported.
const dir = mkdtempSync(join(tmpdir(), "open-eyes-usage-"));
process.env.XDG_STATE_HOME = dir;
const { estimateTokens, formatUsage, readUsage, recordUsage, resetUsage, usageSummary } = await import("../src/usage.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

test("estimates tokens at about 3.8 characters each", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("x".repeat(38)), 10);
  assert.equal(estimateTokens("x".repeat(39)), 11);
});

test("records, totals and resets command usage", () => {
  resetUsage();
  assert.deepEqual(readUsage(), []);
  recordUsage("open https://example.com", "https://example.com/", 120);
  const last = recordUsage("snapshot --find Sign", "x".repeat(380), 80);
  assert.equal(last.tokens, 100);
  assert.equal(readUsage().length, 2);
  assert.equal(usageSummary(last), "last 100 tok · total 106 tok · 2 actions");
  const table = formatUsage(readUsage(), 1);
  assert.match(table, /\(1 earlier actions not shown\)/);
  assert.match(table, /snapshot --find Sign +100 tok/);
  assert.match(table, /total +106 tok +in 2 actions/);
  resetUsage();
  assert.match(formatUsage(readUsage(), 10), /no actions recorded/);
});
