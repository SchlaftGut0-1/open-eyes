import assert from "node:assert/strict";
import { test } from "node:test";
import { browserControl, overlayControl } from "../src/control.ts";
import type { OverlayCommand, Owner } from "../src/overlay.ts";

function browser(owner: "agent" | "user") {
  const sent: [string, object][] = [];
  const drawn: [OverlayCommand, Owner | undefined][] = [];
  const control = browserControl(
    async (method, params) => {
      sent.push([method, params]);
      return { owner: method === "OpenEyes.handoff" ? "user" : owner };
    },
    () => "T1",
    async (cmd, owner) => {
      drawn.push([cmd, owner]);
      return "agent";
    },
  );
  return { control, sent, drawn };
}

test("in open-eyes Browser the browser says who is in control, not the overlay", async () => {
  const { control, sent, drawn } = browser("user");
  assert.equal(await control.step({ label: "typing into Email", x: 1, y: 2 }), "user");
  assert.deepEqual(sent, [["OpenEyes.step", { targetId: "T1", label: "typing into Email" }]]);
  assert.deepEqual(drawn, [[{ type: "action", label: "typing into Email", x: 1, y: 2 }, "user"]], "the overlay draws the browser's owner");
});

test("the agent can give control away but never take it back", async () => {
  const { control, sent } = browser("agent");
  assert.equal(await control.handoff("Solve the captcha"), "user");
  assert.equal(await control.handoff(undefined), "agent");
  assert.equal(await control.poll("Solve the captcha"), "agent");
  assert.deepEqual(
    sent.map(([method]) => method),
    ["OpenEyes.handoff", "OpenEyes.owner", "OpenEyes.owner"],
  );
  assert.deepEqual(sent[0][1], { targetId: "T1", message: "Solve the captcha" });
});

test("elsewhere the overlay keeps who is in control, as before", async () => {
  const drawn: OverlayCommand[] = [];
  const control = overlayControl(
    async (cmd) => {
      drawn.push(cmd);
      return cmd.type === "handoff" || cmd.type === "claim" ? "user" : "agent";
    },
    async () => "user",
  );
  assert.equal(await control.step({ label: "click OK" }), "agent");
  assert.equal(await control.handoff("Log in"), "user");
  assert.equal(await control.handoff(undefined), "agent");
  assert.equal(await control.poll("Log in"), "user");
  assert.equal(await control.owner(), "user");
  assert.deepEqual(drawn, [
    { type: "action", label: "click OK" },
    { type: "handoff", message: "Log in" },
    { type: "show" },
    { type: "claim", message: "Log in" },
  ]);
});
