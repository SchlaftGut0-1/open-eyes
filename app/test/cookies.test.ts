import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import electron from "electron";

test("a space's logins can be carried to another space", async () => {
  const profile = mkdtempSync(join(tmpdir(), "open-eyes-cookies-"));
  try {
    const script = join(import.meta.dirname, "fixtures", "cookies-main.ts");
    const { stdout } = await promisify(execFile)(electron as unknown as string, [script, "--ozone-platform=headless", profile]);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    assert.deepEqual(result.exported.map((c: { name: string; httpOnly: boolean }) => [c.name, c.httpOnly]), [["sid", true]], "expired cookies stay behind");
    assert.equal(result.before, "", "the other space starts logged out");
    assert.equal(result.after, "sid=s3cret");
    assert.equal(result.failed, 1, "a malformed cookie is refused");
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
