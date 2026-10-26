import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./state.ts";

export const auditFile = join(stateDir, "audit.log");

export type AuditEntry = {
  action: string;
  /** What was acted on. Never the text typed into a field. */
  target?: string;
  url?: string;
  outcome: "ok" | "error" | "blocked" | "denied";
  detail?: string;
  /** What the user allowed on screen before the action went ahead, if it asked. */
  allowed?: string[];
};

/**
 * Cuts the query string and fragment off every URL in `text`. They often carry what the user
 * typed (searches, emails, phone numbers) or secrets (tokens, codes), which the audit log
 * promises never to keep; origin and path still say where the agent was.
 */
export function withoutQueries(text: string): string {
  // Lazy, so punctuation that ends a sentence (as in "changed to <url>; run ...") stays.
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*?(?=[;,.)]*(?:[\s"'<>]|$))/gi, "$1");
}

/** Appends one JSON line per agent action, so the user can review what happened. */
export function audit(entry: AuditEntry): void {
  const clean = (text?: string) => (text === undefined ? undefined : withoutQueries(text));
  const line = {
    time: new Date().toISOString(),
    ...entry,
    target: clean(entry.target),
    url: clean(entry.url),
    detail: clean(entry.detail),
    allowed: entry.allowed?.map(clean),
  };
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    appendFileSync(auditFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // Auditing must never break the action itself.
  }
}

/** The last `limit` entries, one readable line each. */
export function readAudit(limit: number): string[] {
  let lines: string[];
  try {
    lines = readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
  return lines.slice(-limit).map((line) => {
    try {
      const e = JSON.parse(line) as AuditEntry & { time: string };
      const parts = [e.time, e.outcome.toUpperCase().padEnd(7), e.action, e.target ?? "", e.url ? `on ${e.url}` : ""];
      const allowed = e.allowed?.length ? `(the user allowed: ${e.allowed.join("; ")})` : "";
      return [...parts, allowed, e.detail ? `(${e.detail})` : ""].filter(Boolean).join("  ");
    } catch {
      return line;
    }
  });
}
