import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Guardrails against prompt injection: pages can hide instructions that steer the agent.
// They limit where the agent may go and make it ask the user before risky actions. They
// do not stop an agent that is itself compromised, which has a shell and could edit this
// file; the skill tells agents never to loosen the policy unless the user asks.

export type ConfirmMode = "risky" | "always" | "never";
export const CONFIRM_MODES: ConfirmMode[] = ["risky", "always", "never"];

export type Policy = {
  /** When not empty, only these sites (and their subdomains) are allowed. */
  allow: string[];
  /** Never allowed, even when also in `allow`. */
  block: string[];
  /** Which actions wait for the user's on-screen approval. */
  confirm: ConfirmMode;
};

export const policyFile = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "open-eyes",
  "policy.json",
);

/** Something the policy or the user did not allow; never retried by the agent. */
export class PolicyError extends Error {
  readonly outcome: "blocked" | "denied";

  constructor(outcome: "blocked" | "denied", message: string) {
    super(message);
    this.outcome = outcome;
  }
}

/** Accepts "example.com", "*.example.com" or a URL, and returns "example.com". */
export function normalizeSite(input: string): string {
  const raw = input.trim().toLowerCase();
  const host = raw.includes("://") ? (URL.parse(raw)?.hostname ?? "") : raw.replace(/^\*\./, "").split("/")[0];
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) throw new Error(`"${input}" is not a site name like example.com`);
  return host;
}

export function parsePolicy(raw: unknown): Policy {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sites = (value: unknown) =>
    Array.isArray(value)
      ? value.flatMap((site) => {
          try {
            return typeof site === "string" ? [normalizeSite(site)] : [];
          } catch {
            return [];
          }
        })
      : [];
  return {
    allow: sites(saved.allow),
    block: sites(saved.block),
    confirm: CONFIRM_MODES.includes(saved.confirm as ConfirmMode) ? (saved.confirm as ConfirmMode) : "risky",
  };
}

export function loadPolicy(): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(policyFile, "utf8"));
  } catch {
    // No policy yet: defaults.
  }
  const policy = parsePolicy(raw);
  const override = process.env.OPEN_EYES_CONFIRM as ConfirmMode | undefined;
  if (override && CONFIRM_MODES.includes(override)) policy.confirm = override;
  return policy;
}

export function savePolicy(policy: Policy): void {
  mkdirSync(dirname(policyFile), { recursive: true, mode: 0o700 });
  writeFileSync(policyFile, JSON.stringify(policy, null, 2), { mode: 0o600 });
}

// The browser's own pages: a page's hidden instructions must never steer the agent there.
const INTERNAL = new Set(["chrome:", "chrome-extension:", "chrome-untrusted:", "devtools:", "edge:", "brave:"]);

const covers = (site: string, host: string) => host === site || host.endsWith(`.${site}`);

/** Why the policy does not let the agent use `url`, or undefined when it does. */
export function blockedReason(policy: Policy, url: string): string | undefined {
  const parsed = URL.parse(url);
  if (!parsed) return `"${url}" is not a valid URL`;
  if (parsed.href === "about:blank") return undefined;
  if (INTERNAL.has(parsed.protocol)) return `${parsed.protocol} pages are the browser's own (settings, saved passwords, extensions); open-eyes never opens them`;
  const host = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : undefined;
  if (host && policy.block.some((site) => covers(site, host))) return `${host} is blocked by your open-eyes policy`;
  if (policy.allow.length && !(host && policy.allow.some((site) => covers(site, host)))) {
    return `${host ?? `this ${parsed.protocol} page`} is not in your open-eyes allow list`;
  }
  return undefined;
}

// Buttons whose effect is hard to undo: spending money, sending, deleting, publishing.
const RISKY_WORDS =
  /\b(buy|pay|purchase|checkout|check out|order|send|submit|delete|remove|transfer|confirm|publish|post|sign|subscribe|unsubscribe|donate|book|reserve|comprar|pagar|enviar|eliminar|borrar|transferir|confirmar|publicar|suscribir|reservar|firmar)\b/i;

/**
 * Whether clicking the element with this snapshot label (`button "Buy now"`) is risky.
 * Links count too: shops and apps style them as buttons ("Buy now", "Delete account").
 */
export function isRiskyClick(label: string): boolean {
  const [role, ...name] = label.split(" ");
  return ["button", "menuitem", "link"].includes(role) && hasRiskyWords(name.join(" "));
}

/** Whether `text` speaks of spending, sending, deleting or publishing. */
export const hasRiskyWords = (text: string): boolean => RISKY_WORDS.test(text);
