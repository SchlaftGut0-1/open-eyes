import { allowedInTab } from "./address.ts";

export type SavedTab = { url: string; pinned?: boolean };
export type SavedSpace = { id: string; name: string; color: string; icon: string; tabs: SavedTab[]; active: number };
export type Saved = { spaces: SavedSpace[]; current: string };

export const COLORS = ["#7c5cff", "#0d9488", "#d97706", "#e11d48", "#3b82f6", "#db2777"];
export const ICONS = ["user", "briefcase", "house", "flask-conical", "graduation-cap", "shopping-cart", "code", "heart", "globe", "star"];
const ID = /^[a-z0-9]{1,16}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const MAX_NAME = 32;

export const FIRST_SPACE: SavedSpace = { id: "personal", name: "Personal", color: COLORS[0], icon: ICONS[0], tabs: [], active: 0 };

export function spaceName(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const name = input.trim().replace(/\s+/g, " ");
  return name && name.length <= MAX_NAME && !/\p{Cc}/u.test(name) ? name : undefined;
}

export const spaceColor = (input: unknown): string => (typeof input === "string" && COLOR.test(input) ? input : COLORS[0]);
export const spaceIcon = (input: unknown): string => (typeof input === "string" && ICONS.includes(input) ? input : ICONS[0]);

export function parseSaved(raw: unknown): Saved {
  const saved = (raw && typeof raw === "object" ? raw : {}) as { spaces?: unknown; current?: unknown };
  const spaces: SavedSpace[] = [];
  for (const item of Array.isArray(saved.spaces) ? saved.spaces : []) {
    const space = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const name = spaceName(space.name);
    if (typeof space.id !== "string" || !ID.test(space.id) || !name || spaces.some((s) => s.id === space.id)) continue;
    const tabs = (Array.isArray(space.tabs) ? space.tabs : []).flatMap((tab: { url?: unknown; pinned?: unknown }) =>
      typeof tab?.url === "string" && allowedInTab(tab.url) ? [{ url: tab.url, ...(tab.pinned === true ? { pinned: true } : {}) }] : [],
    );
    const active = Number.isInteger(space.active) && (space.active as number) >= 0 && (space.active as number) < tabs.length ? (space.active as number) : 0;
    spaces.push({ id: space.id, name, color: spaceColor(space.color), icon: spaceIcon(space.icon), tabs, active });
  }
  if (!spaces.length) spaces.push({ ...FIRST_SPACE, tabs: [] });
  const current = spaces.some((s) => s.id === saved.current) ? (saved.current as string) : spaces[0].id;
  return { spaces, current };
}
