import {
  buildCategoryTree,
  expandableKeys,
  flattenVisible,
  hasHierarchy,
} from "../categoryTree";
import type { SalesBreakdownRow } from "@/services/super-admin/reports/salesBreakdown";

/** Only the fields the tree code reads; the money columns are irrelevant here. */
function row(
  key: string,
  label: string,
  parentKey: string | null,
  netToman = 0,
): SalesBreakdownRow {
  return {
    key,
    label,
    parentKey,
    ordersCount: 0,
    units: 0,
    grossToman: 0,
    discountsToman: 0,
    refundsToman: 0,
    netToman,
  };
}

// Net-descending, the order the API actually sends — deliberately NOT tree order.
const ROWS = [
  row("1", "آرایشی", null, 900),
  row("2", "رژ لب", "1", 600),
  row("3", "ریمل", "1", 300),
  row("4", "مات", "2", 400),
];

describe("buildCategoryTree", () => {
  it("nests children under their parent regardless of the flat array's order", () => {
    const tree = buildCategoryTree(ROWS);
    expect(tree.map((n) => n.row.key)).toEqual(["1"]);
    expect(tree[0].children.map((n) => n.row.key)).toEqual(["2", "3"]);
    expect(tree[0].children[0].children.map((n) => n.row.key)).toEqual(["4"]);
  });

  it("keeps siblings in source order, so they stay net-descending for free", () => {
    const tree = buildCategoryTree([
      row("1", "والد", null, 100),
      row("3", "کم‌فروش", "1", 10),
      row("2", "پرفروش", "1", 90),
    ]);
    expect(tree[0].children.map((n) => n.row.netToman)).toEqual([10, 90]);
  });

  it("promotes a row whose parent isn't in the result set to a root", () => {
    // Happens when the parent was truncated into 'سایر' or had no sales at all.
    // Silently nesting it under a missing node would delete it from the table.
    const tree = buildCategoryTree([row("9", "یتیم", "404")]);
    expect(tree.map((n) => n.row.key)).toEqual(["9"]);
  });

  it("treats a self-parenting row as a root instead of losing it", () => {
    const tree = buildCategoryTree([row("7", "حلقه", "7")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(0);
  });

  it("keeps every input row reachable", () => {
    const count = (nodes: ReturnType<typeof buildCategoryTree>): number =>
      nodes.reduce((sum, n) => sum + 1 + count(n.children), 0);
    expect(count(buildCategoryTree(ROWS))).toBe(ROWS.length);
  });
});

describe("hasHierarchy", () => {
  it("is false for the flat dimensions, which send no parentKey at all", () => {
    expect(hasHierarchy([row("Done", "تکمیل‌شده", null)])).toBe(false);
  });

  it("is false when every parentKey dangles (no tree can be drawn)", () => {
    expect(hasHierarchy([row("9", "یتیم", "404")])).toBe(false);
  });

  it("is true once one parentKey resolves", () => {
    expect(hasHierarchy(ROWS)).toBe(true);
  });
});

describe("flattenVisible", () => {
  const tree = buildCategoryTree(ROWS);

  it("shows only roots when nothing is expanded", () => {
    const visible = flattenVisible(tree, new Set());
    expect(visible.map((r) => r.key)).toEqual(["1"]);
    expect(visible[0]).toMatchObject({ treeDepth: 0, hasChildren: true, isExpanded: false });
  });

  it("reveals one level per expanded key, not the whole subtree", () => {
    expect(flattenVisible(tree, new Set(["1"])).map((r) => r.key)).toEqual(["1", "2", "3"]);
    expect(flattenVisible(tree, new Set(["1", "2"])).map((r) => r.key)).toEqual([
      "1",
      "2",
      "4",
      "3",
    ]);
  });

  it("expanding a collapsed row's child changes nothing until the parent opens", () => {
    expect(flattenVisible(tree, new Set(["2"])).map((r) => r.key)).toEqual(["1"]);
  });

  it("reports depth for the indent and hasChildren for the disclosure", () => {
    const visible = flattenVisible(tree, new Set(["1", "2"]));
    expect(visible.map((r) => [r.key, r.treeDepth, r.hasChildren])).toEqual([
      ["1", 0, true],
      ["2", 1, true],
      ["4", 2, false],
      ["3", 1, false],
    ]);
  });
});

describe("expandableKeys", () => {
  it("lists every node that has children, at any depth", () => {
    expect(expandableKeys(buildCategoryTree(ROWS)).sort()).toEqual(["1", "2"]);
  });

  it("is empty for a flat list, so 'expand all' has nothing to do", () => {
    expect(expandableKeys(buildCategoryTree([row("1", "تنها", null)]))).toEqual([]);
  });
});
