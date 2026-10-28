import type { Ref } from "./state.ts";

export type AXNode = {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: {
    value: string;
    /** How Chromium computed the name; the first source that is not superseded won. */
    sources?: { type: string; superseded?: boolean; value?: unknown; attributeValue?: unknown }[];
  };
  value?: { value: unknown };
  childIds?: string[];
  backendDOMNodeId?: number;
  properties?: { name: string; value: { value: unknown } }[];
};

/** Roles the agent can act on; these get an @N ref. */
const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "listbox",
  "treeitem",
]);
/** Wrapper roles that add nothing when unnamed; their children are hoisted. */
const TRANSPARENT = new Set([
  "generic",
  "none",
  "presentation",
  "group",
  "paragraph",
  "Section",
  "LabelText",
  "list",
  "listitem",
  "table",
  "rowgroup",
  "row",
  "cell",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
  "superscript",
  "subscript",
]);
const SKIPPED = new Set(["InlineTextBox", "LineBreak"]);
/** Dropped with everything inside: list bullets and separators say nothing to an agent. */
const DROPPED = new Set(["ListMarker", "separator"]);
const MAX_TEXT = 120;

const property = (node: AXNode, name: string) => node.properties?.find((p) => p.name === name)?.value.value;

/** The root of a contenteditable region: editable and focusable, unlike the text inside it. */
const isEditorRoot = (node: AXNode) => property(node, "editable") !== undefined && property(node, "focusable") === true;

/** Whether Chromium built the name from the node's own content (as for a table cell). */
const nameFromContents = (node: AXNode) =>
  node.name?.sources?.find((s) => !s.superseded && (s.value !== undefined || s.attributeValue !== undefined))?.type ===
  "contents";

/** Text with no letters or digits, such as the "|" and "·" between links. */
const PUNCTUATION_ONLY = /^[\p{P}\p{S}\s]+$/u;

const truncate = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

/**
 * Element names and values are printed bare to save tokens, and quoted only when they could
 * be misread: brackets look like states, "=" like a value, "@3" like a ref.
 */
const bare = (text: string) => (/["[\]=\n]|@\d|^\s|\s$/.test(text) ? JSON.stringify(text) : text);

function states(node: AXNode): string[] {
  const out: string[] = [];
  for (const { name, value } of node.properties ?? []) {
    const v = value.value;
    if (name === "checked" && v !== "false" && v !== false) out.push(v === "mixed" ? "checked=mixed" : "checked");
    else if (name === "expanded") out.push(v ? "expanded" : "collapsed");
    else if (["disabled", "focused", "selected", "required"].includes(name) && v) out.push(name);
  }
  return out;
}

/**
 * The DOM node and role behind each snapshot line, to place it on the page. Lines inside an
 * iframe are placed by the outermost <iframe> element in the page.
 */
export type LineNode = { backendNodeId?: number; role: string };

/** Refs handed out earlier for the same document, keyed by `nodeKey`, so elements keep their @N. */
export type KnownRefs = { byNode: Map<string, number>; nextRef: number };

/**
 * An iframe's accessibility tree and URL. `frame` is the cross-origin frame whose own session
 * holds the nodes; same-process frames share their parent's.
 */
export type Frame = { nodes: AXNode[]; url: string; frame?: string };

/** Node ids are only unique within a process, so cross-origin frames prefix theirs. */
export const nodeKey = (frame: string | undefined, backendNodeId: number) =>
  frame ? `${frame}:${backendNodeId}` : String(backendNodeId);

/**
 * Where a node lives: its tree, and for iframe content the frame, URL and <iframe> to place it by.
 * `base` is the URL of the document the node is in.
 */
type Context = { byId: Map<string, AXNode>; frame?: string; url?: string; place?: number; base?: string };

/** Where a link goes, as short as it can be said: the #fragment on the same page, the path on the same site, else host and path. */
function linkHint(href: string, base: string | undefined): string {
  const url = URL.parse(href, base);
  if (!url || !url.protocol.startsWith("http")) return href;
  const page = URL.parse(base ?? "");
  const path = `${url.pathname}${url.search}`;
  if (page?.origin !== url.origin) return `${url.host}${path === "/" ? "" : path}${url.hash}`;
  return url.hash && path === `${page.pathname}${page.search}` ? url.hash : `${path}${url.hash}`;
}

/**
 * Turns Chromium's accessibility tree into compact, indented text the model can read,
 * and numbers every actionable node so later commands can target it as @N. Elements
 * seen before keep their number, which keeps diffs between snapshots meaningful. The
 * content of each iframe in `frames` (keyed by its <iframe> element) is nested under it.
 */
export function formatSnapshot(
  nodes: AXNode[],
  known: KnownRefs = { byNode: new Map(), nextRef: 1 },
  frames: Map<string, Frame> = new Map(),
  /** Elements of the page (not its iframes) with draggable="true", which the tree does not mark. */
  draggable: Set<number> = new Set(),
  /** Keep table rows as `row` lines, so --find can show a match with its row (#100). */
  rows = false,
): { text: string; refs: Record<string, Ref>; nextRef: number; lineNodes: LineNode[] } {
  const refs: Record<string, Ref> = {};
  const lines: string[] = [];
  const lineNodes: LineNode[] = [];
  const emit = (line: string, node: AXNode, role: string, ctx: Context) => {
    lines.push(line);
    lineNodes.push({ backendNodeId: ctx.place ?? node.backendDOMNodeId, role });
  };
  let nextRef = known.nextRef;

  // The element printed last, to drop a label repeated right after it ("radio Small", "Small").
  let previous: { depth: number; name: string } | undefined;

  const visit = (node: AXNode, depth: number, parentName: string, ctx: Context): void => {
    const role = node.role?.value ?? "";
    // A wrapper named after its own content (a table cell, a list item) would repeat what
    // its children already say, so it is treated as unnamed and dissolved.
    const name = TRANSPARENT.has(role) && nameFromContents(node) ? "" : String(node.name?.value ?? "").trim();
    if (DROPPED.has(role) && !node.ignored) return;
    const children = (node.childIds ?? []).flatMap((id) => ctx.byId.get(id) ?? []);
    const visitChildren = (childDepth: number, inheritedName: string) =>
      children.forEach((child) => visit(child, childDepth, inheritedName, ctx));

    if (node.ignored || SKIPPED.has(role)) return visitChildren(depth, parentName);

    const indent = "  ".repeat(depth);
    if (role === "Iframe") {
      const content = node.backendDOMNodeId === undefined ? undefined : frames.get(nodeKey(ctx.frame, node.backendDOMNodeId));
      const title = String(content?.nodes[0]?.name?.value ?? "").trim() || name || (content && URL.parse(content.url)?.host) || "";
      emit(`${indent}iframe${title ? ` ${bare(truncate(title))}` : ""}`, node, role, ctx);
      previous = undefined;
      if (content) {
        visitTree(content.nodes, depth + 1, { frame: content.frame, url: content.url, place: ctx.place ?? node.backendDOMNodeId });
      }
      return;
    }
    if (role === "StaticText") {
      // Text already shown as its parent's name (a link's label, a heading) is noise.
      const repeatsLabel = previous?.depth === depth && previous.name === name;
      // Text is always quoted, so it can never be mistaken for an element line.
      if (name && !parentName.includes(name) && !repeatsLabel && !PUNCTUATION_ONLY.test(name)) {
        emit(`${indent}${JSON.stringify(truncate(name))}`, node, role, ctx);
        previous = undefined;
      }
      return;
    }

    // Also actionable: a rich-text editor (fill types into it), a named image (hover may
    // reveal what it hides) and anything draggable (drag moves it).
    const actionable =
      INTERACTIVE.has(role) ||
      isEditorRoot(node) ||
      (role === "image" && name !== "") ||
      (ctx.frame === undefined && ctx.place === undefined && draggable.has(node.backendDOMNodeId!));
    const interactive = actionable && node.backendDOMNodeId !== undefined;
    if (!interactive && !name && TRANSPARENT.has(role) && !(rows && role === "row")) return visitChildren(depth, parentName);
    if (role === "image" && !name && !interactive) return; // Decorative.

    let line = `${indent}${role}`;
    if (name) line += ` ${bare(truncate(name))}`;
    // An unnamed link (a logo, an icon) says nothing else about itself (#166).
    const href = role === "link" && !name ? property(node, "url") : undefined;
    if (typeof href === "string" && href) line += ` url=${bare(truncate(linkHint(href, ctx.base)))}`;
    const value = node.value?.value;
    if (value !== undefined && value !== "" && String(value) !== name) {
      line += ` value=${bare(truncate(String(value)))}`;
    }
    const flags = states(node);
    if (flags.length) line += ` [${flags.join(", ")}]`;
    if (interactive) {
      const ref = known.byNode.get(nodeKey(ctx.frame, node.backendDOMNodeId!)) ?? nextRef++;
      refs[ref] = { backendNodeId: node.backendDOMNodeId!, label: `${role} ${JSON.stringify(truncate(name))}` };
      if (ctx.frame) refs[ref].frame = ctx.frame;
      if (ctx.url) refs[ref].url = ctx.url;
      line += ` @${ref}`;
    }
    emit(line, node, role, ctx);
    previous = { depth, name };
    visitChildren(depth + 1, `${name} ${value ?? ""}`.trim() || parentName);
  };

  // The root is the document itself; its title is printed separately (or on the iframe line).
  const visitTree = (tree: AXNode[], depth: number, where: Omit<Context, "byId">) => {
    const root = tree[0] && property(tree[0], "url");
    const base = typeof root === "string" ? root : where.url;
    const ctx = { ...where, base, byId: new Map(tree.map((node) => [node.nodeId, node])) };
    for (const id of tree[0]?.childIds ?? []) {
      const child = ctx.byId.get(id);
      if (child) visit(child, depth, "", ctx);
    }
  };
  visitTree(nodes, 0, {});
  return { text: lines.join("\n"), refs, nextRef, lineNodes };
}
