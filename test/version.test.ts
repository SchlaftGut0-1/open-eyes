import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");
const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
  version: string;
};

for (const command of ["--version", "version"]) {
  test(`open-eyes ${command} prints the version from package.json`, async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI, command]);
    assert.equal(stdout.trim(), version);
  });
}
