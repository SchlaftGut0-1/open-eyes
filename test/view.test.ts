import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { diffLines, findLines, interactiveIndexes, paginate, refsByName, subtree, viewportView, type Position } from "../src/view.ts";

const page = [
  '- heading "Shop"',
  '- list "Cart"',
  '  - listitem "Apples"',
  '    - button "Remove" @3',
  '  - listitem "Pears"',
  '    - button "Remove" @4',
  '- button "Checkout" @5',
];

describe("diffLines", () => {
  test("reports nothing when nothing changed", () => {
    assert.deepEqual(diffLines(page, [...page]), []);
  });

  test("shows added and removed lines under their closest unchanged parent", () => {
    const after = [...page.slice(0, 4), '  - listitem "Plums"', '    - button "Remove" @6', ...page.slice(6)];
    assert.deepEqual(diffLines(page, after), [
      '  - list "Cart"',
      '+   - listitem "Plums"',
      '+     - button "Remove" @6',
      '-   - listitem "Pears"',
      '-     - button "Remove" @4',
    ]);
  });

  test("shows a changed value as a replacement", () => {
    const before = ['- textbox "Name" @1', '- button "Send" @2'];
    const after = ['- textbox "Name" value="Ana" @1', '- button "Send" @2'];
    assert.deepEqual(diffLines(before, after), ['+ - textbox "Name" value="Ana" @1', '- - textbox "Name" @1']);
  });

  test("gives up on changes too large to diff", () => {
    assert.equal(diffLines(["a", "b"], ["c", "d"], 3), undefined);
  });
});

describe("diffLines properties", () => {
  const lines = fc.array(fc.constantFrom("- a", "  - b", "    - c", "- d @1", "  - e @2", "- f"), { maxLength: 40 });

  test("accounts for every line exactly", () => {
    fc.assert(
      fc.property(lines, lines, (before, after) => {
        const out = diffLines(before, after)!;
        const added = out.filter((l) => l.startsWith("+ ")).map((l) => l.slice(2));
        const removed = out.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
        assert.equal(added.length - removed.length, after.length - before.length);
        // Removing the deleted lines from `before` and the added ones from `after` leaves
        // the same common sequence.
        const without = (all: string[], drop: string[]) => {
          const left = [...drop];
          return all.filter((l) => {
            const i = left.indexOf(l);
            if (i === -1) return true;
            left.splice(i, 1);
            return false;
          });
        };
        assert.equal(without(before, removed).length, without(after, added).length);
        assert.equal(out.length === 0, before.join("\n") === after.join("\n"));
      }),
    );
  });
});

describe("findLines", () => {
  test("keeps matches with their ancestors, in order", () => {
    assert.deepEqual(findLines(page, "pears"), ['- list "Cart"', '  - listitem "Pears"']);
    assert.deepEqual(findLines(page, "remove"), [
      '- list "Cart"',
      '  - listitem "Apples"',
      '    - button "Remove" @3',
      '  - listitem "Pears"',
      '    - button "Remove" @4',
    ]);
    assert.deepEqual(findLines(page, "nothing"), []);
  });
});

describe("subtree", () => {
  test("returns the element and its descendants, dedented", () => {
    assert.deepEqual(subtree([...page.slice(0, 2), '  - group "Pick" @9', '    - button "A" @10', ...page.slice(2)], "@9"), [
      '- group "Pick" @9',
      '  - button "A" @10',
    ]);
  });

  test("does not confuse @3 with @30", () => {
    assert.deepEqual(subtree(['- button "X" @30', '- button "Y" @3'], "3"), ['- button "Y" @3']);
  });

  test("rejects refs that are not on the page", () => {
    assert.throws(() => subtree(page, "@99"), /not on the page/);
  });
});

describe("paginate", () => {
  test("leaves short output alone and explains how to see more", () => {
    assert.deepEqual(paginate(page, 10), page);
    assert.deepEqual(paginate(page, 0), page);
    const first = paginate(page, 3);
    assert.deepEqual(first.slice(0, 3), page.slice(0, 3));
    assert.match(first[3], /page 1 of 3 \(lines 1-3 of 7\); next: --page 2/);
    assert.match(paginate(page, 3, 3).at(-1)!, /page 3 of 3/);
  });

  test("pages cover every line exactly once", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 50 }), fc.integer({ min: 1, max: 20 }), (lines, limit) => {
        const pages = Math.max(1, Math.ceil(lines.length / limit));
        const seen = Array.from({ length: pages }, (_, i) => paginate(lines, limit, i + 1))
          .flatMap((shown) => (lines.length > limit ? shown.slice(0, -1) : shown));
        assert.deepEqual(seen, lines);
      }),
    );
  });
});

describe("viewportView", () => {
  const lines = ["banner", "  navigation Site", "    link Home @1", "main", "  heading Top", '  "Intro"', "  heading Bottom", "  button Go @2"];
  const roles = ["banner", "navigation", "link", "main", "heading", "StaticText", "heading", "button"];

  test("keeps what is on screen with its ancestors, and outlines the rest", () => {
    const positions: Position[] = [undefined, undefined, "visible", undefined, "visible", "visible", "below", "below"];
    assert.deepEqual(viewportView(lines, roles, positions), {
      shown: ["banner", "  navigation Site", "    link Home @1", "main", "  heading Top", '  "Intro"'],
      hidden: 2,
      outline: ["heading Bottom (below)"],
    });
  });

  test("lists a section once when its region is named after its heading", () => {
    const { outline } = viewportView(
      ["region History", "  heading History", '  "Text"'],
      ["region", "heading", "StaticText"],
      ["below", "below", "below"],
    );
    assert.deepEqual(outline, ["heading History (below)"]);
  });

  test("outlines named landmarks and headings above, but never lines already shown", () => {
    const positions: Position[] = [undefined, "above", "above", undefined, "above", "above", "visible", "visible"];
    const { shown, outline } = viewportView(lines, roles, positions);
    assert.deepEqual(shown, ["main", "  heading Bottom", "  button Go @2"]);
    assert.deepEqual(outline, ["navigation Site (above)", "heading Top (above)"]);
  });
});

describe("interactiveIndexes", () => {
  test("keeps refs, headings and the containers that place them", () => {
    const lines = ["banner", "  navigation Site", "    link Home @1", '    "Welcome"', "main", "  heading News", '  "Long article text"', "  form Search", "    textbox Query @2"];
    const roles = ["banner", "navigation", "link", "StaticText", "main", "heading", "StaticText", "form", "textbox"];
    assert.deepEqual(
      interactiveIndexes(lines, roles).map((i) => lines[i]),
      ["banner", "  navigation Site", "    link Home @1", "main", "  heading News", "  form Search", "    textbox Query @2"],
    );
  });
});

describe("refsByName", () => {
  const refs = {
    1: { backendNodeId: 1, label: 'button "Save"' },
    2: { backendNodeId: 2, label: 'button "Save view"' },
    3: { backendNodeId: 3, label: 'link "Save"' },
    4: { backendNodeId: 4, label: 'textbox "Search \\"docs\\""' },
  };
  test("prefers exact names, ignoring case, and filters by role", () => {
    assert.deepEqual(refsByName(refs, "save"), ["@1", "@3"]);
    assert.deepEqual(refsByName(refs, "Save", "Button"), ["@1"]);
    assert.deepEqual(refsByName(refs, "view"), ["@2"]);
  });
  test("falls back to names that contain the text, and reads quoted names", () => {
    assert.deepEqual(refsByName(refs, 'search "docs"'), ["@4"]);
    assert.deepEqual(refsByName(refs, "sav", "link"), ["@3"]);
    assert.deepEqual(refsByName(refs, "missing"), []);
  });
});
