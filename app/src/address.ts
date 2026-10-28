/** Where the address bar sends a search. */
export const SEARCH = "https://duckduckgo.com/?q=";

/**
 * What a tab may load. Everything else (javascript:, chrome:, devtools:, data:) is refused, so
 * a page cannot reach the browser's own pages or run code through a link.
 */
export function allowedInTab(url: string): boolean {
  if (url === "about:blank") return true;
  const protocol = URL.parse(url)?.protocol;
  return protocol === "https:" || protocol === "http:" || protocol === "file:";
}

/** Turns what the user typed into the address bar into a URL to open: an address, or a search. */
export function toAddress(input: string): string {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && allowedInTab(text)) return text;
  // A host (with a dot, or localhost), maybe a port and a path, and no spaces: an address.
  if (/^(localhost|[^\s/:]+\.[^\s/:]+)(:\d+)?(\/\S*)?$/i.test(text)) {
    return `${text.startsWith("localhost") ? "http" : "https"}://${text}`;
  }
  return SEARCH + encodeURIComponent(text);
}
