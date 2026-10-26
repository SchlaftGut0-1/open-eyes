import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { toUrl } from "../src/page.ts";

test("toUrl opens file paths as file:// and everything else as typed or https", () => {
  const dir = mkdtempSync(join(tmpdir(), "open-eyes-url-"));
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, "<p>hi</p>");
    assert.equal(toUrl(page), pathToFileURL(page).href);
    assert.equal(toUrl("./page.html", dir), pathToFileURL(page).href);
    assert.equal(toUrl("../page.html", join(dir, "sub")), pathToFileURL(page).href);
    assert.throws(() => toUrl(join(dir, "missing.html")), /no such file: .*missing\.html/);

    assert.equal(toUrl("news.ycombinator.com"), "https://news.ycombinator.com");
    assert.equal(toUrl("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
    assert.equal(toUrl("file:///etc/hosts"), "file:///etc/hosts");
    assert.equal(toUrl("about:blank"), "about:blank");
    assert.equal(toUrl("//example.com/a"), "https://example.com/a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
