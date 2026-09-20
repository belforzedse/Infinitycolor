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
  aggCte,
  performanceCoreSelect,
  performanceCtes,
  productStockTotalsCte,
  variationAttributesCte,
  variantLabel,
  categoryMembershipCte,
  categoryFilterSql,
  ELIGIBLE_ORDER_STATUS,
  ELIGIBLE_ORDER_STATUSES,
  ELIGIBLE_STATUS_SQL,
  PAID_ORDER_STATUSES,
  PAID_STATUS_SQL,
  resolvePaidOrdersDefinition,
  settlementGatewayExpr,
  tzBucketKeyExpr,
  bucketDateKey,
  fillBucketSeries,
  PERFORMANCE_SORT_COLUMNS,
  MAX_PAGE_SIZE,
  type ResolvedJoins,
} from "../product-analytics";

/**
 * Stand-in for what `resolveJoins` discovers, for the SQL builders that take it.
 * Every member `performanceCoreSelect` dereferences must be present: the
 * `as unknown as ResolvedJoins` cast hides a missing one from tsc, and the builder
 * then throws on `undefined.titleExpr` at runtime.
 */
const PERF_JOINS = {
  oiToOrder: "JOIN orders o ON o.id = oi.order_id",
  oiToVariation: { join: "", idExpr: "oi.product_variation_id" },
  orderToContract: "JOIN contracts c ON c.order_id = o.id",
  contractToTx: "JOIN contract_transactions ct ON ct.contract_id = c.id",
  variationToProduct: "JOIN products p ON p.id = pv.product_id",
  variationToStock: "LEFT JOIN product_stocks ps ON ps.product_variation_id = pv.id",
  variationToColor: {
    join: "LEFT JOIN product_variation_colors pvc ON pvc.id = pv.color_id",
    titleExpr: "pvc.title",
    codeExpr: "pvc.color_code",
  },
  variationToSize: {
    join: "LEFT JOIN product_variation_sizes pvs ON pvs.id = pv.size_id",
    titleExpr: "pvs.title",
  },
  variationToModel: {
    join: "LEFT JOIN product_variation_models pvm ON pvm.id = pv.model_id",
    titleExpr: "pvm.title",
  },
  hasVariationAttributes: true,
  productToCategory: {
    join: "LEFT JOIN product_categories pc ON pc.id = p.category_id",
    titleExpr: "pc.title",
  },
} as unknown as ResolvedJoins;

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

    it("gateway query reuses the paid_orders definition and attributes cash per settlement leg", () => {
      const sql = gatewayBreakdownQuery(joins);
      expect(sql).toContain("paid_orders");
      expect(sql).toMatch(/GROUP BY/i);
      // Cash is summed per transaction leg, not per order: a split payment
      // (wallet + gateway) must show under both channels.
      expect(sql).toMatch(/SUM\(CASE WHEN ct\.type = 'Return' THEN -ct\.amount ELSE ct\.amount END\)/);
      expect(sql).toContain("COUNT(DISTINCT po.order_id)");
      // Without the settlement_gateway column every leg is the order's gateway.
      expect(sql).toContain("COALESCE(NULLIF(o.payment_gateway, ''), 'Unknown')");
      expect(sql).not.toContain("settlement_gateway");
      // The distinct paid-order count rides along for footers.
      expect(sql).toContain("(SELECT COUNT(*) FROM paid_orders)::bigint AS paid_orders_count");
    });

    it("gateway query groups by the leg's own channel when the column exists", () => {
      const sql = gatewayBreakdownQuery({ ...joins, txSettlementGateway: true } as ResolvedJoins);
      expect(sql).toContain(
        "COALESCE(NULLIF(ct.settlement_gateway, ''), NULLIF(o.payment_gateway, ''), 'Unknown')",
      );
      expect(settlementGatewayExpr({ txSettlementGateway: false } as ResolvedJoins)).not.toContain("ct.");
    });

    it("gateway query keeps every order in range so an unsettled gateway still gets a row", () => {
      // Regression: this used to be `FROM paid_orders po JOIN orders o`, which
      // dropped any gateway with zero settled transactions from the result
      // entirely — and withShares then made the survivors sum to 100%.
      const sql = gatewayBreakdownQuery(joins);
      expect(sql).toMatch(/FULL OUTER JOIN all_orders a ON a\.gateway = l\.gateway/i);
      // Counts must be distinguishable: paid orders vs all orders in range.
      expect(sql).toContain("COALESCE(l.orders_count, 0)::bigint AS orders_count");
      expect(sql).toContain("COUNT(*)::bigint AS total_orders_count");
      // All-orders window (creation date) in addition to the CTE's.
      expect(sql).toMatch(/WHERE o\.date BETWEEN \? AND \?/i);
      expect(sql.match(/BETWEEN \? AND \?/g)).toHaveLength(2);
    });

    it("gateway query windows the CTE on the settlement date when asked", () => {
      const sql = gatewayBreakdownQuery(joins, "settled", "settlement");
      expect(sql).toContain("AND ct.date BETWEEN ? AND ?");
      expect(sql.match(/BETWEEN \? AND \?/g)).toHaveLength(2);
    });

    it("shipping query sums the stored shipping_cost, not product subtotal", () => {
      const sql = shippingBreakdownQuery(joins);
      expect(sql).toContain("paid_orders");
      expect(sql).toContain("SUM(o.shipping_cost)");
      expect(sql).toContain("__UNKNOWN__");
    });

    it("shipping query names the method from the order's own snapshot before the relation", () => {
      // Regression: grouping by `shippings.title` alone filed every imported
      // order (which has the snapshot but no relation) under «نامشخص».
      const sql = shippingBreakdownQuery(joins);
      expect(sql).toContain(
        "COALESCE(NULLIF(o.shipping_method_title, ''), NULLIF(s.title, ''), '__UNKNOWN__')",
      );
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

    it("counts fulfilment statuses (Started, Shipment, Done) and nothing else", () => {
      // D15: a settled order the shop has accepted is a sale. `Started`
      // («در حال انجام») is where the gateway-success path leaves an order, and
      // excluding it made «فروش» lag the till by the fulfilment desk.
      // Paying / Cancelled / Returned stay out — no sale stands there.
      expect([...ELIGIBLE_ORDER_STATUSES]).toEqual(["Started", "Shipment", "Done"]);
      expect(ELIGIBLE_ORDER_STATUSES).toContain(ELIGIBLE_ORDER_STATUS);
      expect(ELIGIBLE_ORDER_STATUSES).toContain("Started");
      expect(ELIGIBLE_ORDER_STATUSES).not.toContain("Paying");
      expect(ELIGIBLE_ORDER_STATUSES).not.toContain("Cancelled");
      expect(ELIGIBLE_ORDER_STATUSES).not.toContain("Returned");
      expect(ELIGIBLE_STATUS_SQL).toBe("'Started', 'Shipment', 'Done'");
    });

    it("keeps 'paid' as its own named set for the conversion card", () => {
      // «سفارش پرداخت‌شده» asks whether a visit turned into a payment; that happens
      // at the gateway, not at the fulfilment desk. D15 makes the two status lists
      // equal by value, but they answer different questions and have diverged before
      // (D14), so they stay separate constants. Money never reads this one, and the
      // sale gate stays a subset of it.
      expect([...PAID_ORDER_STATUSES]).toEqual(["Started", "Shipment", "Done"]);
      expect(PAID_STATUS_SQL).toBe("'Started', 'Shipment', 'Done'");
      for (const status of ELIGIBLE_ORDER_STATUSES) {
        expect(PAID_ORDER_STATUSES).toContain(status);
      }
      // The sale gate reads its OWN constant, never the conversion one.
      expect(paidOrdersCte(joins, "settled")).toContain(`o.status IN (${ELIGIBLE_STATUS_SQL})`);
    });

    it("keeps Shipment in: it is the step AFTER Done, not a pre-sale state", () => {
      // Regression guard for the obvious over-correction. Shipping a completed
      // order must not remove its revenue from the day it was sold.
      expect(ELIGIBLE_ORDER_STATUSES).toContain("Shipment");
      expect(paidOrdersCte(joins, "settled")).toContain("'Shipment'");
    });

    it("gates BOTH definitions on the same status set", () => {
      // Regression: `settled` used to require only a successful gateway transaction.
      // An order that was paid and then cancelled therefore counted as revenue, and
      // the two definitions described different order populations for one window.
      for (const definition of ["settled", "completed"] as const) {
        expect(paidOrdersCte(joins, definition)).toContain(
          `o.status IN (${ELIGIBLE_STATUS_SQL})`,
        );
      }
    });

    it("windows on the creation date by default and on the settlement date on the settlement clock", () => {
      expect(paidOrdersCte(joins, "settled", "order")).toContain("AND o.date BETWEEN ? AND ?");
      expect(paidOrdersCte(joins, "settled", "order")).toContain("o.date AS order_date");

      const settlement = paidOrdersCte(joins, "settled", "settlement");
      expect(settlement).toContain("AND ct.date BETWEEN ? AND ?");
      expect(settlement).not.toContain("o.date BETWEEN");
      // The exposed clock date follows the window, so trend buckets do too.
      expect(settlement).toContain(
        "COALESCE(MIN(ct.date) FILTER (WHERE ct.status = 'Success' AND ct.type <> 'Return'), o.date) AS order_date",
      );
      // Still exactly two bindings.
      expect(settlement.match(/\?/g)).toHaveLength(2);

      const completed = paidOrdersCte(joins, "completed", "settlement");
      expect(completed).toMatch(/HAVING COALESCE\(MIN\(ct\.date\)/);
      expect(completed.match(/\?/g)).toHaveLength(2);
    });

    it("resolves the definition on the same clock column as the CTE", async () => {
      const calls: Array<[string, any[]]> = [];
      const knex = {
        raw: jest.fn(async (sql: string, bindings: any[]) => {
          calls.push([sql, bindings]);
          return { rows: [{ has_settlement: true }] };
        }),
      } as any;
      const start = new Date("2026-01-01T00:00:00Z");
      const end = new Date("2026-01-02T00:00:00Z");
      await expect(resolvePaidOrdersDefinition(knex, joins, start, end)).resolves.toBe("settled");
      expect(calls[0][0]).toContain("AND o.date BETWEEN ? AND ?");
      await resolvePaidOrdersDefinition(knex, joins, start, end, "settlement");
      expect(calls[1][0]).toContain("AND ct.date BETWEEN ? AND ?");
      expect(calls[1][0]).toContain(`o.status IN (${ELIGIBLE_STATUS_SQL})`);
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

  describe("bucket keys", () => {
    it("renders the Tehran bucket as a YYYY-MM-DD text key in SQL", () => {
      const sql = tzBucketKeyExpr("order_date", "day");
      expect(sql).toBe(
        "to_char(date_trunc('day', (order_date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Tehran'), 'YYYY-MM-DD')",
      );
    });

    it("reads a Date bucket back in the zone node-postgres parsed it in", () => {
      // Regression: `date_trunc` returns a bare timestamp, which node-postgres
      // turns into a Date; String(date) never matched /^\d{4}-\d{2}-\d{2}/,
      // so every trend charted as a flat zero line.
      expect(bucketDateKey("2026-08-03T00:00:00.000Z")).toBe("2026-08-03");
      expect(bucketDateKey("2026-08-03")).toBe("2026-08-03");
      expect(bucketDateKey(new Date(2026, 7, 3, 0, 0, 0))).toBe("2026-08-03");
    });
  });

  describe("fillTrendSeries", () => {
    it("matches a Date bucket to its calendar day instead of zeroing it", () => {
      const start = new Date("2026-08-02T20:30:00.000Z");
      const end = new Date("2026-08-04T20:29:59.999Z");
      const filled = fillTrendSeries(
        [{ bucket: new Date(2026, 7, 3) as unknown as string, gross: 7, net: 7, units: 1, orders: 1, discounts: 0, refunds: 0 }],
        start,
        end,
        "day",
      );
      expect(filled.map((p) => [p.bucket, p.net])).toEqual([
        ["2026-08-03", 7],
        ["2026-08-04", 0],
      ]);
    });

    it("fills any bucketed series with the supplied empty point", () => {
      const start = new Date("2026-01-01T20:30:00.000Z");
      const end = new Date("2026-01-03T20:29:59.999Z");
      const filled = fillBucketSeries(
        [{ bucket: "2026-01-03", total: 5, orders: 1 }],
        start,
        end,
        "day",
        { total: 0, orders: 0 },
      );
      expect(filled).toEqual([
        { bucket: "2026-01-02", total: 0, orders: 0 },
        { bucket: "2026-01-03", total: 5, orders: 1 },
      ]);
    });

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

  describe("product identity in the aggregate", () => {
    it("groups by variation, falling back to the SKU only when there is none", () => {
      // Regression: order_items.product_sku is a snapshot taken at order time, so
      // an import that renamed a product split its variation into two rows — the
      // row an operator was watching stayed frozen while a second row silently
      // collected the new orders. Identity is the variation; the SKU only
      // discriminates rows with no variation at all.
      const sql = aggCte();
      expect(sql).toMatch(
        /GROUP BY product_variation_id,\s*CASE WHEN product_variation_id IS NULL THEN product_sku END/i,
      );
      expect(sql).not.toMatch(/GROUP BY product_variation_id,\s*product_sku\b/i);
    });

    it("reports the newest title and SKU while keeping old SKUs searchable", () => {
      const sql = aggCte();
      expect(sql).toMatch(/ARRAY_AGG\(product_title ORDER BY order_date DESC\)/i);
      expect(sql).toMatch(/ARRAY_AGG\(product_sku ORDER BY order_date DESC\)/i);
      expect(sql).toContain("string_agg(DISTINCT product_sku, ' ') AS sku_search");
      expect(sql).not.toContain("MAX(product_title)");
    });

    it("exposes every sortable column as an output alias", () => {
      // PERFORMANCE_SORT_COLUMNS is interpolated straight into ORDER BY, so a key
      // whose column the SELECT never emits is a runtime 400 ("column net does
      // not exist"), not a compile error. `net`, `refunds` and `avgPrice` were all
      // reachable from the UI's sort dropdown while missing from the SELECT.
      const joins = PERF_JOINS;

      const sql = performanceCoreSelect(joins);
      for (const column of Object.values(PERFORMANCE_SORT_COLUMNS)) {
        expect(sql).toMatch(new RegExp(`(AS\\s+|\\.)${column}\\b`, "i"));
      }
    });
  });
});

describe("variant identity and product-level stock", () => {
  describe("variantLabel", () => {
    it("joins the three axes in display order", () => {
      expect(variantLabel({ color: "مشکی", size: "L", model: "کلاسیک" })).toBe(
        "مشکی / L / کلاسیک",
      );
    });

    it("drops absent axes rather than leaving empty separators", () => {
      expect(variantLabel({ color: "مشکی", size: null, model: undefined })).toBe("مشکی");
      expect(variantLabel({ color: null, size: "XL" })).toBe("XL");
    });

    it("returns null — not an empty string — when nothing is known", () => {
      // The UI renders "—" on null. An empty string would render as a blank cell
      // that looks like a loading state.
      expect(variantLabel({})).toBeNull();
      expect(variantLabel({ color: "   ", size: "" })).toBeNull();
    });
  });

  describe("productStockTotalsCte", () => {
    it("declares no bindings", () => {
      // The callers pass [start, end, ...filters] positionally and knex numbers
      // placeholders by textual position, so a single `?` here would silently
      // shift every filter parameter.
      expect(productStockTotalsCte(PERF_JOINS)).not.toContain("?");
    });

    it("sums stock over every variation of the product, counting nulls as zero", () => {
      const sql = productStockTotalsCte(PERF_JOINS);
      expect(sql).toContain("SUM(COALESCE(ps.count, 0))");
      expect(sql).toContain("GROUP BY p.id");
      expect(sql).toContain("sold_products");
    });

    it("keeps the product join INNER so orphan variations form no NULL bucket", () => {
      const sql = productStockTotalsCte(PERF_JOINS);
      expect(sql).toContain("JOIN products p ON p.id = pv.product_id");
      expect(sql).not.toContain("LEFT JOIN products p");
    });

    it("applies no publish or removal filter, matching the drawer's total", () => {
      // productDetail sums the same variations in JS with no such filter. A filter
      // here would produce a third number for the same question.
      const sql = productStockTotalsCte(PERF_JOINS);
      expect(sql).not.toContain("removed_at");
      expect(sql).not.toContain("is_published");
    });
  });

  describe("variationAttributesCte", () => {
    it("emits exactly one row per variation", () => {
      // This is what keeps countSql's total and the pagination correct: the outer
      // query joins this CTE once, so duplicate link rows cannot multiply results.
      const sql = variationAttributesCte(PERF_JOINS);
      expect(sql).toContain("DISTINCT ON (pv.id)");
      expect(sql).toContain("ORDER BY pv.id");
    });

    it("declares no bindings", () => {
      expect(variationAttributesCte(PERF_JOINS)).not.toContain("?");
      expect(variationAttributesCte(PERF_JOINS, "all")).not.toContain("?");
    });

    it("prefers the dedicated relation and falls back to the projected term", () => {
      const sql = variationAttributesCte(PERF_JOINS);
      expect(sql).toContain("COALESCE(pvc.title, ga.gen_color)");
      expect(sql).toContain("COALESCE(pvs.title, ga.gen_size)");
      expect(sql).toContain("COALESCE(pvm.title, ga.gen_model)");
    });

    it("keeps a swatch with the colour it belongs to", () => {
      // A plain COALESCE would pair a legacy colour that has no code with some
      // other attribute's code.
      expect(variationAttributesCte(PERF_JOINS)).toContain(
        "CASE WHEN pvc.title IS NOT NULL THEN pvc.color_code",
      );
    });

    it("carries every term unfiltered, so no attribute is ever hidden", () => {
      const sql = variationAttributesCte(PERF_JOINS);
      expect(sql).toContain("jsonb_agg");
      expect(sql).toContain("'projection', COALESCE(pa.legacy_projection, 'None')");
      expect(sql).toMatch(/FILTER \(WHERE COALESCE\(pa\.legacy_projection, 'None'\) = 'None'\)/);
    });

    it("scopes to sold variations only when asked", () => {
      expect(variationAttributesCte(PERF_JOINS, "agg")).toContain(
        "JOIN agg ON agg.product_variation_id = pv.id",
      );
      expect(variationAttributesCte(PERF_JOINS, "all")).not.toContain("JOIN agg");
    });

    it("keeps colour and size when the generic attribute tables are absent", () => {
      // Two independent degradation paths: a database lagging the generic-attribute
      // migration must not also lose the colour it already has.
      const sql = variationAttributesCte({
        ...PERF_JOINS,
        hasVariationAttributes: false,
      } as unknown as ResolvedJoins);
      expect(sql).not.toContain("product_attribute_terms");
      expect(sql).toContain("WHERE false");
      expect(sql).toContain("COALESCE(pvc.title, ga.gen_color)");
      expect(sql).toContain("LEFT JOIN product_variation_colors");
    });
  });

  describe("performanceCoreSelect", () => {
    it("exposes the variant identity and the product total", () => {
      const sql = performanceCoreSelect(PERF_JOINS);
      expect(sql).toContain("va.variant_color");
      expect(sql).toContain("va.variant_size");
      expect(sql).toContain("va.variant_other");
      expect(sql).toContain("AS product_total_stock");
      expect(sql).toContain("LEFT JOIN product_stock_totals pst ON pst.product_id = p.id");
      expect(sql).toContain("LEFT JOIN variation_attributes va");
    });

    it("never leftifies an already-LEFT fragment into LEFT LEFT JOIN", () => {
      expect(performanceCoreSelect(PERF_JOINS)).not.toContain("LEFT LEFT JOIN");
    });
  });

  describe("performanceCtes", () => {
    it("declares agg before the CTEs that read it", () => {
      const sql = performanceCtes(PERF_JOINS);
      // Non-recursive WITH resolves left to right, so a CTE referencing `agg`
      // must be declared after it.
      expect(sql.indexOf("agg AS (")).toBeGreaterThan(-1);
      expect(sql.indexOf("variation_attributes AS (")).toBeGreaterThan(sql.indexOf("agg AS ("));
      expect(sql.indexOf("product_stock_totals AS (")).toBeGreaterThan(sql.indexOf("agg AS ("));
      expect(sql.indexOf("sold_products AS (")).toBeGreaterThan(sql.indexOf("agg AS ("));
    });

    it("adds no bindings beyond the two the paid-orders window already takes", () => {
      expect(performanceCtes(PERF_JOINS).match(/\?/g)).toHaveLength(2);
    });
  });

  describe("serializeProductRow", () => {
    const base = {
      product_variation_id: 7,
      product_id: 3,
      product_title: "شلوار",
      product_sku: "G01170-1",
      product_type: "Variable",
      category_title: null,
      units: "2",
      gross: "1000",
      discounts: "0",
      refunds_irr: "0",
      orders_count: "1",
      current_stock: "6",
      reserved_stock: "0",
      variant_color: "مشکی",
      variant_color_code: "#000000",
      variant_size: "L",
      variant_model: null,
      variant_other: "جنس: نخی",
      product_total_stock: "40",
      product_variation_count: "5",
    } as any;

    it("reports the variant's own stock and the product's total side by side", () => {
      const row = serializeProductRow(base);
      expect(row.currentStock).toBe(6);
      expect(row.productTotalStock).toBe(40);
      expect(row.productVariationCount).toBe(5);
    });

    it("builds the label from the variant axes", () => {
      expect(serializeProductRow(base).variantLabel).toBe("مشکی / L");
      expect(serializeProductRow(base).variantOther).toBe("جنس: نخی");
    });

    it("leaves the product total null for a deleted variation", () => {
      // 0 would read as "out of stock". There is no product here to total at all.
      const row = serializeProductRow({
        ...base,
        product_variation_id: null,
        product_id: null,
        product_total_stock: null,
        product_variation_count: null,
        variant_color: null,
        variant_size: null,
      });
      expect(row.productTotalStock).toBeNull();
      expect(row.variantLabel).toBeNull();
    });

    it("keeps a real zero total distinct from an absent one", () => {
      expect(serializeProductRow({ ...base, product_total_stock: "0" }).productTotalStock).toBe(0);
    });
  });
});
