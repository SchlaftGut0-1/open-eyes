import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { parseCommand, SYSTEM, TOOLS } from "../src/navigator.ts";
import { formatCommand, toExample, type Trace } from "../src/trace.ts";

describe("formatCommand", () => {
  test("parseCommand splits it back into the same words", () => {
    assert.equal(formatCommand(["fill", "@4", 'Ana "the" María']), 'fill @4 "Ana \\"the\\" María"');
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }).filter((w) => w.trim() === w && !/\s/.test(w[0])), { minLength: 1, maxLength: 4 }), (words) => {
        const command = ["click", ...words];
        assert.deepEqual(parseCommand(formatCommand(command)), command);
      }),
    );
  });
});

describe("toExample", () => {
  const trace = (steps: string[], extra: Partial<Trace> = {}): Trace => ({
    id: "t",
    goal: "Sign up as Ana",
    started: "2026-10-25T00:00:00Z",
    steps: steps.map((command) => ({ command, output: `output of ${command}`, ms: 1 })),
    outcome: "done",
    answer: "Hello, Ana",
    ...extra,
  });

  test("becomes the chat the local model sees in open-eyes do", () => {
    const example = toExample(trace(["open https://example.com", "snapshot", 'fill @1 "Ana"', "click @4"]));
    assert.ok(!("skipped" in example));
    assert.deepEqual(example.tools, TOOLS);
    const [system, user, ...rest] = example.messages as { role: string; content: string; tool_calls?: { function: { name: string; arguments: string } }[] }[];
    assert.equal(system.content, SYSTEM);
    assert.equal(user.content, "Goal: Sign up as Ana\n\nCurrent snapshot:\noutput of snapshot");
    assert.deepEqual(
      rest.map((m) => (m.tool_calls ? `${m.tool_calls[0].function.name} ${m.tool_calls[0].function.arguments}` : `${m.role}: ${m.content}`)),
      [
        'open_eyes {"command":"fill @1 \\"Ana\\""}',
        'tool: output of fill @1 "Ana"',
        'open_eyes {"command":"click @4"}',
        "tool: output of click @4",
        'finish {"answer":"Hello, Ana","success":true}',
      ],
    );
  });

  test("skips traces the local model could not learn from", () => {
    assert.deepEqual(toExample(trace(["snapshot", "eval document.title"])), { skipped: 'uses "eval", which the local model cannot run' });
    assert.deepEqual(toExample(trace(["open https://example.com"])), { skipped: "no snapshot" });
    assert.deepEqual(toExample(trace(["snapshot"], { outcome: undefined })), { skipped: "still recording or never stopped" });
    const secret = trace(["snapshot", "fill (typed into a password field, not stored)"]);
    secret.steps[1].secret = true;
    assert.deepEqual(toExample(secret), { skipped: "typed into a password field, which is never stored" });
  });
});
