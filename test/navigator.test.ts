import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { modelEndpoint, parseCommand } from "../src/navigator.ts";

describe("parseCommand", () => {
  test("splits a command line, keeping quoted text together", () => {
    assert.deepEqual(parseCommand('fill @4 "Ana María"'), ["fill", "@4", "Ana María"]);
    assert.deepEqual(parseCommand("click --name 'Accept terms'"), ["click", "--name", "Accept terms"]);
  });

  test("tolerates what small models write", () => {
    assert.deepEqual(parseCommand("open-eyes click @3"), ["click", "@3"]);
    assert.deepEqual(parseCommand('--find "Paid"'), ["snapshot", "--find", "Paid"]);
    assert.deepEqual(parseCommand("snapshot --find first story points"), ["snapshot", "--find", "first story points"]);
  });
});

describe("modelEndpoint", () => {
  test("is undefined without a URL", () => {
    assert.equal(modelEndpoint({}), undefined);
    assert.equal(modelEndpoint({ OPEN_EYES_MODEL_URL: " " }), undefined);
  });

  test("reads the URL, model and key", () => {
    assert.deepEqual(modelEndpoint({ OPEN_EYES_MODEL_URL: "http://127.0.0.1:8080/v1/", OPEN_EYES_MODEL: "gemma", OPEN_EYES_MODEL_KEY: "k" }), {
      url: "http://127.0.0.1:8080/v1",
      model: "gemma",
      key: "k",
    });
  });
});
