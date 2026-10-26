import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutSecrets } from "../src/audit.ts";

test("the audit log keeps only origin and path of URLs", () => {
  assert.equal(withoutSecrets("https://example.com/a?phone=123&token=x#y"), "https://example.com/a");
  assert.equal(withoutSecrets("https://example.com/verify#code=42"), "https://example.com/verify");
  assert.equal(
    withoutSecrets('the page changed to https://shop.example/search?q=ana%40mail.com; run "open-eyes snapshot"'),
    'the page changed to https://shop.example/search; run "open-eyes snapshot"',
  );
  assert.equal(withoutSecrets('button "Send"'), 'button "Send"');
  assert.equal(withoutSecrets("file:///home/me/form.html?x=1"), "file:///home/me/form.html");
  assert.equal(withoutSecrets("open https://admin:hunter2@intranet.example/admin?x=1"), "open https://intranet.example/admin");
  assert.equal(withoutSecrets("mailto:ana@example.com"), "mailto:ana@example.com"); // No // : not a URL with a login.
});
