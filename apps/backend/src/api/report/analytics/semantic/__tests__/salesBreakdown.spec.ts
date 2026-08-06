import { getSalesBreakdown, SALES_BREAKDOWN_DIMENSIONS } from "../salesBreakdown";

const STUB_JOINS = {
  oiToOrder: "JOIN orders o ON true",
  oiToVariation: { join: "", idExpr: "oi.product_variation_id" },
  orderToContract: "JOIN contracts c ON true",
  contractToTx: "JOIN contract_transactions ct ON true",
  variationToProduct: "JOIN products p ON true",
  variationToStock: "LEFT JOIN product_stocks ps ON true",
  productToCategory: { join: "LEFT JOIN product_categories pc ON true", titleExpr: "pc.title" },
  orderToShipping: "LEFT JOIN shippings s ON true",
  orderToUser: "LEFT JOIN users u ON true",
  userToInfo: "LEFT JOIN local_user_infos ui ON true",
  orderToAddress: "LEFT JOIN local_user_addresses a ON true",
  addressToCity: "LEFT JOIN shipping_cities sc ON true",
  cityToProvince: "LEFT JOIN shipping_provinces sp ON true",
} as any;

function fakeKnex(rows: any[]) {
  const calls: Array<{ sql: string; bindings: any[] }> = [];
  const raw = jest.fn(async (sql: string, bindings: any[] = []) => {
    calls.push({ sql, bindings });
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

  it("status: groups ALL orders (not just eligible ones) and binds [start,end,start,end]", async () => {
    const { knex, calls } = fakeKnex([
      { status: "Done", orders_count: "3", units: "5", gross: "1500000", discounts: "0", refund_irr: "0" },
      { status: "Cancelled", orders_count: "2", units: "0", gross: "0", discounts: "0", refund_irr: "0" },
    ]);

    const result = await getSalesBreakdown(knex, STUB_JOINS, "status", start, end);

    expect(calls[0].bindings).toEqual([start, end, start, end]);
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
    expect(calls[0].bindings).toEqual([start, end]);
    expect(result.rows[0].label).toBe("بدون دسته‌بندی");
    expect(result.rows[0].key).toBe("");
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
    expect(result).toEqual({ dimension: "customer", rows: [], truncated: false });
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
    expect(result).toEqual({ dimension: "geography", rows: [], truncated: false });
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
