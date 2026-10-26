import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { formatSnapshot, type AXNode, type Frame } from "../src/snapshot.ts";

type Spec = { role: string; name: string; sources?: NonNullable<AXNode["name"]>["sources"]; children: Spec[] } & Omit<
  Partial<AXNode>,
  "role" | "name" | "childIds"
>;

const el = (role: string, name = "", extra: Partial<AXNode> = {}, children: Spec[] = []): Spec => {
  const { name: nameInfo, ...rest } = extra;
  return { ...rest, role, name, sources: nameInfo?.sources, children } as Spec;
};

/** Flattens a nested spec into the node list Chromium returns, root first. */
function page(...children: Spec[]): AXNode[] {
  const nodes: AXNode[] = [];
  const add = ({ role, name, sources, children, ...extra }: Spec): string => {
    const node: AXNode = { nodeId: String(nodes.length), ignored: false, ...extra, role: { value: role }, name: { value: name, sources } };
    nodes.push(node);
    node.childIds = children.map(add);
    return node.nodeId;
  };
  add(el("RootWebArea", "Page", {}, children));
  return nodes;
}

describe("formatSnapshot", () => {
  test("nests iframe content under the iframe, with refs that tell processes apart", () => {
    const payment = page(el("button", "Pay", { backendDOMNodeId: 5 }));
    payment[0].name = { value: "Payment" };
    const frames = new Map<string, Frame>([
      ["7", { nodes: payment, url: "https://pay.example/form", frame: "F1" }],
    ]);
    const nodes = page(el("button", "Back", { backendDOMNodeId: 5 }), el("Iframe", "", { backendDOMNodeId: 7 }), el("Iframe", "", { backendDOMNodeId: 8 }));
    const { text, refs, lineNodes } = formatSnapshot(nodes, { byNode: new Map([["F1:5", 9]]), nextRef: 1 }, frames);
    assert.equal(text, ["button Back @1", "iframe Payment", "  button Pay @9", "iframe"].join("\n"));
    assert.deepEqual(refs[9], { backendNodeId: 5, label: 'button "Pay"', frame: "F1", url: "https://pay.example/form" });
    assert.deepEqual(refs[1], { backendNodeId: 5, label: 'button "Back"' });
    assert.equal(lineNodes[2].backendNodeId, 7, "iframe content is placed by its <iframe>");
  });

  test("numbers actionable elements in document order", () => {
    const { text, refs } = formatSnapshot(
      page(
        el("heading", "Title"),
        el("button", "Save", { backendDOMNodeId: 10 }),
        el("link", "Home", { backendDOMNodeId: 11 }),
      ),
    );
    assert.equal(text, ["heading Title", "button Save @1", "link Home @2"].join("\n"));
    assert.deepEqual(refs, {
      1: { backendNodeId: 10, label: 'button "Save"' },
      2: { backendNodeId: 11, label: 'link "Home"' },
    });
  });

  test("hoists unnamed wrappers and ignored nodes", () => {
    const { text } = formatSnapshot(
      page(el("generic", "", {}, [el("none", "", { ignored: true }, [el("button", "Go", { backendDOMNodeId: 1 })])])),
    );
    assert.equal(text, "button Go @1");
  });

  test("drops text that repeats its parent's name or value", () => {
    const { text } = formatSnapshot(
      page(
        el("link", "Docs", { backendDOMNodeId: 1 }, [el("StaticText", "Docs")]),
        el("textbox", "Name", { backendDOMNodeId: 2, value: { value: "Ana" } }, [el("StaticText", "Ana")]),
        el("StaticText", "Standalone"),
      ),
    );
    assert.equal(text, ["link Docs @1", "textbox Name value=Ana @2", '"Standalone"'].join("\n"));
  });

  test("shows element states", () => {
    const { text } = formatSnapshot(
      page(
        el("checkbox", "Terms", {
          backendDOMNodeId: 1,
          properties: [
            { name: "checked", value: { value: "true" } },
            { name: "disabled", value: { value: true } },
          ],
        }),
        el("button", "Menu", { backendDOMNodeId: 2, properties: [{ name: "expanded", value: { value: false } }] }),
      ),
    );
    assert.equal(text, ["checkbox Terms [checked, disabled] @1", "button Menu [collapsed] @2"].join("\n"));
  });

  test("keeps the refs of elements it has seen before", () => {
    const nodes = page(
      el("button", "New", { backendDOMNodeId: 30 }),
      el("button", "Old", { backendDOMNodeId: 20 }),
    );
    const { text, refs, nextRef } = formatSnapshot(nodes, { byNode: new Map([["20", 4]]), nextRef: 7 });
    assert.equal(text, ["button New @7", "button Old @4"].join("\n"));
    assert.deepEqual(Object.keys(refs), ["4", "7"]);
    assert.equal(nextRef, 8);
  });

  test("quotes names only when they could be misread", () => {
    const { text } = formatSnapshot(
      page(
        el("button", "Save [draft]", { backendDOMNodeId: 1 }),
        el("link", "Reply to @3", { backendDOMNodeId: 2 }),
        el("textbox", "a=b", { backendDOMNodeId: 3, value: { value: "x @9" } }),
        el("heading", 'Say "hi"'),
      ),
    );
    assert.equal(
      text,
      ['button "Save [draft]" @1', 'link "Reply to @3" @2', 'textbox "a=b" value="x @9" @3', 'heading "Say \\"hi\\""'].join("\n"),
    );
  });

  test("drops unnamed list and table wrappers", () => {
    const { text } = formatSnapshot(
      page(el("list", "", {}, [el("listitem", "", {}, [el("link", "One", { backendDOMNodeId: 1 })])]), el("table", "Prices")),
    );
    assert.equal(text, ["link One @1", "table Prices"].join("\n"));
  });

  test("keeps unnamed table rows when asked, for --find", () => {
    const table = () => page(el("table", "", {}, [el("row", "", {}, [el("cell", "", {}, [el("StaticText", "Smith")]), el("cell", "", {}, [el("StaticText", "$50.00")])])]));
    assert.equal(formatSnapshot(table()).text, ['"Smith"', '"$50.00"'].join("\n"));
    assert.equal(formatSnapshot(table(), undefined, undefined, undefined, true).text, ["row", '  "Smith"', '  "$50.00"'].join("\n"));
  });

  test("drops list bullets, separators and decorative images", () => {
    const { text } = formatSnapshot(
      page(
        el("ListMarker", "•", {}, [el("StaticText", "•")]),
        el("StaticText", "Item"),
        el("separator"),
        el("image"),
        el("image", "Company logo"),
        el("link", "", { backendDOMNodeId: 1 }, [el("image")]),
      ),
    );
    assert.equal(text, ['"Item"', "image Company logo", "link @1"].join("\n"));
  });

  test("keeps citations as one clickable line", () => {
    const { text } = formatSnapshot(page(el("StaticText", "A claim."), el("superscript", "", {}, [el("link", "[1]", { backendDOMNodeId: 1 })])));
    assert.equal(text, ['"A claim."', 'link "[1]" @1'].join("\n"));
  });

  test("drops a label that repeats the element right before it", () => {
    const { text } = formatSnapshot(
      page(
        el("radio", "Small", { backendDOMNodeId: 1 }),
        el("StaticText", "Small"),
        el("radio", "Large", { backendDOMNodeId: 2 }),
        el("StaticText", "Large print is easier to read"),
      ),
    );
    assert.equal(text, ["radio Small @1", "radio Large @2", '"Large print is easier to read"'].join("\n"));
  });

  test("dissolves cells named after their own content, keeps names set on purpose", () => {
    const fromContents = { sources: [{ type: "contents", value: { value: "x" } }] };
    const fromLabel = { sources: [{ type: "attribute", attributeValue: { value: "x" } }, { type: "contents", superseded: true, value: { value: "x" } }] };
    const { text } = formatSnapshot(
      page(
        el("cell", "512 points by Jowsey | hide", { name: { value: "512 points by Jowsey | hide", ...fromContents } }, [
          el("StaticText", "512 points by"),
          el("link", "Jowsey", { backendDOMNodeId: 1 }),
          el("StaticText", "|"),
          el("link", "hide", { backendDOMNodeId: 2 }),
        ]),
        el("cell", "Votes", { name: { value: "Votes", ...fromLabel } }, [el("link", "up", { backendDOMNodeId: 3 })]),
      ),
    );
    assert.equal(text, ['"512 points by"', "link Jowsey @1", "link hide @2", "cell Votes", "  link up @3"].join("\n"));
  });

  test("truncates long text", () => {
    const { text } = formatSnapshot(page(el("heading", "x".repeat(500))));
    assert.equal(text, `heading ${"x".repeat(120)}…`);
  });
});

// Property-based tests: random accessibility trees, including hostile names.
const ROLES = ["button", "link", "textbox", "checkbox", "heading", "generic", "none", "group", "StaticText", "InlineTextBox", "list", "listitem"];
const treeArbitrary = fc
  .array(
    fc.record({
      role: fc.constantFrom(...ROLES),
      name: fc.oneof(fc.string(), fc.constantFrom("", "line\nbreak", '"quoted"', "​", "a".repeat(300))),
      ignored: fc.boolean(),
      backend: fc.option(fc.nat(), { nil: undefined }),
      parent: fc.nat(),
    }),
    { maxLength: 60 },
  )
  .map((specs) => {
    const nodes: AXNode[] = [{ nodeId: "root", ignored: false, role: { value: "RootWebArea" }, childIds: [] }];
    for (const [i, spec] of specs.entries()) {
      const parent = nodes[spec.parent % nodes.length];
      const id = `n${i}`;
      parent.childIds!.push(id);
      nodes.push({
        nodeId: id,
        ignored: spec.ignored,
        role: { value: spec.role },
        name: { value: spec.name },
        childIds: [],
        backendDOMNodeId: spec.backend,
      });
    }
    return nodes;
  });

describe("formatSnapshot properties", () => {
  test("refs in the text and the ref map always agree, numbered 1..n", () => {
    fc.assert(
      fc.property(treeArbitrary, (nodes) => {
        const { text, refs } = formatSnapshot(nodes);
        const inText = [...text.matchAll(/ @(\d+)$/gm)].map((m) => Number(m[1]));
        assert.deepEqual(inText, inText.map((_, i) => i + 1));
        assert.deepEqual(Object.keys(refs).map(Number), inText);
      }),
    );
  });

  test("every line is a well-formed entry, whatever the names contain", () => {
    fc.assert(
      fc.property(treeArbitrary, (nodes) => {
        const { text } = formatSnapshot(nodes);
        // An element line starts with its role; a text line is a JSON string.
        for (const line of text ? text.split("\n") : []) {
          const body = line.replace(/^(  )*/, "");
          if (body.startsWith('"')) assert.equal(typeof JSON.parse(body), "string");
          else assert.match(body, /^[A-Za-z]+( |$)/);
        }
      }),
    );
  });
});
