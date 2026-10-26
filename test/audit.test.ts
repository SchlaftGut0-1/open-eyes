import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutQueries } from "../src/audit.ts";

test("the audit log keeps only origin and path of URLs", () => {
  assert.equal(withoutQueries("https://example.com/a?phone=123&token=x#y"), "https://example.com/a");
  assert.equal(withoutQueries("https://example.com/verify#code=42"), "https://example.com/verify");
  assert.equal(
    withoutQueries('the page changed to https://shop.example/search?q=ana%40mail.com; run "open-eyes snapshot"'),
    'the page changed to https://shop.example/search; run "open-eyes snapshot"',
  );
  assert.equal(withoutQueries('button "Send"'), 'button "Send"');
  assert.equal(withoutQueries("file:///home/me/form.html?x=1"), "file:///home/me/form.html");
});
