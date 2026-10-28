import type { Session } from "electron";

export type SyncedCookie = {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  /** Seconds since the epoch; none for a cookie that ends with the browser session. */
  expirationDate?: number;
};

const SAME_SITE = new Set(["unspecified", "no_restriction", "lax", "strict"]);

export async function exportCookies(ses: Session): Promise<SyncedCookie[]> {
  const now = Date.now() / 1000;
  return (await ses.cookies.get({}))
    .filter((c) => c.domain && (c.expirationDate === undefined || c.expirationDate > now))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain!,
      hostOnly: c.hostOnly ?? false,
      path: c.path ?? "/",
      secure: c.secure ?? false,
      httpOnly: c.httpOnly ?? false,
      sameSite: c.sameSite ?? "unspecified",
      ...(c.expirationDate === undefined ? {} : { expirationDate: c.expirationDate }),
    }));
}

const isCookie = (c: Partial<SyncedCookie>): c is SyncedCookie =>
  typeof c?.name === "string" &&
  typeof c.value === "string" &&
  typeof c.domain === "string" &&
  /^\.?[a-z0-9.-]+$/i.test(c.domain) &&
  typeof c.path === "string" &&
  c.path.startsWith("/") &&
  SAME_SITE.has(c.sameSite as string) &&
  (c.expirationDate === undefined || Number.isFinite(c.expirationDate));

export async function importCookies(ses: Session, cookies: unknown): Promise<{ failed: number }> {
  let failed = 0;
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    if (!isCookie(cookie) || (cookie.expirationDate !== undefined && cookie.expirationDate * 1000 < Date.now())) {
      failed++;
      continue;
    }
    const host = cookie.domain.replace(/^\./, "");
    try {
      await ses.cookies.set({
        url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`,
        name: cookie.name,
        value: cookie.value,
        // A host-only cookie must not get a Domain attribute, or it would reach subdomains too.
        ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
      });
    } catch {
      failed++;
    }
  }
  return { failed };
}
