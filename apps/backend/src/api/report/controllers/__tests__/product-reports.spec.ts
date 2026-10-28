export {}; // ensure module scope so test-local mocks don't collide with sibling specs

const fetchUserWithRoleMock = jest.fn();
const roleIsAllowedMock = jest.fn();
const resolveJoinsMock = jest.fn();

jest.mock("../../../../utils/roles", () => ({
  ROLE_NAMES: {
    SUPERADMIN: "Superadmin",
    STORE_MANAGER: "Store manager",
    EDITOR: "Editor",
    FOUNDER: "Founder",
    CUSTOMER: "Customer",
  },
  fetchUserWithRole: (...args: any[]) => fetchUserWithRoleMock(...args),
  roleIsAllowed: (...args: any[]) => roleIsAllowedMock(...args),
}));

jest.mock("../../services/umami", () => ({
  UMAMI_DEFINITION_VERSION: "umami-infinity-v1",
  UMAMI_REPORT_TIMEZONE: "Asia/Tehran",
  isUmamiConfigured: jest.fn(() => false),
  normalizeRange: jest.fn(() => ({ startDate: "2026-08-09", endDate: "2026-08-31" })),
  previousRange: jest.fn(() => ({ startDate: "2026-07-17", endDate: "2026-08-08" })),
  normalizeUmamiFilters: jest.fn(() => ({})),
  getUmamiBehaviorReport: jest.fn(),
  getUmamiRealtimeReport: jest.fn(),
}));

const workbookCalls: any[] = [];
jest.mock("../../../../utils/styledWorkbook", () => {
  const actual = jest.requireActual("../../../../utils/styledWorkbook");
  return {
    ...actual,
    buildStyledWorkbook: (opts: any) => {
      workbookCalls.push(opts);
      return actual.buildStyledWorkbook(opts);
    },
  };
});

jest.mock("../../services/product-analytics", () => {
  const actual = jest.requireActual("../../services/product-analytics");
  return { ...actual, resolveJoins: (...args: any[]) => resolveJoinsMock(...args) };
});

const STUB_JOINS = {
  oiToOrder: "JOIN orders o ON true",
  oiToVariation: { join: "", idExpr: "oi.product_variation_id" },
  orderToContract: "JOIN contracts c ON true",
  contractToTx: "JOIN contract_transactions ct ON true",
  variationToProduct: "JOIN products p ON true",
  variationToStock: "LEFT JOIN product_stocks ps ON true",
  variationToColor: {
    join: "LEFT JOIN product_variation_colors pvc ON true",
    titleExpr: "pvc.title",
    codeExpr: "pvc.color_code",
  },
  variationToSize: { join: "LEFT JOIN product_variation_sizes pvs ON true", titleExpr: "pvs.title" },
  variationToModel: {
    join: "LEFT JOIN product_variation_models pvm ON true",
    titleExpr: "pvm.title",
  },
  hasVariationAttributes: true,
  productToCategory: { join: "LEFT JOIN product_categories pc ON true", titleExpr: "pc.title" },
  orderToShipping: "LEFT JOIN shippings s ON true",
};

const PERIOD_ROW = {
  gross: "1000000",
  units: "4",
  orders_count: "3",
  discounts: "50000",
  refund_irr: "2400000", // -> 240,000 Toman
  // Returned alongside gross, never folded into it: the product reports are
  // per-product and a delivery fee belongs to no product (decision D16).
  shipping: "40000",
};
const INV_ROW = {
  active_products: "12",
  in_stock: "30",
  low_stock: "4",
  out_stock: "2",
  total_variations: "36",
};
const PERF_ROW = {
  product_variation_id: 7,
  product_id: 3,
  product_title: "کفش",
  product_sku: "SKU-1",
  product_type: "Variable",
  category_title: "کفش‌ها",
  category_id: 2,
  units: "4",
  gross: "1000000",
  discounts: "50000",
  refunds_irr: "2400000",
  orders_count: "3",
  current_stock: "2",
  reserved_stock: "1",
  variant_color: "مشکی",
  variant_color_code: "#000000",
  variant_size: "L",
  variant_model: null,
  variant_other: "جنس: نخی",
  product_total_stock: "40",
  product_variation_count: "5",
};

const VARIATION_ROW = {
  variation_id: 7,
  sku: "SKU-1",
  units: "4",
  gross: "1000000",
  discounts: "0",
  refunds_irr: "0",
  current_stock: "6",
  reserved_stock: "0",
  variant_color: "مشکی",
  variant_color_code: "#000000",
  variant_size: "L",
  variant_model: null,
  variant_other: "جنس: نخی",
  variant_attrs: [{ name: "جنس", value: "نخی", colorCode: null, projection: "None" }],
};
const INVENTORY_ROW = {
  variation_id: 7,
  product_id: 3,
  sku: "SKU-1",
  product_title: "کفش",
  current_stock: "6",
  reserved_stock: "0",
  units_sold: "4",
  gross: "1000000",
  variant_color: "مشکی",
  variant_color_code: "#000000",
  variant_size: "L",
  variant_model: null,
  variant_other: null,
};

function rawRouter(sql: string) {
  // Gateway breakdown: ZarinPal settled, Mellat took orders and settled none.
  if (sql.includes("total_orders_count")) {
    return {
      rows: [
        {
          gateway: "ZarinPal",
          orders_count: "4",
          total_orders_count: "5",
          settled_irr: "8000000",
          paid_orders_count: "4",
          single_orders_count: "4",
          mixed_orders_count: "0",
          mixed_irr: "0",
        },
        {
          gateway: "Mellat",
          orders_count: "0",
          total_orders_count: "12",
          settled_irr: "0",
          paid_orders_count: "4",
          single_orders_count: "4",
          mixed_orders_count: "0",
          mixed_irr: "0",
        },
      ],
    };
  }
  if (sql.includes("AS has_settlement")) return { rows: [{ has_settlement: false }] };
  // The period scalar query selects SUM(o.shipping_cost) too, so it must be
  // matched on its own marker BEFORE the shipping-breakdown branch below.
  if (sql.includes("SUM(line_gross) FROM itemized")) return { rows: [PERIOD_ROW] };
  if (sql.includes("SUM(o.shipping_cost)")) {
    return { rows: [{ method: "__UNKNOWN__", orders_count: "4", shipping_total: "40000" }] };
  }
  if (sql.includes("active_products")) return { rows: [INV_ROW] };
  if (sql.includes("FULL OUTER JOIN orders_b")) {
    return {
      rows: [
        {
          bucket: "2026-09-15",
          gross: "500000",
          units: "2",
          orders_count: "1",
          discounts: "0",
          refund_irr: "0",
        },
      ],
    };
  }
  if (sql.includes("COUNT(*)::bigint AS total")) return { rows: [{ total: "1" }] };
  // Specific branches first: the perf/export SQL also contains the literal
  // "agg.product_variation_id" that the catch-all below keys on.
  if (sql.includes("SELECT p.id, p.title, p.slug")) {
    return { rows: [{ id: 3, title: "کفش", slug: "kafsh", product_type: "Variable", status: "Active", category_title: "کفش‌ها" }] };
  }
  if (sql.includes("LEFT JOIN agg a ON a.product_variation_id")) return { rows: [VARIATION_ROW] };
  if (sql.includes("LEFT JOIN sales s ON s.pvid")) return { rows: [INVENTORY_ROW] };
  if (sql.includes("agg.product_variation_id")) return { rows: [PERF_ROW] };
  return { rows: [] };
}

function createStrapi(roleName = "Founder") {
  return {
    query: () => ({
      findOne: jest.fn().mockResolvedValue({ id: 1, role: { name: roleName } }),
    }),
    db: { connection: { raw: jest.fn(async (sql: string) => rawRouter(sql)) } },
    entityService: { findMany: jest.fn().mockResolvedValue([]) },
    log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
  };
}

function loadController() {
  let controller: any;
  jest.isolateModules(() => {
    controller = require("../report").default;
  });
  return controller;
}

function createCtx(overrides: Partial<any> = {}) {
  return {
    state: { user: { id: 1 } },
    query: {},
    body: undefined,
    forbidden: jest.fn(),
    badRequest: jest.fn(),
    notFound: jest.fn(),
    set: jest.fn(),
    ...overrides,
  };
}

describe("product reporting endpoints", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveJoinsMock.mockResolvedValue(STUB_JOINS);
    (global as any).strapi = createStrapi();
  });

  it("blocks non-manager roles", async () => {
    (global as any).strapi = createStrapi("Customer");

    const controller = loadController();
    const ctx = createCtx();
    await controller.productPerformance(ctx);

    expect(ctx.forbidden).toHaveBeenCalledWith("You do not have permission to perform this action");
    expect(ctx.body).toBeUndefined();
  });

  it.each([
    ["productOverview", {}],
    ["productTrends", {}],
    ["productPerformance", {}],
    ["productExport", {}],
    ["productDetail", { productId: "3" }],
    ["productInventory", {}],
  ])("allows Founder through the %s access gate", async (handlerName, query) => {
    const controller = loadController();
    const ctx = createCtx({ query });
    await controller[handlerName](ctx);

    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  describe("with an authorized finance analyst", () => {
    beforeEach(() => {
      (global as any).strapi = createStrapi("Finance");
    });

    it("overview converts refund IRR->Toman, computes net, and returns inventory", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: { start: "2026-01-01", end: "2026-01-31" } });
      await controller.productOverview(ctx);

      expect(ctx.badRequest).not.toHaveBeenCalled();
      const { kpis, inventory } = ctx.body.data;
      // Product-report gross stays merchandise-only: the 40,000 shipping fee the
      // same query returns is NOT added here, only on the store-wide overview.
      expect(kpis.gross.current).toBe(1_000_000);
      expect(kpis).not.toHaveProperty("shipping");
      expect(kpis.refunds.current).toBe(240_000); // 2,400,000 IRR / 10
      expect(kpis.net.current).toBe(710_000); // 1,000,000 - 50,000 - 240,000
      // current === previous (same mocked row) -> zero change
      expect(kpis.gross.change).toBe(0);
      expect(inventory.activeProducts).toBe(12);
      expect(inventory.lowStock).toBe(4);
    });

    it("trends fills every Tehran calendar day even when SQL returns one bucket", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: { start: "2026-09-15", end: "2026-09-21", grouping: "day" } });
      await controller.productTrends(ctx);

      expect(ctx.badRequest).not.toHaveBeenCalled();
      expect(ctx.body.data.grouping).toBe("day");
      expect(ctx.body.data.timezone).toBe("Asia/Tehran");
      expect(ctx.body.data.ordersDefinition).toBe("completed");
      expect(ctx.body.data.series.map((point: { bucket: string }) => point.bucket)).toEqual([
        "2026-09-15",
        "2026-09-16",
        "2026-09-17",
        "2026-09-18",
        "2026-09-19",
        "2026-09-20",
        "2026-09-21",
      ]);
      expect(ctx.body.data.series[0].net).toBe(500_000);
      expect(ctx.body.data.series.slice(1).every((point: { net: number }) => point.net === 0)).toBe(
        true,
      );
      // The bucket key is produced in SQL as text, never parsed from a Date.
      const trendCall = (global as any).strapi.db.connection.raw.mock.calls.find(
        ([sql]: [string]) => sql.includes("FULL OUTER JOIN orders_b"),
      );
      expect(trendCall[0]).toContain("to_char(date_trunc('day'");
    });

    it("resolves a date-only window across whole Tehran calendar days", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: { start: "2026-09-15", end: "2026-09-21" } });
      await controller.productOverview(ctx);

      expect(ctx.badRequest).not.toHaveBeenCalled();
      // Buckets are computed in Asia/Tehran, so the window has to span local
      // midnight through local end-of-day. Reading these as UTC midnight put
      // the end at 03:30 Tehran and dropped almost all of 2026-09-21.
      expect(ctx.body.data.range.start.toISOString()).toBe("2026-09-14T20:30:00.000Z");
      expect(ctx.body.data.range.end.toISOString()).toBe("2026-09-21T20:29:59.999Z");
    });

    describe("financial data floor (from ۲۳ شهریور ۱۴۰۵)", () => {
      const FLOOR_ISO = "2026-09-13T20:30:00.000Z"; // 2026-09-14 00:00 Tehran
      const FLOOR_MS = new Date(FLOOR_ISO).getTime();

      function dateBindings() {
        const calls = (global as any).strapi.db.connection.raw.mock.calls as Array<
          [string, unknown[] | undefined]
        >;
        return calls.flatMap(([, bindings]) =>
          (bindings ?? []).filter((value): value is Date => value instanceof Date),
        );
      }

      it("is ۲۳ شهریور ۱۴۰۵ in Tehran, so ۲۲ شهریور itself is excluded", () => {
        const PA = jest.requireActual("../../services/product-analytics");
        expect(PA.FINANCIAL_DATA_FLOOR.toISOString()).toBe(FLOOR_ISO);
        const parts = new Intl.DateTimeFormat("en-US-u-ca-persian", {
          timeZone: "Asia/Tehran",
          year: "numeric",
          month: "numeric",
          day: "numeric",
        }).formatToParts(new Date(FLOOR_MS + 12 * 3_600_000));
        const pick = (type: string) => parts.find((part) => part.type === type)?.value;
        expect([pick("year"), pick("month"), pick("day")]).toEqual(["1405", "6", "23"]);
      });

      it("never binds a date before the floor on any product report, whatever the URL asks", async () => {
        const controller = loadController();
        const handlers = [
          "productOverview",
          "productBreakdown",
          "productTrends",
          "productPerformance",
          "productInventory",
          // productSales also goes through parseProductRange but resolves its
          // own joins from information_schema, which this harness does not
          // stub, so it bails before binding any dates.
          "salesBreakdown",
        ] as const;
        for (const handler of handlers) {
          const ctx = createCtx({
            query: { start: "2025-01-01", end: "2026-12-31", dimension: "status" },
          });
          await controller[handler](ctx);
          expect({ handler, badRequest: ctx.badRequest.mock.calls }).toEqual({
            handler,
            badRequest: [],
          });
        }
        const bound = dateBindings();
        expect(bound.length).toBeGreaterThan(0);
        for (const value of bound) expect(value.getTime()).toBeGreaterThanOrEqual(FLOOR_MS);
      });

      it("cuts a straddling window at exactly the floor and reports the cut window", async () => {
        const controller = loadController();
        const ctx = createCtx({ query: { start: "2026-09-01", end: "2026-09-20" } });
        await controller.productOverview(ctx);

        expect(ctx.body.data.range.start.toISOString()).toBe(FLOOR_ISO);
        expect(ctx.body.data.range.end.toISOString()).toBe("2026-09-20T20:29:59.999Z");
        // The like-for-like comparison window is cut to nothing, not left to
        // reach back before the floor. `previousPeriod` ends the prior window
        // on the current start, so the cut window is the single instant at
        // the floor.
        expect(ctx.body.data.previous.start.toISOString()).toBe(FLOOR_ISO);
        expect(ctx.body.data.previous.end.getTime()).toBe(FLOOR_MS);
      });

      it("applies the floor to the default window when no dates are sent", async () => {
        const controller = loadController();
        const ctx = createCtx({ query: {} });
        await controller.productTrends(ctx);

        expect(ctx.badRequest).not.toHaveBeenCalled();
        for (const value of dateBindings()) {
          expect(value.getTime()).toBeGreaterThanOrEqual(FLOOR_MS);
        }
      });

      it("returns an empty series, not an error, for a window wholly before the floor", async () => {
        const controller = loadController();
        const ctx = createCtx({ query: { start: "2026-05-01", end: "2026-05-31", grouping: "day" } });
        await controller.productTrends(ctx);

        expect(ctx.badRequest).not.toHaveBeenCalled();
        expect(ctx.body.data.series).toEqual([]);
        for (const value of dateBindings()) {
          expect(value.getTime()).toBeGreaterThanOrEqual(FLOOR_MS - 1);
        }
      });

      it("leaves the admin activity audit, which is not financial, unfloored", async () => {
        const base = createStrapi("Superadmin");
        const findMany = jest.fn().mockResolvedValue([]);
        (global as any).strapi = {
          ...base,
          entityService: { findMany, count: jest.fn().mockResolvedValue(0) },
        };
        const controller = loadController();
        const ctx = createCtx({ query: { start: "2026-01-01", end: "2026-01-31" } });
        await controller.adminActivity(ctx);

        expect(ctx.forbidden).not.toHaveBeenCalled();
        expect(ctx.badRequest).not.toHaveBeenCalled();
        const [, options] = findMany.mock.calls[0];
        // January is well before the floor and must reach the audit query as-is.
        expect(options.filters.createdAt.$gte).toBe("2025-12-31T20:30:00.000Z");
      });
    });

    it("performance returns server pagination meta and serialized rows", async () => {
      const controller = loadController();
      const ctx = createCtx({
        query: { "pagination[page]": "1", "pagination[pageSize]": "25", sort: "gross:desc" },
      });
      await controller.productPerformance(ctx);

      expect(ctx.badRequest).not.toHaveBeenCalled();
      expect(ctx.body.meta.pagination.total).toBe(1);
      expect(ctx.body.data[0].productSKU).toBe("SKU-1");
      expect(ctx.body.data[0].net).toBe(710_000);
      expect(ctx.body.data[0].stockStatus).toBe("low");
    });

    it("performance surfaces the variant identity and the product-level stock", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: {} });
      await controller.productPerformance(ctx);

      const row = ctx.body.data[0];
      // The reported defect: this row is ONE variation, so currentStock is that
      // variation's alone. The product total has to travel beside it.
      expect(row.currentStock).toBe(2);
      expect(row.productTotalStock).toBe(40);
      expect(row.productVariationCount).toBe(5);
      expect(row.variantColor).toBe("مشکی");
      expect(row.variantSize).toBe("L");
      expect(row.variantLabel).toBe("مشکی / L");
      expect(row.variantOther).toBe("جنس: نخی");
    });

    it("adds the variant and stock-total CTEs without shifting any binding", async () => {
      // knex numbers placeholders by textual position, so a stray `?` in either
      // new CTE would silently re-point every filter parameter. Both the data and
      // the count query are checked: they share one `core` string.
      const controller = loadController();
      const raw = (global as any).strapi.db.connection.raw as jest.Mock;

      await controller.productPerformance(createCtx({ query: {} }));
      const perfCalls = raw.mock.calls.filter(([sql]: [string]) =>
        sql.includes("product_stock_totals AS ("),
      );
      expect(perfCalls.length).toBe(2);
      for (const [sql, params] of perfCalls) {
        expect(sql).toContain("variation_attributes AS (");
        expect(params).toHaveLength(2);
      }

      raw.mockClear();
      await controller.productPerformance(createCtx({ query: { q: "g01170" } }));
      const [, filtered] = raw.mock.calls.find(([sql]: [string]) =>
        sql.includes("product_stock_totals AS ("),
      )!;
      expect(filtered).toEqual([
        expect.anything(),
        expect.anything(),
        "%g01170%",
        "%g01170%",
      ]);
    });

    it("keeps the detail query at three bindings after adding the attribute CTE", async () => {
      const controller = loadController();
      const raw = (global as any).strapi.db.connection.raw as jest.Mock;
      raw.mockClear();

      await controller.productDetail(createCtx({ query: { productId: "3" } }));
      const [, params] = raw.mock.calls.find(([sql]: [string]) =>
        sql.includes("LEFT JOIN agg a ON a.product_variation_id"),
      )!;
      // [start, end, productId] — the attribute CTE must add none of its own.
      expect(params).toHaveLength(3);
      expect(params[2]).toBe(3);
    });

    it("detail reports each variation's colour and size, not just its SKU", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: { productId: "3" } });
      await controller.productDetail(ctx);

      const variation = ctx.body.data.variations[0];
      expect(variation.sku).toBe("SKU-1");
      expect(variation.variantLabel).toBe("مشکی / L");
      expect(variation.variantAttrs).toEqual([
        { name: "جنس", value: "نخی", colorCode: null, projection: "None" },
      ]);
    });

    it("inventory reports colour and size alongside the SKU", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: {} });
      await controller.productInventory(ctx);

      const row = [...ctx.body.data.fastMoving, ...ctx.body.data.lowStock][0];
      expect(row.variantLabel).toBe("مشکی / L");
    });

    it("performance clamps an oversized pageSize", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: { pageSize: "99999" } });
      await controller.productPerformance(ctx);
      expect(ctx.body.meta.pagination.pageSize).toBe(100);
    });

    it("export returns a styled .xlsx workbook buffer", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: {} });
      await controller.productExport(ctx);

      expect(ctx.set).toHaveBeenCalledWith(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(ctx.set).toHaveBeenCalledWith("Content-Disposition", expect.stringContaining(".xlsx"));
      expect(Buffer.isBuffer(ctx.body)).toBe(true);
      // .xlsx is a ZIP archive → starts with the "PK" magic bytes.
      expect(ctx.body.slice(0, 2).toString("latin1")).toBe("PK");
    });

    it("keeps the export's header and data rows index-aligned", async () => {
      // The headers and the row mapping are two hand-maintained arrays. This change
      // inserts into both; a mismatch silently files every value under the wrong
      // column, which no other assertion would catch.
      workbookCalls.length = 0;
      const controller = loadController();
      await controller.productExport(createCtx({ query: {} }));

      const { columns, rows } = workbookCalls[0];
      expect(rows[0]).toHaveLength(columns.length);
      expect(columns.map((c: any) => c.header)).toEqual(
        expect.arrayContaining(["رنگ", "سایز", "مدل", "سایر ویژگی‌ها", "موجودی کل محصول"]),
      );
      // The old bare «موجودی» header is what made a variant's stock read as the
      // product's; it must not survive anywhere in the sheet.
      expect(columns.map((c: any) => c.header)).not.toContain("موجودی");
      expect(rows[0][columns.findIndex((c: any) => c.header === "رنگ")]).toBe("مشکی");
      expect(rows[0][columns.findIndex((c: any) => c.header === "موجودی کل محصول")]).toBe(40);
    });

    it("detail requires a productId", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: {} });
      await controller.productDetail(ctx);
      expect(ctx.badRequest).toHaveBeenCalledWith("productId is required", {
        data: { success: false },
      });
    });
  });

  describe("breakdown", () => {
    const range = { start: "2026-01-01", end: "2026-01-31" };

    it("keeps a gateway that settled nothing visible instead of dropping it", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: range });
      await controller.productBreakdown(ctx);

      const gateways = ctx.body.data.gateways;
      expect(gateways.map((g: any) => g.gateway)).toEqual(["ZarinPal", "Mellat"]);
      const mellat = gateways.find((g: any) => g.gateway === "Mellat");
      // Visibly wrong — 12 orders, zero settled — rather than silently absent.
      expect(mellat).toMatchObject({
        ordersCount: 0,
        totalOrdersCount: 12,
        total: 0,
      });
    });

    it("surfaces a data-quality warning for the unsettled gateway", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: range });
      await controller.productBreakdown(ctx);

      expect(ctx.body.data.dataQualityWarnings).toEqual([
        expect.objectContaining({
          code: "GATEWAY_NO_SETTLED_ORDERS",
          gateway: "Mellat",
          ordersCount: 12,
        }),
      ]);
    });

    it("binds the window for both the CTE and the all-orders query", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: range });
      await controller.productBreakdown(ctx);

      const gatewayCall = (global as any).strapi.db.connection.raw.mock.calls.find(
        ([sql]: [string]) => sql.includes("total_orders_count"),
      );
      expect(gatewayCall).toBeDefined();
      expect(gatewayCall[1]).toHaveLength(4);
    });

    it("keys on the settlement clock by default and reports the distinct paid-order count", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: range });
      await controller.productBreakdown(ctx);

      expect(ctx.body.data.clock).toBe("settlement");
      expect(ctx.body.data.ordersDefinition).toBe("completed");
      // 4 distinct paid orders, not the 4 + 0 per-gateway sum (a split payment
      // would sit under two rows).
      expect(ctx.body.data.totals.ordersCount).toBe(4);
      expect(ctx.body.data.paymentMix).toEqual({
        singleOrdersCount: 4,
        singleTotal: 800_000,
        mixedOrdersCount: 0,
        mixedTotal: 0,
      });
      const gatewayCall = (global as any).strapi.db.connection.raw.mock.calls.find(
        ([sql]: [string]) => sql.includes("total_orders_count"),
      );
      expect(gatewayCall[0]).toContain("HAVING COALESCE(MIN(ct.date)");
    });

    it("switches to the creation clock on clock=order", async () => {
      const controller = loadController();
      const ctx = createCtx({ query: { ...range, clock: "order" } });
      await controller.productBreakdown(ctx);
      expect(ctx.body.data.clock).toBe("order");
      const gatewayCall = (global as any).strapi.db.connection.raw.mock.calls.find(
        ([sql]: [string]) => sql.includes("total_orders_count"),
      );
      expect(gatewayCall[0]).toContain("AND o.date BETWEEN ? AND ?");
    });
  });
});
