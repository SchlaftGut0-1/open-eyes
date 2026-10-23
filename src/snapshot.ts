import type { Ref } from "./state.ts";

export type AXNode = {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
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
]);
const SKIPPED = new Set(["InlineTextBox", "LineBreak"]);
const MAX_TEXT = 120;

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

/** The DOM node and role behind each snapshot line, to place it on the page. */
export type LineNode = { backendNodeId?: number; role: string };

/** Refs handed out earlier for the same document, so elements keep their @N. */
export type KnownRefs = { byNode: Map<number, number>; nextRef: number };

/**
 * Turns Chromium's accessibility tree into compact, indented text the model can read,
 * and numbers every actionable node so later commands can target it as @N. Elements
 * seen before keep their number, which keeps diffs between snapshots meaningful.
 */
export function formatSnapshot(
  nodes: AXNode[],
  known: KnownRefs = { byNode: new Map(), nextRef: 1 },
): { text: string; refs: Record<string, Ref>; nextRef: number; lineNodes: LineNode[] } {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const refs: Record<string, Ref> = {};
  const lines: string[] = [];
  const lineNodes: LineNode[] = [];
  const emit = (line: string, node: AXNode, role: string) => {
    lines.push(line);
    lineNodes.push({ backendNodeId: node.backendDOMNodeId, role });
  };
  let nextRef = known.nextRef;

  const visit = (node: AXNode, depth: number, parentName: string): void => {
    const role = node.role?.value ?? "";
    const name = String(node.name?.value ?? "").trim();
    const children = (node.childIds ?? []).flatMap((id) => byId.get(id) ?? []);
    const visitChildren = (childDepth: number, inheritedName: string) =>
      children.forEach((child) => visit(child, childDepth, inheritedName));

    if (node.ignored || SKIPPED.has(role)) return visitChildren(depth, parentName);

    const indent = "  ".repeat(depth);
    if (role === "StaticText") {
      // Text already shown as its parent's name (a link's label, a heading) is noise.
      // Text is always quoted, so it can never be mistaken for an element line.
      if (name && !parentName.includes(name)) emit(`${indent}${JSON.stringify(truncate(name))}`, node, role);
      return;
    }

    const interactive = INTERACTIVE.has(role) && node.backendDOMNodeId !== undefined;
    if (!interactive && !name && TRANSPARENT.has(role)) return visitChildren(depth, parentName);

    let line = `${indent}${role}`;
    if (name) line += ` ${bare(truncate(name))}`;
    const value = node.value?.value;
    if (value !== undefined && value !== "" && String(value) !== name) {
      line += ` value=${bare(truncate(String(value)))}`;
    }
    const flags = states(node);
    if (flags.length) line += ` [${flags.join(", ")}]`;
    if (interactive) {
      const ref = known.byNode.get(node.backendDOMNodeId!) ?? nextRef++;
      refs[ref] = { backendNodeId: node.backendDOMNodeId!, label: `${role} ${JSON.stringify(truncate(name))}` };
      line += ` @${ref}`;
    }
    emit(line, node, role);
    visitChildren(depth + 1, `${name} ${value ?? ""}`.trim() || parentName);
  };

  const root = nodes[0];
  if (root) {
    // The root is the document itself; its title is printed separately.
    const children = (root.childIds ?? []).flatMap((id) => byId.get(id) ?? []);
    children.forEach((child) => visit(child, 0, ""));
  }
  return { text: lines.join("\n"), refs, nextRef, lineNodes };
}
