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
const TRANSPARENT = new Set(["generic", "none", "presentation", "group", "paragraph", "Section", "LabelText"]);
const SKIPPED = new Set(["InlineTextBox", "LineBreak"]);
const MAX_TEXT = 120;

const truncate = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

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
): { text: string; refs: Record<string, Ref>; nextRef: number } {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const refs: Record<string, Ref> = {};
  const lines: string[] = [];
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
      if (name && !parentName.includes(name)) lines.push(`${indent}- text ${JSON.stringify(truncate(name))}`);
      return;
    }

    const interactive = INTERACTIVE.has(role) && node.backendDOMNodeId !== undefined;
    if (!interactive && !name && TRANSPARENT.has(role)) return visitChildren(depth, parentName);

    let line = `${indent}- ${role}`;
    if (name) line += ` ${JSON.stringify(truncate(name))}`;
    const value = node.value?.value;
    if (value !== undefined && value !== "" && String(value) !== name) {
      line += ` value=${JSON.stringify(truncate(String(value)))}`;
    }
    const flags = states(node);
    if (flags.length) line += ` [${flags.join(", ")}]`;
    if (interactive) {
      const ref = known.byNode.get(node.backendDOMNodeId!) ?? nextRef++;
      refs[ref] = { backendNodeId: node.backendDOMNodeId!, label: `${role} ${JSON.stringify(truncate(name))}` };
      line += ` @${ref}`;
    }
    lines.push(line);
    visitChildren(depth + 1, `${name} ${value ?? ""}`.trim() || parentName);
  };

  const root = nodes[0];
  if (root) {
    // The root is the document itself; its title is printed separately.
    const children = (root.childIds ?? []).flatMap((id) => byId.get(id) ?? []);
    children.forEach((child) => visit(child, 0, ""));
  }
  return { text: lines.join("\n"), refs, nextRef };
}
