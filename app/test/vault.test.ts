import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveKey, newSalt, open, seal } from "../src/vault.ts";

const payload = { spaces: [{ id: "work", name: "Work" }], cookies: { work: [{ name: "sid", value: "secret" }] } };

test("a vault opens with the same passphrase on another computer, and hides its content", async () => {
  const salt = newSalt();
  const sealed = seal(payload, await deriveKey("correct horse battery", salt), salt, "user-1");
  assert.ok(!Buffer.from(sealed.data, "base64").toString().includes("secret"), "nothing readable is stored");
  const key = await deriveKey("correct horse battery", sealed.salt);
  assert.deepEqual(open(sealed, key, "user-1"), payload);
});

test("a wrong passphrase, another account or a changed vault never opens", async () => {
  const salt = newSalt();
  const key = await deriveKey("correct horse battery", salt);
  const sealed = seal(payload, key, salt, "user-1");
  assert.throws(() => open(sealed, key, "user-2"), /passphrase is wrong, or the data was changed/);
  assert.throws(() => open(sealed, Buffer.alloc(32), "user-1"), /passphrase is wrong/);
  const data = Buffer.from(sealed.data, "base64");
  data[0] ^= 1;
  assert.throws(() => open({ ...sealed, data: data.toString("base64") }, key, "user-1"), /data was changed/);
});

test("short passphrases are refused", async () => {
  await assert.rejects(deriveKey("short", newSalt()), /at least 12 characters/);
});
