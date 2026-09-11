import { getSalesBreakdown, SALES_BREAKDOWN_DIMENSIONS } from "../salesBreakdown";

const STUB_JOINS = {
  oiToOrder: "JOIN orders o ON true",
  oiToVariation: { join: "", idExpr: "oi.product_variation_id" },
  orderToContract: "JOIN contracts c ON true",
  contractToTx: "JOIN contract_transactions ct ON true",
  variationToProduct: "JOIN products p ON true",
  variationToStock: "LEFT JOIN product_stocks ps ON true",
  productToCategory: { join: "LEFT JOIN product_categories pc ON true", titleExpr: "pc.title" },
  categoryMembershipTables: [
    "products_product_main_category_links",
    "products_product_other_categories_links",
  ],
  orderToShipping: "LEFT JOIN shippings s ON true",
  orderToUser: "LEFT JOIN users u ON true",
  userToInfo: "LEFT JOIN local_user_infos ui ON true",
  orderToAddress: "LEFT JOIN local_user_addresses a ON true",
  addressToCity: "LEFT JOIN shipping_cities sc ON true",
  cityToProvince: "LEFT JOIN shipping_provinces sp ON true",
  categoryParentLink: null,
} as any;

/** STUB_JOINS with the category `parent` self-relation resolved, for tree tests. */
const TREE_JOINS = {
  ...STUB_JOINS,
  categoryParentLink: {
    table: "product_categories_parent_links",
    childCol: "product_category_id",
    parentCol: "inv_product_category_id",
  },
} as any;

/**
 * `calls[0]` is always the paid-orders settlement probe
 * (`PA.resolvePaidOrdersDefinition`), so the dimension's own query is `calls[1]`.
 * The probe answers "yes" by default, keeping the `settled` definition in play.
 */
function fakeKnex(rows: any[], hasSettlement = true) {
  const calls: Array<{ sql: string; bindings: any[] }> = [];
  const raw = jest.fn(async (sql: string, bindings: any[] = []) => {
    calls.push({ sql, bindings });
    if (sql.includes("has_settlement")) return { rows: [{ has_settlement: hasSettlement }] };
    return { rows };
  });
  return { knex: { raw }, calls };
}

const start = new Date("2026-05-01T00:00:00Z");
const end = new Date("2026-05-31T23:59:59Z");

describe("getSalesBreakdown", () => {
  it("lists exactly the 5 net-new parity dimensions (date/product/variation/gateway are reused elsewhere)", () => {
    expect(SALES_BREAKDOWN_DIMENSIONS).toEqual(["status", "category", "customer", "coupon", "geography"]);
  });

  it("status: groups ALL orders (not just eligible ones) and binds the window to each CTE", async () => {
    const { knex, calls } = fakeKnex([
      { status: "Done", orders_count: "3", units: "5", gross: "1500000", discounts: "0", refund_irr: "0" },
      { status: "Cancelled", orders_count: "2", units: "0", gross: "0", discounts: "0", refund_irr: "0" },
    ]);

    const result = await getSalesBreakdown(knex, STUB_JOINS, "status", start, end);

    // Three windowed CTEs: line totals, refunds, and the outer order scan.
    expect(calls[1].bindings).toEqual([start, end, start, end, start, end]);
    // Money for every status comes from the orders' own items, NOT from paid_orders —
    // otherwise a cancelled order reads as 0 تومان instead of showing what was lost.
    expect(calls[1].sql).not.toContain("paid_orders");
    expect(result.rows).toEqual([
      {
        key: "Done",
        label: "تکمیل‌شده",
        ordersCount: 3,
        units: 5,
        grossToman: 1500000,
        discountsToman: 0,
        refundsToman: 0,
        netToman: 1500000,
      },
      {
        key: "Cancelled",
        label: "لغوشده",
        ordersCount: 2,
        units: 0,
        grossToman: 0,
        discountsToman: 0,
        refundsToman: 0,
        netToman: 0,
      },
    ]);
  });

  it("status: falls back to the raw status string when no Persian label is known", async () => {
    const { knex } = fakeKnex([
      { status: "Weird", orders_count: "1", units: "1", gross: "100", discounts: "0", refund_irr: "0" },
    ]);
    const result = await getSalesBreakdown(knex, STUB_JOINS, "status", start, end);
    expect(result.rows[0].label).toBe("Weird");
  });

  it("category: labels an unlinked category as 'بدون دسته‌بندی' and binds [start,end]", async () => {
    const { knex, calls } = fakeKnex([
      { category_id: null, category_title: null, units: "2", gross: "200000", discounts: "0", refund_irr: "0", orders_count: "1" },
    ]);
    const result = await getSalesBreakdown(knex, STUB_JOINS, "category", start, end);
    expect(calls[1].bindings).toEqual([start, end]);
    expect(result.rows[0].label).toBe("بدون دسته‌بندی");
    expect(result.rows[0].key).toBe("");
  });

  it("category: falls back to a FLAT list (never throws) when the parent relation is unresolved", async () => {
    const { knex, calls } = fakeKnex([
      { category_id: "4", category_title: "رژ لب", units: "2", gross: "200000", discounts: "0", refund_irr: "0", orders_count: "1" },
    ]);
    const result = await getSalesBreakdown(knex, STUB_JOINS, "category", start, end);
    expect(calls[1].sql).not.toContain("RECURSIVE");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ key: "4", parentKey: null, depth: 0 });
  });

  it("category: rolls subtree totals up to the parent and keeps distinct orders correct", async () => {
    // One order (#100) bought from BOTH children. The parent's orders_count is
    // therefore 1, not 2 — this is the whole reason the rollup lives in SQL.
    const { knex, calls } = fakeKnex([
      {
        category_id: "1", category_title: "آرایشی", parent_id: null, depth: 0,
        orders_count: "1", units: "3", gross: "900000", discounts: "0", refund_irr: "0",
        direct_orders_count: null, direct_units: null, direct_gross: null,
        direct_discounts: null, direct_refund_irr: null,
      },
      {
        category_id: "2", category_title: "رژ لب", parent_id: "1", depth: 1,
        orders_count: "1", units: "2", gross: "600000", discounts: "0", refund_irr: "0",
        direct_orders_count: "1", direct_units: "2", direct_gross: "600000",
        direct_discounts: "0", direct_refund_irr: "0",
      },
      {
        category_id: "3", category_title: "ریمل", parent_id: "1", depth: 1,
        orders_count: "1", units: "1", gross: "300000", discounts: "0", refund_irr: "0",
        direct_orders_count: "1", direct_units: "1", direct_gross: "300000",
        direct_discounts: "0", direct_refund_irr: "0",
      },
    ]);

    const result = await getSalesBreakdown(knex, TREE_JOINS, "category", start, end);

    expect(calls[1].sql).toContain("WITH RECURSIVE");
    expect(calls[1].bindings).toEqual([start, end]);

    const byKey = Object.fromEntries(result.rows.map((r) => [r.key, r]));
    expect(byKey["1"]).toMatchObject({ parentKey: null, depth: 0, ordersCount: 1, netToman: 900000 });
    expect(byKey["2"]).toMatchObject({ parentKey: "1", depth: 1, netToman: 600000 });
    expect(byKey["3"]).toMatchObject({ parentKey: "1", depth: 1, netToman: 300000 });
    // Children's net sums to the parent's; their order counts do NOT (same order).
    expect(byKey["2"].netToman + byKey["3"].netToman).toBe(byKey["1"].netToman);
    expect(byKey["2"].ordersCount + byKey["3"].ordersCount).not.toBe(byKey["1"].ordersCount);
    // The parent has no direct sales of its own, so no synthetic "(مستقیم)" row.
    expect(result.rows.some((r) => r.key.endsWith(":__self__"))).toBe(false);
    // Flat array is globally net-desc so the ranked chart above the table still
    // means "highest net first"; the client rebuilds the tree from parentKey.
    expect(result.rows.map((r) => r.key)).toEqual(["1", "2", "3"]);
  });

  it("category: emits a self-describing '(مستقیم)' child when a parent also sells directly", async () => {
    const { knex } = fakeKnex([
      {
        category_id: "1", category_title: "آرایشی", parent_id: null, depth: 0,
        orders_count: "2", units: "3", gross: "900000", discounts: "0", refund_irr: "0",
        direct_orders_count: "1", direct_units: "1", direct_gross: "300000",
        direct_discounts: "0", direct_refund_irr: "0",
      },
      {
        category_id: "2", category_title: "رژ لب", parent_id: "1", depth: 1,
        orders_count: "1", units: "2", gross: "600000", discounts: "0", refund_irr: "0",
        direct_orders_count: "1", direct_units: "2", direct_gross: "600000",
        direct_discounts: "0", direct_refund_irr: "0",
      },
    ]);
    const result = await getSalesBreakdown(knex, TREE_JOINS, "category", start, end);
    const self = result.rows.find((r) => r.key === "1:__self__");
    // Named after its category, because this row can surface in the ranked chart
    // and the XLSX export where a bare "directly here" identifies nothing.
    expect(self).toMatchObject({
      label: "آرایشی (مستقیم)",
      parentKey: "1",
      depth: 1,
      netToman: 300000,
    });
    // Leaf categories never get one.
    expect(result.rows.some((r) => r.key === "2:__self__")).toBe(false);
  });

  it("category: an uncategorized bucket stays a root and keeps its label", async () => {
    const { knex } = fakeKnex([
      {
        category_id: null, category_title: null, parent_id: null, depth: 0,
        orders_count: "1", units: "1", gross: "50000", discounts: "0", refund_irr: "0",
        direct_orders_count: null, direct_units: null, direct_gross: null,
        direct_discounts: null, direct_refund_irr: null,
      },
    ]);
    const result = await getSalesBreakdown(knex, TREE_JOINS, "category", start, end);
    expect(result.rows[0]).toMatchObject({ key: "", label: "بدون دسته‌بندی", parentKey: null });
  });

  it("category: a row whose parent has no row of its own is treated as a root, never dropped", async () => {
    const { knex } = fakeKnex([
      {
        category_id: "9", category_title: "یتیم", parent_id: "404", depth: 1,
        orders_count: "1", units: "1", gross: "70000", discounts: "0", refund_irr: "0",
        direct_orders_count: "1", direct_units: "1", direct_gross: "70000",
        direct_discounts: "0", direct_refund_irr: "0",
      },
    ]);
    const result = await getSalesBreakdown(knex, TREE_JOINS, "category", start, end);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ key: "9", parentKey: "404" });
  });

  /**
   * The under-reporting incident: category revenue was assigned through the MAIN
   * category link only, so every product filed under a category via
   * `product_other_categories` contributed nothing to it. These assert the shape of
   * the SQL, which is where the defect lived; the arithmetic is proven against a
   * real database in salesBreakdown.int.spec.ts.
   */
  describe("category: membership is main + other categories", () => {
    const categoryRow = {
      category_id: "1", category_title: "شال", parent_id: null, depth: 0,
      orders_count: "1", units: "1", gross: "1000", discounts: "0", refund_irr: "0",
      direct_orders_count: "1", direct_units: "1", direct_gross: "1000",
      direct_discounts: "0", direct_refund_irr: "0",
    };

    it("unions every membership link table, so 'other' categories are not dropped", async () => {
      const { knex, calls } = fakeKnex([categoryRow]);
      await getSalesBreakdown(knex, TREE_JOINS, "category", start, end);

      const sql = calls[1].sql;
      expect(sql).toContain("products_product_main_category_links");
      expect(sql).toContain("products_product_other_categories_links");
      // UNION (never UNION ALL) is what collapses a product filed under one category
      // through both relations into a single membership row.
      expect(sql).toMatch(/product_category_membership AS \([\s\S]*?UNION(?!\s+ALL)/);
    });

    it("de-duplicates (product, ancestor) so multiple paths to one category count once", async () => {
      const { knex, calls } = fakeKnex([categoryRow]);
      await getSalesBreakdown(knex, TREE_JOINS, "category", start, end);

      expect(calls[1].sql).toMatch(
        /product_ancestors AS \(\s*SELECT DISTINCT m\.product_id, a\.ancestor_id/,
      );
    });

    it("never joins lines straight to the label category, which is main-only", async () => {
      const { knex, calls } = fakeKnex([categoryRow]);
      await getSalesBreakdown(knex, TREE_JOINS, "category", start, end);

      // `lines` resolves to a PRODUCT; attaching categories there would multiply the
      // line's money once per category the product belongs to.
      const linesCte = calls[1].sql.slice(
        calls[1].sql.indexOf("lines AS ("),
        calls[1].sql.indexOf("category_ancestry AS ("),
      );
      expect(linesCte).toContain("p.id AS product_id");
      expect(linesCte).not.toContain("product_categories");
      expect(linesCte).not.toContain("category_id");
    });

    it("falls back to the flat query, and SAYS SO, when no membership table resolves", async () => {
      const { knex, calls } = fakeKnex([
        { category_id: "1", category_title: "شال", orders_count: "1", units: "1", gross: "1000", discounts: "0", refund_irr: "0" },
      ]);
      const joins = { ...TREE_JOINS, categoryMembershipTables: [] };

      const result = await getSalesBreakdown(knex, joins, "category", start, end);

      expect(calls[1].sql).not.toContain("WITH RECURSIVE");
      expect(result.rows[0]).toMatchObject({ key: "1", parentKey: null, depth: 0 });
      // Silent degradation is the failure mode that hid the original defect.
      expect(result.warnings).toEqual([
        expect.objectContaining({ code: "CATEGORY_MEMBERSHIP_UNAVAILABLE" }),
      ]);
    });

    it("reports a lost hierarchy separately from lost membership", async () => {
      const { knex } = fakeKnex([
        { category_id: "1", category_title: "شال", orders_count: "1", units: "1", gross: "1000", discounts: "0", refund_irr: "0" },
      ]);
      const joins = { ...TREE_JOINS, categoryParentLink: null };

      const result = await getSalesBreakdown(knex, joins, "category", start, end);

      expect(result.warnings).toEqual([
        expect.objectContaining({ code: "CATEGORY_HIERARCHY_UNAVAILABLE" }),
      ]);
    });

    it("reports no warnings on a full-fidelity run", async () => {
      const { knex } = fakeKnex([categoryRow]);
      const result = await getSalesBreakdown(knex, TREE_JOINS, "category", start, end);
      expect(result.warnings).toEqual([]);
    });
  });

  it("falls back to the 'completed' definition when the window holds no settlement", async () => {
    const { knex } = fakeKnex(
      [{ status: "Done", orders_count: "1", units: "1", gross: "100", discounts: "0", refund_irr: "0" }],
      false,
    );
    const result = await getSalesBreakdown(knex, STUB_JOINS, "status", start, end);
    expect(result.ordersDefinition).toBe("completed");
  });

  it("resolves the paid-orders definition at most once per request", async () => {
    const { knex, calls } = fakeKnex([]);
    await getSalesBreakdown(knex, STUB_JOINS, "status", start, end);
    expect(calls.filter((c) => c.sql.includes("has_settlement"))).toHaveLength(1);
  });

  it("customer: buckets user_id 0 as 'مهمان' (guest)", async () => {
    const { knex } = fakeKnex([
      {
        user_id: "0",
        display_name: null,
        phone: null,
        orders_count: "1",
        units: "1",
        gross: "50000",
        discounts: "0",
        refund_irr: "0",
      },
      {
        user_id: "7",
        display_name: "علی رضایی",
        phone: "09120000000",
        orders_count: "2",
        units: "3",
        gross: "300000",
        discounts: "10000",
        refund_irr: "0",
      },
    ]);
    const result = await getSalesBreakdown(knex, STUB_JOINS, "customer", start, end);
    expect(result.rows[0].label).toBe("علی رضایی"); // sorted by net desc
    expect(result.rows[1]).toMatchObject({ key: "0", label: "مهمان" });
  });

  it("customer: returns an empty (never throwing) result when orderToUser could not be resolved", async () => {
    const { knex, calls } = fakeKnex([]);
    const result = await getSalesBreakdown(knex, { ...STUB_JOINS, orderToUser: "" }, "customer", start, end);
    expect(result).toEqual({ dimension: "customer", rows: [], truncated: false, ordersDefinition: "settled", warnings: [] });
    expect(calls.length).toBe(0);
  });

  it("coupon: buckets an empty discount_code as 'بدون کد تخفیف'", async () => {
    const { knex } = fakeKnex([
      { coupon_code: "", orders_count: "4", units: "6", gross: "400000", discounts: "0", refund_irr: "0" },
      { coupon_code: "SUMMER10", orders_count: "1", units: "1", gross: "100000", discounts: "10000", refund_irr: "0" },
    ]);
    const result = await getSalesBreakdown(knex, STUB_JOINS, "coupon", start, end);
    const noCoupon = result.rows.find((r) => r.key === "");
    expect(noCoupon?.label).toBe("بدون کد تخفیف");
    const summer = result.rows.find((r) => r.key === "SUMMER10");
    expect(summer?.label).toBe("SUMMER10");
  });

  it("geography: buckets an unresolved province as 'نامشخص' (never silently dropped)", async () => {
    const { knex } = fakeKnex([
      { province_title: "", orders_count: "1", units: "1", gross: "50000", discounts: "0", refund_irr: "0" },
      { province_title: "تهران", orders_count: "9", units: "20", gross: "2000000", discounts: "0", refund_irr: "0" },
    ]);
    const result = await getSalesBreakdown(knex, STUB_JOINS, "geography", start, end);
    const unmapped = result.rows.find((r) => r.key === "");
    expect(unmapped?.label).toBe("نامشخص");
    const tehran = result.rows.find((r) => r.key === "تهران");
    expect(tehran?.ordersCount).toBe(9);
  });

  it("geography: returns an empty result when the address/city/province join chain is unresolved", async () => {
    const { knex, calls } = fakeKnex([]);
    const result = await getSalesBreakdown(
      knex,
      { ...STUB_JOINS, orderToAddress: "" },
      "geography",
      start,
      end,
    );
    expect(result).toEqual({ dimension: "geography", rows: [], truncated: false, ordersDefinition: "settled", warnings: [] });
    expect(calls.length).toBe(0);
  });

  it("converts refund_irr to Toman and computes net = gross - discounts - refunds", async () => {
    const { knex } = fakeKnex([
      { coupon_code: "X", orders_count: "1", units: "1", gross: "1000000", discounts: "100000", refund_irr: "2000000" },
    ]);
    const result = await getSalesBreakdown(knex, STUB_JOINS, "coupon", start, end);
    // refund_irr 2,000,000 IRR -> 200,000 Toman
    expect(result.rows[0]).toMatchObject({
      grossToman: 1000000,
      discountsToman: 100000,
      refundsToman: 200000,
      netToman: 700000,
    });
  });

  it("truncates past MAX_BREAKDOWN_ROWS into a single 'other' row, sorted by net descending", async () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({
      coupon_code: `CODE${i}`,
      orders_count: "1",
      units: "1",
      gross: String((205 - i) * 1000), // descending net so index order == rank order
      discounts: "0",
      refund_irr: "0",
    }));
    const { knex } = fakeKnex(rows);
    const result = await getSalesBreakdown(knex, STUB_JOINS, "coupon", start, end);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(200);
    expect(result.rows[199].key).toBe("__other__");
    expect(result.rows[199].label).toBe("سایر کدهای تخفیف");
    // the "other" bucket absorbs exactly the 6 lowest-net rows (indices 199..204, 0-based)
    const absorbed = rows.slice(199).reduce((sum, r) => sum + Number(r.gross), 0);
    expect(result.rows[199].grossToman).toBe(absorbed);
  });
});
