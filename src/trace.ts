import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, parseCommand, SYSTEM, TOOL_OUTPUT_LIMIT, TOOLS } from "./navigator.ts";
import { stateDir } from "./state.ts";

// Opt-in recordings of sessions, kept on this computer as examples for fine-tuning the
// local model (#76). Each trace is a JSON-lines file: a start line with the goal, one line
// per command with what it printed, and an end line with the outcome.
export const tracesDir = join(stateDir, "traces");
const activeFile = join(tracesDir, "active");

export type TraceStep = { command: string; output: string; ms: number; secret?: boolean };
export type Trace = {
  id: string;
  goal: string;
  started: string;
  steps: TraceStep[];
  ended?: string;
  outcome?: "done" | "failed";
  answer?: string;
};

const traceFile = (id: string) => join(tracesDir, `${id}.jsonl`);

function append(id: string, line: object): void {
  mkdirSync(tracesDir, { recursive: true, mode: 0o700 });
  appendFileSync(traceFile(id), `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

/** The trace being recorded, if any. */
export function activeTrace(): string | undefined {
  try {
    return readFileSync(activeFile, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function startTrace(goal: string): string {
  const running = activeTrace();
  if (running) throw new Error(`already recording trace ${running}; run "open-eyes trace stop" first`);
  const started = new Date().toISOString();
  const id = started.replace(/[:.]/g, "-");
  append(id, { type: "start", id, goal, started });
  writeFileSync(activeFile, id, { mode: 0o600 });
  return id;
}

/** Stands for the output of every command after a password was typed. */
export const HIDDEN_AFTER_SECRET = "(not stored: a password was typed earlier in this trace)";

export function recordStep(id: string, step: TraceStep): void {
  try {
    // A typed password can come back in a later output (a form sent with GET puts it in the
    // URL, a page may echo it), so once one was typed nothing printed after it is kept.
    // Such traces are never exported anyway.
    if (!step.secret && readTrace(id).steps.some((earlier) => earlier.secret)) step = { ...step, output: HIDDEN_AFTER_SECRET };
    append(id, { type: "step", ...step });
  } catch {
    // Recording must never break the command itself.
  }
}

export function stopTrace(outcome: "done" | "failed", answer: string): Trace {
  const id = activeTrace();
  if (!id) throw new Error('not recording; start with open-eyes trace start "<goal>"');
  append(id, { type: "end", ended: new Date().toISOString(), outcome, answer });
  rmSync(activeFile, { force: true });
  return readTrace(id);
}

export function readTrace(id: string): Trace {
  if (!/^[\w-]+$/.test(id)) throw new Error(`no trace "${id}"`);
  let text: string;
  try {
    text = readFileSync(traceFile(id), "utf8");
  } catch {
    throw new Error(`no trace "${id}"; "open-eyes trace" lists them`);
  }
  const trace: Trace = { id, goal: "", started: "", steps: [] };
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      const { type, ...data } = JSON.parse(line);
      if (type === "start") Object.assign(trace, { goal: data.goal, started: data.started });
      else if (type === "step") trace.steps.push(data as TraceStep);
      else if (type === "end") Object.assign(trace, { ended: data.ended, outcome: data.outcome, answer: data.answer });
    } catch {
      // A line cut short by a crash; the rest of the trace still counts.
    }
  }
  return trace;
}

export function listTraces(): Trace[] {
  let files: string[];
  try {
    files = readdirSync(tracesDir).filter((file) => file.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return files.sort().map((file) => readTrace(file.slice(0, -".jsonl".length)));
}

export function deleteTraces(ids: string[] | "all"): number {
  const traces = ids === "all" ? listTraces().map((trace) => trace.id) : ids;
  for (const id of traces) {
    readTrace(id); // Fails on an unknown id before anything is deleted.
    if (activeTrace() === id) rmSync(activeFile, { force: true });
  }
  for (const id of traces) rmSync(traceFile(id), { force: true });
  return traces.length;
}

/** Writes words back as one command line that parseCommand splits the same way. */
export function formatCommand(words: string[]): string {
  return words.map((word) => (/^[^\s"'\\]+$/.test(word) ? word : `"${word.replace(/["\\]/g, "\\$&")}"`)).join(" ");
}

export type Example = { messages: object[]; tools: typeof TOOLS };

/**
 * A finished trace as one fine-tuning example, in the chat and tool-call format of
 * `open-eyes do`, so the model learns exactly what it later sees: the same system prompt,
 * the goal with the first snapshot, then one open_eyes call per command and a finish call.
 * Commands before the first snapshot (opening the page) are setup, not part of the example.
 */
export function toExample(trace: Trace): Example | { skipped: string } {
  if (!trace.outcome) return { skipped: "still recording or never stopped" };
  if (trace.steps.some((step) => step.secret)) return { skipped: "typed into a password field, which is never stored" };
  const first = trace.steps.findIndex((step) => parseCommand(step.command)[0] === "snapshot");
  if (first === -1) return { skipped: "no snapshot" };
  const rest = trace.steps.slice(first + 1);
  const outside = rest.map((step) => parseCommand(step.command)[0]).find((command) => !COMMANDS.includes(command));
  if (outside) return { skipped: `uses "${outside}", which the local model cannot run` };

  const messages: object[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Goal: ${trace.goal}\n\nCurrent snapshot:\n${trace.steps[first].output}` },
  ];
  rest.forEach((step, i) => {
    const id = `call${i + 1}`;
    const call = { id, type: "function", function: { name: "open_eyes", arguments: JSON.stringify({ command: step.command }) } };
    messages.push({ role: "assistant", content: "", tool_calls: [call] }, { role: "tool", tool_call_id: id, content: step.output.slice(0, TOOL_OUTPUT_LIMIT) });
  });
  const finish = { answer: trace.answer ?? "", success: trace.outcome === "done" };
  const call = { id: "finish", type: "function", function: { name: "finish", arguments: JSON.stringify(finish) } };
  messages.push({ role: "assistant", content: "", tool_calls: [call] });
  return { messages, tools: TOOLS };
}
