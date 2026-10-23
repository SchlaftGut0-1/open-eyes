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
};

/** Appends one JSON line per agent action, so the user can review what happened. */
export function audit(entry: AuditEntry): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    appendFileSync(auditFile, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
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
      return [...parts, e.detail ? `(${e.detail})` : ""].filter(Boolean).join("  ");
    } catch {
      return line;
    }
  });
}
