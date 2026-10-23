import type { Page } from "./page.ts";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (page: Page) => Promise<unknown>;

/**
 * Runs an agent-written script with `page` in scope, so a multi-step task
 * (snapshot, fill, click, wait) costs one tool call instead of many.
 */
export function runScript(page: Page, source: string): Promise<unknown> {
  return new AsyncFunction("page", source)(page);
}
