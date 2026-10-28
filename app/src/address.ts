export const SEARCH = "https://duckduckgo.com/?q=";

export function allowedInTab(url: string): boolean {
  if (url === "about:blank") return true;
  const protocol = URL.parse(url)?.protocol;
  return protocol === "https:" || protocol === "http:" || protocol === "file:";
}

const HOST_ADDRESS = /^(localhost|[^\s/:]+\.[^\s/:]+)(:\d+)?(\/\S*)?$/i;

export function toAddress(input: string): string {
  const text = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && allowedInTab(text)) return text;
  if (HOST_ADDRESS.test(text)) {
    return `${text.startsWith("localhost") ? "http" : "https"}://${text}`;
  }
  return SEARCH + encodeURIComponent(text);
}
