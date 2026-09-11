import {
  periodDelta,
  allocate,
  classifyStock,
  daysOfCover,
  windowDays,
  previousPeriod,
  autoGrouping,
  normalizeGrouping,
  normalizeSort,
  clampPageSize,
  clampPage,
  irrToToman,
  fillTrendSeries,
  serializeProductRow,
  gatewayLabelFa,
  withShares,
  gatewayBreakdownQuery,
  gatewaySettlementWarnings,
  shippingBreakdownQuery,
  paidOrdersCte,
  categoryMembershipCte,
  categoryFilterSql,
  ELIGIBLE_ORDER_STATUS,
  PERFORMANCE_SORT_COLUMNS,
  MAX_PAGE_SIZE,
  type ResolvedJoins,
} from "../product-analytics";

describe("product-analytics pure helpers", () => {
  describe("periodDelta", () => {
    it("computes absolute and percentage change", () => {
      expect(periodDelta(150, 100)).toEqual({
        current: 150,
        previous: 100,
        change: 50,
        changePct: 50,
      });
    });

    it("returns null percentage when the baseline is zero (zero-period safe)", () => {
      const d = periodDelta(120, 0);
      expect(d.change).toBe(120);
      expect(d.changePct).toBeNull();
    });

    it("handles both-zero", () => {
      expect(periodDelta(0, 0)).toEqual({
        current: 0,
        previous: 0,
        change: 0,
        changePct: null,
      });
    });

    it("supports negative change", () => {
      expect(periodDelta(80, 100).changePct).toBe(-20);
    });
  });

  describe("allocate", () => {
    it("pro-rates by line share of order gross", () => {
      // order gross 1000, line 250 (25%), amount 200 -> 50
      expect(allocate(250, 1000, 200)).toBe(50);
    });

    it("returns 0 when order gross is non-positive (no divide-by-zero)", () => {
      expect(allocate(100, 0, 200)).toBe(0);
    });

    it("returns 0 for a zero-amount or zero-line", () => {
      expect(allocate(0, 1000, 200)).toBe(0);
      expect(allocate(100, 1000, 0)).toBe(0);
    });
  });

  describe("classifyStock", () => {
    it("classifies out / low / in around the threshold", () => {
      expect(classifyStock(0, 5)).toBe("out");
      expect(classifyStock(-3, 5)).toBe("out");
      expect(classifyStock(3, 5)).toBe("low");
      expect(classifyStock(5, 5)).toBe("low");
      expect(classifyStock(6, 5)).toBe("in");
    });
  });

  describe("daysOfCover", () => {
    it("estimates remaining days at current velocity", () => {
      // 30 units over 30 days = 1/day; 10 stock -> 10 days
      expect(daysOfCover(10, 30, 30)).toBe(10);
    });
    it("returns null when nothing sold in window", () => {
      expect(daysOfCover(10, 0, 30)).toBeNull();
    });
  });

  describe("windowDays / previousPeriod", () => {
    it("counts inclusive days and never less than 1", () => {
      const a = new Date("2026-01-01T00:00:00Z");
      const b = new Date("2026-01-08T00:00:00Z");
      expect(windowDays(a, b)).toBe(7);
      expect(windowDays(a, a)).toBe(1);
    });
    it("returns an equal-length preceding window", () => {
      const start = new Date("2026-01-08T00:00:00Z");
      const end = new Date("2026-01-15T00:00:00Z");
      const prev = previousPeriod(start, end);
      expect(prev.end.getTime()).toBe(start.getTime());
      expect(end.getTime() - start.getTime()).toBe(prev.end.getTime() - prev.start.getTime());
    });
  });

  describe("autoGrouping / normalizeGrouping", () => {
    const day = (n: number) => new Date(2026, 0, 1 + n);
    it("picks day/week/month by range length", () => {
      expect(autoGrouping(day(0), day(10))).toBe("day");
      expect(autoGrouping(day(0), day(120))).toBe("week");
      expect(autoGrouping(day(0), day(300))).toBe("month");
    });
    it("respects an explicit valid grouping and falls back to auto otherwise", () => {
      expect(normalizeGrouping("month", day(0), day(10))).toBe("month");
      expect(normalizeGrouping("nonsense", day(0), day(10))).toBe("day");
    });
  });

  describe("normalizeSort", () => {
    it("maps allow-listed keys and direction", () => {
      expect(normalizeSort("units:asc")).toEqual({
        column: PERFORMANCE_SORT_COLUMNS.units,
        direction: "asc",
      });
    });
    it("rejects unknown sort fields, defaulting to gross desc (anti-injection)", () => {
      expect(normalizeSort("__proto__; DROP TABLE orders;--:asc")).toEqual({
        column: PERFORMANCE_SORT_COLUMNS.gross,
        direction: "asc",
      });
      expect(normalizeSort(undefined)).toEqual({
        column: PERFORMANCE_SORT_COLUMNS.gross,
        direction: "desc",
      });
    });
  });

  describe("clampPageSize / clampPage", () => {
    it("clamps page size to the max and defaults invalid input", () => {
      expect(clampPageSize(10)).toBe(10);
      expect(clampPageSize(99999)).toBe(MAX_PAGE_SIZE);
      expect(clampPageSize("abc", 25)).toBe(25);
      expect(clampPageSize(0, 25)).toBe(25);
    });
    it("clamps page to >= 1", () => {
      expect(clampPage(3)).toBe(3);
      expect(clampPage(0)).toBe(1);
      expect(clampPage("abc")).toBe(1);
    });
  });

  describe("irrToToman", () => {
    it("divides IRR by 10", () => {
      expect(irrToToman(2400000)).toBe(240000);
      expect(irrToToman(null)).toBe(0);
    });
  });

  describe("serializeProductRow", () => {
    it("computes net (gross - discount - refund/10), avg price and stock status", () => {
      const row = serializeProductRow(
        {
          product_variation_id: 7,
          product_id: 3,
          product_title: "کفش",
          product_sku: "SKU-1",
          product_type: "Variable",
          category_title: "کفش‌ها",
          units: 4,
          gross: 1_000_000,
          discounts: 50_000,
          refunds_irr: 2_400_000, // -> 240,000 toman
          orders_count: 3,
          current_stock: 2,
          reserved_stock: 1,
        },
        5,
      );
      expect(row.units).toBe(4);
      expect(row.gross).toBe(1_000_000);
      expect(row.discounts).toBe(50_000);
      expect(row.refunds).toBe(240_000);
      expect(row.net).toBe(710_000);
      expect(row.avgPrice).toBe(250_000);
      expect(row.ordersCount).toBe(3);
      expect(row.currentStock).toBe(2);
      expect(row.stockStatus).toBe("low");
    });

    it("marks stock unknown for deleted variations (null stock)", () => {
      const row = serializeProductRow({
        product_variation_id: null,
        product_id: null,
        product_title: "حذف‌شده",
        product_sku: "OLD-SKU",
        product_type: null,
        category_title: null,
        units: 2,
        gross: 100_000,
        discounts: 0,
        refunds_irr: 0,
        orders_count: 1,
        current_stock: null,
        reserved_stock: null,
      });
      expect(row.currentStock).toBeNull();
      expect(row.stockStatus).toBe("unknown");
      expect(row.net).toBe(100_000);
    });

    it("never returns a negative net", () => {
      const row = serializeProductRow({
        product_variation_id: 1,
        product_id: 1,
        product_title: "x",
        product_sku: "x",
        product_type: "Simple",
        category_title: null,
        units: 1,
        gross: 100_000,
        discounts: 0,
        refunds_irr: 2_000_000, // 200,000 toman refund > gross
        orders_count: 1,
        current_stock: 10,
        reserved_stock: 0,
      });
      expect(row.net).toBe(0);
    });
  });

  describe("gatewayLabelFa", () => {
    it("maps known enum values to Persian labels", () => {
      expect(gatewayLabelFa("Mellat")).toBe("ملت");
      expect(gatewayLabelFa("ZarinPal")).toBe("زرین‌پال");
      expect(gatewayLabelFa("Wallet")).toBe("کیف پول");
      expect(gatewayLabelFa("SnappPay")).toBe("اسنپ‌پی");
      expect(gatewayLabelFa("SamanKish")).toBe("سامان");
    });

    it("groups null / empty / Unknown under نامشخص", () => {
      expect(gatewayLabelFa(null)).toBe("نامشخص");
      expect(gatewayLabelFa(undefined)).toBe("نامشخص");
      expect(gatewayLabelFa("")).toBe("نامشخص");
      expect(gatewayLabelFa("Unknown")).toBe("نامشخص");
    });

    it("falls back to the raw value for an unrecognised gateway", () => {
      expect(gatewayLabelFa("NewGateway")).toBe("NewGateway");
    });
  });

  describe("withShares", () => {
    it("annotates each row with its percentage share of the keyed total", () => {
      const rows = withShares([{ total: 75 }, { total: 25 }], "total");
      expect(rows[0].sharePct).toBe(75);
      expect(rows[1].sharePct).toBe(25);
    });

    it("returns null share when the total is zero (no divide-by-zero)", () => {
      const rows = withShares([{ total: 0 }, { total: 0 }], "total");
      expect(rows[0].sharePct).toBeNull();
      expect(rows[1].sharePct).toBeNull();
    });

    it("rounds shares to two decimals", () => {
      const rows = withShares([{ total: 1 }, { total: 2 }], "total");
      expect(rows[0].sharePct).toBe(33.33);
      expect(rows[1].sharePct).toBe(66.67);
    });
  });

  describe("gatewaySettlementWarnings", () => {
    const row = (over: Partial<Parameters<typeof gatewaySettlementWarnings>[0][0]>) => ({
      gateway: "Mellat",
      label: "بانک ملت",
      ordersCount: 0,
      totalOrdersCount: 0,
      total: 0,
      ...over,
    });

    it("flags a gateway that has orders but settled none of them", () => {
      // This is the Mellat failure: orders existed, no contract_transaction was
      // ever written as Success, so every report read zero without saying so.
      const warnings = gatewaySettlementWarnings([
        row({ ordersCount: 0, totalOrdersCount: 412 }),
      ]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        code: "GATEWAY_NO_SETTLED_ORDERS",
        gateway: "Mellat",
        ordersCount: 412,
      });
      expect(warnings[0].message).toContain("بانک ملت");
    });

    it("stays silent for a gateway that settled at least one order", () => {
      expect(
        gatewaySettlementWarnings([
          row({ ordersCount: 5, totalOrdersCount: 9, total: 500_000 }),
        ]),
      ).toEqual([]);
    });

    it("stays silent for a gateway nobody used", () => {
      expect(
        gatewaySettlementWarnings([row({ ordersCount: 0, totalOrdersCount: 0 })]),
      ).toEqual([]);
    });

    it("reports every affected gateway", () => {
      const warnings = gatewaySettlementWarnings([
        row({ gateway: "Mellat", ordersCount: 0, totalOrdersCount: 10 }),
        row({ gateway: "SnappPay", label: "اسنپ‌پی", ordersCount: 3, totalOrdersCount: 4 }),
        row({ gateway: "ZarinPal", label: "زرین‌پال", ordersCount: 0, totalOrdersCount: 7 }),
      ]);
      expect(warnings.map((w) => w.gateway)).toEqual(["Mellat", "ZarinPal"]);
    });

    it("tolerates an empty result set", () => {
      expect(gatewaySettlementWarnings([])).toEqual([]);
    });
  });

  describe("breakdown query builders", () => {
    // Minimal joins stub — the breakdown queries only read orderToContract /
    // contractToTx (via paidOrdersCte) and orderToShipping.
    const joins = {
      orderToContract: "JOIN contracts c ON c.order_id = o.id",
      contractToTx: "JOIN contract_transactions ct ON ct.contract_id = c.id",
      orderToShipping: "LEFT JOIN shippings s ON s.id = o.shipping_id",
    } as unknown as ResolvedJoins;

    it("gateway query reuses the paid_orders definition and groups by gateway", () => {
      const sql = gatewayBreakdownQuery(joins);
      expect(sql).toContain("paid_orders");
      expect(sql).toContain("payment_gateway");
      expect(sql).toMatch(/GROUP BY/i);
      // attributes settlement per order (no double counting across gateways)
      expect(sql).toContain("SUM(po.settled_irr)");
    });

    it("gateway query is rooted in orders so an unsettled gateway still gets a row", () => {
      // Regression: this used to be `FROM paid_orders po JOIN orders o`, which
      // dropped any gateway with zero settled transactions from the result
      // entirely — and withShares then made the survivors sum to 100%.
      const sql = gatewayBreakdownQuery(joins);
      expect(sql).toMatch(/FROM\s+orders o/i);
      expect(sql).toMatch(/LEFT JOIN paid_orders po ON po\.order_id = o\.id/i);
      expect(sql).not.toMatch(/FROM\s+paid_orders po\s+JOIN\s+orders/i);
      // Counts must be distinguishable: paid orders vs all orders in range.
      expect(sql).toContain("COUNT(po.order_id)");
      expect(sql).toContain("COUNT(*)::bigint AS total_orders_count");
      // Outer date window in addition to the CTE's.
      expect(sql).toMatch(/WHERE o\.date BETWEEN \? AND \?/i);
      expect(sql.match(/BETWEEN \? AND \?/g)).toHaveLength(2);
    });

    it("shipping query sums the stored shipping_cost, not product subtotal", () => {
      const sql = shippingBreakdownQuery(joins);
      expect(sql).toContain("paid_orders");
      expect(sql).toContain("SUM(o.shipping_cost)");
      expect(sql).toContain("s.title");
      expect(sql).toContain("__UNKNOWN__");
    });

    it("shipping query degrades gracefully when the shipping relation is unresolved", () => {
      const sql = shippingBreakdownQuery({
        ...joins,
        orderToShipping: "",
      } as unknown as ResolvedJoins);
      expect(sql).toContain("NULL::text");
      expect(sql).toContain("__UNKNOWN__");
    });
  });

  describe("eligible-order definition", () => {
    const joins = {
      orderToContract: "JOIN contracts c ON c.order_id = o.id",
      contractToTx: "JOIN contract_transactions ct ON ct.contract_id = c.id",
    } as unknown as ResolvedJoins;

    it("gates BOTH definitions on the completed-order status", () => {
      // Regression: `settled` used to require only a successful gateway transaction.
      // An order that was paid and then cancelled therefore counted as revenue, and
      // the two definitions described different order populations for one window.
      for (const definition of ["settled", "completed"] as const) {
        expect(paidOrdersCte(joins, definition)).toContain(
          `o.status = '${ELIGIBLE_ORDER_STATUS}'`,
        );
      }
    });

    it("makes 'settled' a strict subset of 'completed'", () => {
      // Same status gate on both sides, plus a settlement requirement on `settled`
      // only — so switching definitions can narrow the set but never swap it for a
      // different one.
      const settled = paidOrdersCte(joins, "settled");
      const completed = paidOrdersCte(joins, "completed");
      expect(settled).toContain("ct.status = 'Success'");
      expect(settled).toMatch(/HAVING SUM/);
      expect(completed).not.toMatch(/HAVING SUM/);
    });
  });

  describe("category membership", () => {
    const joins = {
      categoryMembershipTables: [
        "products_product_main_category_links",
        "products_product_other_categories_links",
      ],
      categoryParentLink: {
        table: "product_categories_parent_links",
        childCol: "product_category_id",
        parentCol: "inv_product_category_id",
      },
    } as unknown as ResolvedJoins;

    it("unions every membership table so additional categories count", () => {
      const sql = categoryMembershipCte(joins);
      expect(sql).toContain("products_product_main_category_links");
      expect(sql).toContain("products_product_other_categories_links");
      // UNION, not UNION ALL: a product filed under one category through both
      // relations must yield a single membership row.
      expect(sql).toMatch(/UNION(?!\s+ALL)/);
    });

    it("yields a typed empty set when no membership table resolves", () => {
      const sql = categoryMembershipCte({
        ...joins,
        categoryMembershipTables: [],
      } as unknown as ResolvedJoins);
      // A drifted schema must produce an empty category report, not a SQL error.
      expect(sql).toContain("WHERE false");
      expect(sql).toContain("NULL::int AS product_category_id");
    });

    it("filters on membership + descendants, via EXISTS rather than a join", () => {
      const sql = categoryFilterSql(joins, "p.id");
      // Regression: this filter used to read `pc.id = ?`, i.e. the product's MAIN
      // category only, and ignored the category's descendants entirely.
      expect(sql).toContain("products_product_other_categories_links");
      expect(sql).toContain("WITH RECURSIVE cat_scope");
      expect(sql.startsWith("EXISTS (")).toBe(true);
      // Exactly one bound parameter: the category id.
      expect(sql.match(/\?/g)).toHaveLength(1);
    });

    it("drops the descendant walk when the parent relation is unresolved", () => {
      const sql = categoryFilterSql(
        { ...joins, categoryParentLink: null } as unknown as ResolvedJoins,
        "p.id",
      );
      expect(sql).not.toContain("RECURSIVE");
      expect(sql).toContain("cat_scope");
      expect(sql.match(/\?/g)).toHaveLength(1);
    });

    it("returns an empty fragment when membership is unresolvable, so callers append nothing", () => {
      expect(
        categoryFilterSql({ ...joins, categoryMembershipTables: [] } as unknown as ResolvedJoins, "p.id"),
      ).toBe("");
    });
  });

  describe("fillTrendSeries", () => {
    it("keeps a 7-day Tehran window at 7 buckets when SQL returns one day", () => {
      const start = new Date("2025-12-31T20:30:00.000Z");
      const end = new Date("2026-01-07T20:29:59.999Z");
      const filled = fillTrendSeries(
        [{ bucket: "2026-01-01", gross: 500000, net: 500000, units: 2, orders: 1, discounts: 0, refunds: 0 }],
        start,
        end,
        "day",
      );
      expect(filled.map((point) => point.bucket)).toEqual([
        "2026-01-01",
        "2026-01-02",
        "2026-01-03",
        "2026-01-04",
        "2026-01-05",
        "2026-01-06",
        "2026-01-07",
      ]);
      expect(filled[0].net).toBe(500000);
      expect(filled.slice(1).every((point) => point.net === 0)).toBe(true);
    });
  });
});
