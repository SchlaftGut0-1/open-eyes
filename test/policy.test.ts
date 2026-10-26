import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedReason, isRiskyClick, normalizeSite, parsePolicy, type Policy } from "../src/policy.ts";

const policy = (overrides: Partial<Policy>): Policy => ({ allow: [], block: [], confirm: "risky", ...overrides });

test("normalizes site names", () => {
  assert.equal(normalizeSite("GitHub.com"), "github.com");
  assert.equal(normalizeSite("*.example.org"), "example.org");
  assert.equal(normalizeSite("https://mail.google.com/inbox"), "mail.google.com");
  for (const bad of ["", "exa mple.com", "javascript:alert(1)", "*"]) assert.throws(() => normalizeSite(bad));
});

test("with no lists, everything is allowed", () => {
  assert.equal(blockedReason(policy({}), "https://example.com/a"), undefined);
  assert.equal(blockedReason(policy({}), "file:///tmp/a.html"), undefined);
});

test("blocked sites and their subdomains are refused, even if allowed", () => {
  const p = policy({ allow: ["example.com"], block: ["evil.example.com", "bank.com"] });
  assert.match(blockedReason(p, "https://evil.example.com/")!, /blocked/);
  assert.match(blockedReason(p, "https://login.bank.com/")!, /blocked/);
  assert.equal(blockedReason(p, "https://shop.example.com/"), undefined);
});

test("an allow list refuses everything else, except about:blank", () => {
  const p = policy({ allow: ["github.com"] });
  assert.equal(blockedReason(p, "https://github.com/x"), undefined);
  assert.equal(blockedReason(p, "https://gist.github.com/x"), undefined);
  assert.match(blockedReason(p, "https://notgithub.com/")!, /not in your open-eyes allow list/);
  assert.match(blockedReason(p, "https://github.com.evil.io/")!, /not in your open-eyes allow list/);
  assert.match(blockedReason(p, "file:///tmp/a.html")!, /this file: page/);
  assert.match(blockedReason(p, "data:text/html,hi")!, /not in your open-eyes allow list/);
  assert.equal(blockedReason(p, "about:blank"), undefined);
});

test("parsePolicy keeps only valid entries", () => {
  assert.deepEqual(parsePolicy({ allow: ["A.com", 3, "bad site"], block: "x", confirm: "sometimes" }), {
    allow: ["a.com"],
    block: [],
    confirm: "risky",
  });
});

test("risky clicks are buttons and links that spend, send, delete or publish", () => {
  for (const label of ['button "Buy now"', 'button "Send"', 'menuitem "Delete repository"', 'button "Pagar"', 'button "Place order"', 'link "Delete"', 'link "Comprar ahora"']) {
    assert.ok(isRiskyClick(label), label);
  }
  for (const label of ['button "Search"', 'link "About"', 'button "Posts"', 'checkbox "Accept terms"', 'button "Next"']) {
    assert.ok(!isRiskyClick(label), label);
  }
});
