import { buildJourneyFlow, type JourneyRow } from "../journeyFlow";

const identityLabel = (raw: unknown) => String(raw ?? "");

const EVENT_LABELS: Record<string, string> = {
  view_item: "مشاهده محصول",
  add_to_cart: "افزودن به سبد خرید",
  add_to_wishlist: "افزودن به علاقه‌مندی‌ها",
  login: "ورود به حساب",
  refund: "بازپرداخت",
  refund_irr: "بازپرداخت",
  begin_checkout: "شروع ثبت سفارش",
  purchase: "خرید موفق",
};
const eventLabel = (raw: unknown) => EVENT_LABELS[String(raw ?? "")] ?? String(raw ?? "");

function assertInvariants(result: ReturnType<typeof buildJourneyFlow>) {
  for (const link of result.links) {
    const source = result.nodes[link.source];
    const target = result.nodes[link.target];
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    expect(target.depth).toBe(source.depth + 1);
    expect(link.value).toBeGreaterThan(0);
  }

  const incomingByIndex = new Map<number, number>();
  const outgoingByIndex = new Map<number, number>();
  for (const link of result.links) {
    outgoingByIndex.set(link.source, (outgoingByIndex.get(link.source) ?? 0) + link.value);
    incomingByIndex.set(link.target, (incomingByIndex.get(link.target) ?? 0) + link.value);
  }
  result.nodes.forEach((node, index) => {
    const incoming = incomingByIndex.get(index) ?? 0;
    const outgoing = outgoingByIndex.get(index) ?? 0;
    if (node.depth === 0) {
      // Roots have no incoming links by construction.
      expect(incoming).toBe(0);
      expect(outgoing).toBeGreaterThan(0);
      return;
    }
    if (node.isTerminal || node.isOverflow) {
      // Terminal/overflow nodes are dead ends: never any outgoing links.
      expect(outgoing).toBe(0);
      expect(incoming).toBeGreaterThan(0);
      return;
    }
    if (node.depth === 3) {
      // The last representable column (e4) has no terminal edge by design —
      // a maxed-out path is right-censored, not necessarily a true dead end.
      expect(outgoing).toBe(0);
      expect(incoming).toBeGreaterThan(0);
      return;
    }
    // Every other interior node (depth 0-2) always continues to a real next
    // step or a terminal node, so flow is conserved exactly.
    expect(outgoing).toBe(incoming);
  });
}

describe("buildJourneyFlow", () => {
  it("returns an empty graph for no rows", () => {
    const result = buildJourneyFlow([], { label: identityLabel });
    expect(result).toEqual({ nodes: [], links: [], totalPaths: 0, truncatedAtCap: false });
  });

  it("ignores rows with no first step", () => {
    const rows: JourneyRow[] = [{ e1: undefined, count: 5 }, { e1: "", count: 3 }];
    const result = buildJourneyFlow(rows, { label: identityLabel });
    expect(result.nodes).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.totalPaths).toBe(0);
  });

  it("adds a terminal node for a path shorter than 4 steps", () => {
    const rows: JourneyRow[] = [{ e1: "view_item", e2: "add_to_cart", count: 10 }];
    const result = buildJourneyFlow(rows, { label: eventLabel });

    expect(result.truncatedAtCap).toBe(false);
    expect(result.totalPaths).toBe(10);

    const labelsByDepth = result.nodes.map((n) => `${n.depth}:${n.label}`);
    expect(labelsByDepth).toEqual([
      "0:مشاهده محصول",
      "1:افزودن به سبد خرید",
      "2:پایان مسیر",
    ]);
    expect(result.links).toHaveLength(2);
    assertInvariants(result);
  });

  it("does not add a terminal node when all 4 steps are populated, and flags the cap", () => {
    const rows: JourneyRow[] = [
      { e1: "view_item", e2: "add_to_cart", e3: "begin_checkout", e4: "purchase", count: 4 },
    ];
    const result = buildJourneyFlow(rows, { label: eventLabel });

    expect(result.truncatedAtCap).toBe(true);
    expect(result.nodes.some((n) => n.isTerminal)).toBe(false);
    expect(result.nodes).toHaveLength(4);
    assertInvariants(result);
  });

  it("merges raw values that share a display label at the same depth", () => {
    const rows: JourneyRow[] = [
      { e1: "refund", count: 3 },
      { e1: "refund_irr", count: 2 },
    ];
    const result = buildJourneyFlow(rows, { label: eventLabel });

    const refundNodes = result.nodes.filter((n) => n.label === "بازپرداخت");
    expect(refundNodes).toHaveLength(1);
    expect(refundNodes[0].rawValues.sort()).toEqual(["refund", "refund_irr"]);
    // Both rows terminate immediately after e1, so their counts merge onto
    // the shared node's single outgoing link into "پایان مسیر".
    expect(result.links).toHaveLength(1);
    expect(result.links[0].value).toBe(5);
  });

  it("keeps the same label at two different depths as two distinct nodes", () => {
    const rows: JourneyRow[] = [
      { e1: "view_item", e2: "view_item", count: 1 },
    ];
    const result = buildJourneyFlow(rows, { label: eventLabel });
    const viewNodes = result.nodes.filter((n) => n.label === "مشاهده محصول");
    expect(viewNodes).toHaveLength(2);
    expect(viewNodes.map((n) => n.depth).sort()).toEqual([0, 1]);
  });

  it("buckets long-tail branches into a single سایر node, keeping the top N by value", () => {
    const rows: JourneyRow[] = Array.from({ length: 10 }, (_, index) => ({
      e1: "view_item",
      e2: `step_${index}`,
      count: 10 - index, // distinct, descending values: 10..1
    }));
    const result = buildJourneyFlow(rows, { label: identityLabel, topNPerNode: 6 });

    const depth1 = result.nodes.filter((n) => n.depth === 1);
    const overflow = depth1.filter((n) => n.isOverflow);
    const regular = depth1.filter((n) => !n.isOverflow && !n.isTerminal);
    expect(overflow).toHaveLength(1);
    expect(regular).toHaveLength(6);

    // Kept: values 10,9,8,7,6,5 (top 6). Bucketed: 4+3+2+1 = 10.
    const overflowLink = result.links.find((l) => result.nodes[l.target].isOverflow);
    expect(overflowLink?.value).toBe(10);
    assertInvariants(result);
  });

  it("never buckets away a terminal (abandonment) link, even when it ranks low", () => {
    const rows: JourneyRow[] = [
      // A short path that ends immediately — small volume, must stay visible.
      { e1: "view_item", count: 1 },
      // Nine larger branches from the same source, forcing bucketing
      // (overflow set size 9-6=3, safely above the "skip if only 1" floor).
      ...Array.from({ length: 9 }, (_, index) => ({
        e1: "view_item",
        e2: `branch_${index}`,
        count: 50,
      })),
    ];
    const result = buildJourneyFlow(rows, { label: identityLabel, topNPerNode: 6 });

    const terminalNode = result.nodes.find((n) => n.isTerminal);
    expect(terminalNode).toBeDefined();
    const terminalLink = result.links.find((l) => result.nodes[l.target].isTerminal);
    expect(terminalLink?.value).toBe(1);

    const overflow = result.nodes.filter((n) => n.isOverflow);
    expect(overflow).toHaveLength(1);
    assertInvariants(result);
  });

  it("does not bucket when exactly one item exceeds the cap (no compression benefit)", () => {
    // 3-step rows so each branch continues to its own unique depth-2 leaf
    // instead of every branch also generating its own terminal edge — keeps
    // this assertion focused on the source node's own outgoing link count.
    const rows: JourneyRow[] = Array.from({ length: 7 }, (_, index) => ({
      e1: "view_item",
      e2: `branch_${index}`,
      e3: `leaf_${index}`,
      count: 1,
    }));
    const result = buildJourneyFlow(rows, { label: identityLabel, topNPerNode: 6 });
    expect(result.nodes.some((n) => n.isOverflow)).toBe(false);
    const viewItemIndex = result.nodes.findIndex((n) => n.label === "view_item");
    const outgoingFromViewItem = result.links.filter((l) => l.source === viewItemIndex);
    expect(outgoingFromViewItem).toHaveLength(7);
  });
});
