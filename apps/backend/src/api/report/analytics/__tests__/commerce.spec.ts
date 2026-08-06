import {
  getDailySalesRollupRows,
  getEligibleOrderStats,
  getProductDailyRollupRows,
  upsertDailySalesRows,
  upsertProductDailyRows,
} from "../sources/commerce";

const STUB_JOINS = {
  oiToOrder: "JOIN orders o ON true",
  oiToVariation: { join: "", idExpr: "oi.product_variation_id" },
  orderToContract: "JOIN contracts c ON true",
  contractToTx: "JOIN contract_transactions ct ON true",
  variationToProduct: "JOIN products p ON true",
  variationToStock: "LEFT JOIN product_stocks ps ON true",
  productToCategory: { join: "LEFT JOIN product_categories pc ON true", titleExpr: "pc.title" },
  orderToShipping: "LEFT JOIN shippings s ON true",
} as any;

function fakeKnex(handler: (sql: string, bindings: any[]) => any) {
  const raw = jest.fn(async (sql: string, bindings: any[] = []) => handler(sql, bindings));
  return { raw };
}

describe("analytics commerce source adapter", () => {
  it("getEligibleOrderStats: reads totals with the [start,end,start,end] binding order", async () => {
    const calls: Array<{ sql: string; bindings: any[] }> = [];
    const knex = fakeKnex((sql, bindings) => {
      calls.push({ sql, bindings });
      return { rows: [{ total_orders: "5", eligible_orders: "2" }] };
    });
    const start = new Date("2026-05-01T00:00:00Z");
    const end = new Date("2026-05-31T23:59:59Z");

    const result = await getEligibleOrderStats(knex, STUB_JOINS, start, end);

    expect(result).toEqual({ totalOrders: 5, eligibleOrders: 2 });
    expect(calls[0].bindings).toEqual([start, end, start, end]);
  });

  it("getDailySalesRollupRows: converts IRR refunds to Toman and rounds every figure", async () => {
    const knex = fakeKnex(() => ({
      rows: [
        {
          bucket_date: "2026-05-05",
          gross: "1950000",
          units: "3",
          eligible_orders: "1",
          discounts: "0",
          refund_irr: "0",
          total_orders: "1",
        },
        {
          bucket_date: "2026-05-10",
          gross: "3200000",
          units: "4",
          eligible_orders: "1",
          discounts: "200000",
          refund_irr: "5000000", // -> 500,000 Toman
          total_orders: "1",
        },
      ],
    }));

    const rows = await getDailySalesRollupRows(
      knex,
      STUB_JOINS,
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-31T00:00:00Z"),
    );

    expect(rows).toEqual([
      {
        bucketDate: "2026-05-05",
        grossToman: 1_950_000,
        discountsToman: 0,
        refundsToman: 0,
        netToman: 1_950_000,
        units: 3,
        eligibleOrders: 1,
        totalOrders: 1,
      },
      {
        bucketDate: "2026-05-10",
        grossToman: 3_200_000,
        discountsToman: 200_000,
        refundsToman: 500_000,
        netToman: 2_500_000, // 3,200,000 - 200,000 - 500,000
        units: 4,
        eligibleOrders: 1,
        totalOrders: 1,
      },
    ]);
  });

  it("getDailySalesRollupRows: matches scripts/seed-report-fixtures.js EXPECTED totals for the May window", async () => {
    // Reproduces the fixture's two eligible May orders (901, 902) as a single-day
    // rollup row so the sum matches EXPECTED exactly — this is the Phase 1
    // correctness oracle referenced by docs/analytics/analytics-decisions.md.
    const knex = fakeKnex(() => ({
      rows: [
        {
          bucket_date: "2026-05-05",
          gross: "5150000",
          units: "7",
          eligible_orders: "2",
          discounts: "200000",
          refund_irr: "5000000",
          total_orders: "4",
        },
      ],
    }));

    const [row] = await getDailySalesRollupRows(
      knex,
      STUB_JOINS,
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-31T00:00:00Z"),
    );

    expect(row.grossToman).toBe(5_150_000);
    expect(row.discountsToman).toBe(200_000);
    expect(row.refundsToman).toBe(500_000);
    expect(row.netToman).toBe(4_450_000);
    expect(row.units).toBe(7);
    expect(row.eligibleOrders).toBe(2);
  });

  it("getProductDailyRollupRows: defaults a missing variation id to the 0 sentinel", async () => {
    const knex = fakeKnex(() => ({
      rows: [
        {
          bucket_date: "2026-05-05",
          product_variation_id: null,
          product_sku: "WC-DELETED-1",
          product_title: "محصول حذف‌شده",
          units: "1",
          gross: "800000",
          discounts: "0",
          refund_irr: "0",
          orders_count: "1",
        },
        {
          bucket_date: "2026-05-05",
          product_variation_id: 2,
          product_sku: "WC-617901-1147339",
          product_title: "شلوار مازراتی پیله ای R 00124",
          units: "3",
          gross: "2400000",
          discounts: "50000",
          refund_irr: "1250000",
          orders_count: "1",
        },
      ],
    }));

    const rows = await getProductDailyRollupRows(
      knex,
      STUB_JOINS,
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-31T00:00:00Z"),
    );

    expect(rows[0].productVariationId).toBe(0);
    expect(rows[0].productSku).toBe("WC-DELETED-1");
    expect(rows[1]).toEqual({
      bucketDate: "2026-05-05",
      productVariationId: 2,
      productSku: "WC-617901-1147339",
      productTitle: "شلوار مازراتی پیله ای R 00124",
      units: 3,
      grossToman: 2_400_000,
      discountsToman: 50_000,
      refundsToman: 125_000,
      ordersCount: 1,
    });
  });

  it("upsertDailySalesRows: issues one idempotent ON CONFLICT upsert per row", async () => {
    const calls: Array<{ sql: string; bindings: any[] }> = [];
    const knex = fakeKnex((sql, bindings) => {
      calls.push({ sql, bindings });
      return { rows: [] };
    });

    await upsertDailySalesRows(knex, [
      {
        bucketDate: "2026-05-05",
        grossToman: 1_950_000,
        discountsToman: 0,
        refundsToman: 0,
        netToman: 1_950_000,
        units: 3,
        eligibleOrders: 1,
        totalOrders: 1,
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO analytics_daily_sales");
    expect(calls[0].sql).toContain("ON CONFLICT (bucket_date) DO UPDATE");
    expect(calls[0].bindings).toEqual(["2026-05-05", 1_950_000, 0, 0, 1_950_000, 3, 1, 1]);
  });

  it("upsertProductDailyRows: issues one idempotent ON CONFLICT upsert per row, keyed on the 3-column grain", async () => {
    const calls: Array<{ sql: string; bindings: any[] }> = [];
    const knex = fakeKnex((sql, bindings) => {
      calls.push({ sql, bindings });
      return { rows: [] };
    });

    await upsertProductDailyRows(knex, [
      {
        bucketDate: "2026-05-05",
        productVariationId: 2,
        productSku: "WC-617901-1147339",
        productTitle: "شلوار",
        units: 3,
        grossToman: 2_400_000,
        discountsToman: 50_000,
        refundsToman: 125_000,
        ordersCount: 1,
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO analytics_product_daily");
    expect(calls[0].sql).toContain(
      "ON CONFLICT (bucket_date, product_variation_id, product_sku) DO UPDATE",
    );
    expect(calls[0].bindings).toEqual([
      "2026-05-05",
      2,
      "WC-617901-1147339",
      "شلوار",
      3,
      2_400_000,
      50_000,
      125_000,
      1,
    ]);
  });
});
