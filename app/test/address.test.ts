import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedInTab, SEARCH, toAddress } from "../src/address.ts";

test("an address opens as one, anything else is a search", () => {
  assert.equal(toAddress("example.com"), "https://example.com");
  assert.equal(toAddress("  docs.example.org/guides?x=1 "), "https://docs.example.org/guides?x=1");
  assert.equal(toAddress("localhost:3000/app"), "http://localhost:3000/app");
  assert.equal(toAddress("http://example.com/a b"), "http://example.com/a b");
  assert.equal(toAddress("file:///home/me/page.html"), "file:///home/me/page.html");
  assert.equal(toAddress("ada lovelace"), `${SEARCH}ada%20lovelace`);
  assert.equal(toAddress("node.js streams"), `${SEARCH}node.js%20streams`);
});

test("browser pages and scripts never open from the address bar or a page", () => {
  for (const url of ["javascript:alert(1)", "chrome://settings", "devtools://devtools/x", "data:text/html,hi"]) {
    assert.equal(allowedInTab(url), false, url);
    assert.ok(toAddress(url).startsWith(SEARCH), `${url} becomes a search`);
  }
  assert.ok(allowedInTab("about:blank"));
  assert.ok(allowedInTab("https://example.com"));
});
