// Ways to look at part of a snapshot. Snapshot lines are indented two spaces per level,
// so a line's ancestors are the closest earlier lines with less indentation.

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Index of the closest earlier line that is an ancestor of `lines[index]`. */
function parentIndex(lines: string[], index: number, indent = indentOf(lines[index] ?? "")): number {
  for (let i = index - 1; i >= 0; i--) if (indentOf(lines[i]) < indent) return i;
  return -1;
}

/** The element with ref `@N` and everything inside it, dedented. */
export function subtree(lines: string[], ref: string): string[] {
  const key = ref.replace(/^@/, "");
  const start = lines.findIndex((line) => line.endsWith(` @${key}`));
  if (start === -1) throw new Error(`@${key} is not on the page; run "open-eyes snapshot" to get current refs`);
  const base = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && indentOf(lines[end]) > base) end++;
  return lines.slice(start, end).map((line) => line.slice(base));
}

/** Lines containing `query` (case-insensitive), each with its ancestors for context. */
export function findLines(lines: string[], query: string): string[] {
  const needle = query.toLowerCase();
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!line.toLowerCase().includes(needle)) return;
    for (let at = i; at !== -1 && !keep.has(at); at = parentIndex(lines, at)) keep.add(at);
  });
  return [...keep].sort((a, b) => a - b).map((i) => lines[i]);
}

/** One page of `limit` lines with a footer explaining how to see more. limit <= 0: all. */
export function paginate(lines: string[], limit: number, page = 1): string[] {
  if (limit <= 0 || lines.length <= limit) return lines;
  const pages = Math.ceil(lines.length / limit);
  const current = Math.min(Math.max(page, 1), pages);
  const from = (current - 1) * limit;
  const to = Math.min(from + limit, lines.length);
  const next = current < pages ? `next: --page ${current + 1}; ` : "";
  return [
    ...lines.slice(from, to),
    `… page ${current} of ${pages} (lines ${from + 1}-${to} of ${lines.length}); ${next}narrow with --find <text> or --scope @N`,
  ];
}

/**
 * Lines added (`+ `) and removed (`- `) between two snapshots, each change preceded by
 * its closest unchanged ancestor (`  `) so the reader knows where it happened.
 * Returns [] when nothing changed, or undefined when the change is too large to diff.
 */
export function diffLines(before: string[], after: string[], maxCells = 4_000_000): string[] | undefined {
  // Most updates touch a small region: skip the common head and tail first.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const b = before.slice(start, endBefore);
  const a = after.slice(start, endAfter);
  if (b.length === 0 && a.length === 0) return [];
  if (b.length * a.length > maxCells) return undefined;

  // Longest common subsequence over the changed region.
  const width = a.length + 1;
  const lcs = new Uint32Array((b.length + 1) * width);
  for (let i = b.length - 1; i >= 0; i--) {
    for (let j = a.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        b[i] === a[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const out: string[] = [];
  const shownContext = new Set<number>();
  let inHunk = false;
  const change = (sign: "+" | "-", line: string, afterIndex: number) => {
    if (!inHunk) {
      const context = parentIndex(after, afterIndex, indentOf(line));
      if (context !== -1 && !shownContext.has(context)) {
        shownContext.add(context);
        out.push(`  ${after[context]}`);
      }
      inHunk = true;
    }
    out.push(`${sign} ${line}`);
  };

  let i = 0;
  let j = 0;
  while (i < b.length || j < a.length) {
    if (i < b.length && j < a.length && b[i] === a[j]) {
      inHunk = false;
      i++;
      j++;
    } else if (j < a.length && (i === b.length || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
      change("+", a[j], start + j);
      j++;
    } else {
      change("-", b[i], start + j);
      i++;
    }
  }
  return out;
}

/** Where a line's element is relative to the viewport; undefined when it has no box. */
export type Position = "above" | "below" | "beside" | "visible" | undefined;

const LANDMARKS = new Set(["banner", "navigation", "main", "contentinfo", "complementary", "search", "form", "dialog", "region"]);
const MAX_OUTLINE = 40;

/**
 * The lines on screen, each with its ancestors for context, and an outline of the headings
 * and landmarks elsewhere so the agent knows what else the page holds.
 */
export function viewportView(
  lines: string[],
  roles: string[],
  positions: Position[],
): { shown: string[]; hidden: number; outline: string[] } {
  const keep = new Set<number>();
  positions.forEach((position, i) => {
    if (position !== "visible") return;
    for (let at = i; at !== -1 && !keep.has(at); at = parentIndex(lines, at)) keep.add(at);
  });
  const nameOf = (i: number) => lines[i].trim().replace(/^\S+ ?/, "");
  const headings = new Set(lines.flatMap((_, i) => (roles[i] === "heading" ? [nameOf(i)] : [])));
  const outline = lines.flatMap((line, i) => {
    const where = positions[i];
    if (keep.has(i) || (where !== "above" && where !== "below")) return [];
    const landmark = LANDMARKS.has(roles[i]) && nameOf(i) !== "";
    // Sections are often a region named after their heading; list the heading once.
    if (roles[i] !== "heading" && !(landmark && !headings.has(nameOf(i)))) return [];
    return [`${line.trim()} (${where})`];
  });
  return {
    shown: [...keep].sort((a, b) => a - b).map((i) => lines[i]),
    hidden: lines.length - keep.size,
    outline:
      outline.length > MAX_OUTLINE
        ? [...outline.slice(0, MAX_OUTLINE), `… ${outline.length - MAX_OUTLINE} more headings`]
        : outline,
  };
}
