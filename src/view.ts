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
