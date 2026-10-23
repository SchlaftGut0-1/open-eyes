import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./state.ts";

export const usageFile = join(stateDir, "usage.log");

/** Measured on open-eyes outputs with Anthropic's tokenizer: 3.5 to 4.3 characters per token. */
const CHARS_PER_TOKEN = 3.8;

/** Approximate tokens an agent spends reading `text`. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export type UsageEntry = { time: string; command: string; tokens: number; ms: number };

/** Records what one command printed for the agent to read. */
export function recordUsage(command: string, output: string, ms: number): UsageEntry {
  const entry: UsageEntry = { time: new Date().toISOString(), command, tokens: estimateTokens(output), ms };
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    appendFileSync(usageFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Measuring must never break the command itself.
  }
  return entry;
}

export function readUsage(): UsageEntry[] {
  try {
    return readFileSync(usageFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as UsageEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function resetUsage(): void {
  rmSync(usageFile, { force: true });
}

const n = (value: number) => value.toLocaleString("en-US");

/** One line for the on-screen counter. */
export function usageSummary(last: UsageEntry, entries = readUsage()): string {
  const total = entries.reduce((sum, e) => sum + e.tokens, 0);
  return `last ${n(last.tokens)} tok · total ${n(total)} tok · ${entries.length} actions`;
}

/** The last `limit` actions with their cost, and the totals since the last reset. */
export function formatUsage(entries: UsageEntry[], limit: number): string {
  if (!entries.length) return 'no actions recorded since the last "open-eyes usage reset"';
  const shown = entries.slice(-limit);
  const width = Math.max(...shown.map((e) => e.command.length), 7);
  const rows = shown.map((e) => `${e.command.padEnd(width)}  ${n(e.tokens).padStart(7)} tok  ${n(e.ms).padStart(6)} ms`);
  const total = entries.reduce((sum, e) => sum + e.tokens, 0);
  const hidden = entries.length - shown.length;
  return [
    ...(hidden > 0 ? [`(${hidden} earlier actions not shown)`] : []),
    ...rows,
    `${"total".padEnd(width)}  ${n(total).padStart(7)} tok  in ${entries.length} actions (estimated, ~10%)`,
  ].join("\n");
}
