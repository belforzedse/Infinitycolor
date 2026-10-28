const resolveJoinsMock = jest.fn();
jest.mock("../../report/services/product-analytics", () => ({ ...jest.requireActual("../../report/services/product-analytics"), resolveJoins: (...args: any[]) => resolveJoinsMock(...args) }));
import { joins } from "./fixtures";
import { loadReportData, utcBindings } from "../services/report-export";
import { parseExportFilters } from "../lib/filters";

describe("order report calculation", () => {
  beforeEach(() => resolveJoinsMock.mockResolvedValue(joins));
  it("converts stored Toman once and keeps order totals out of item rows", async () => {
    const knex = { raw: jest.fn().mockResolvedValueOnce({ rows: [{ id: "1", status: "Started", gross_toman: "200", shipping_toman: "40", discount_toman: "20", units: "2", charges_irr: "2201", refunds_irr: "1", net_irr: "2200" }] }).mockResolvedValueOnce({ rows: [{ id: "2", order_id: "1", count: 2, price_toman: "100", gross_toman: "200" }] }) };
    const data = await loadReportData(knex, "orders", parseExportFilters("orders", { start: "2026-09-14", end: "2026-09-14" }));
    expect(data.rowCount).toBe(2);
    expect(data.sheets[0].rows[0]).toMatchObject({ gross_irr: BigInt(2000), shipping_irr: BigInt(400), discount_irr: BigInt(200), total_irr: BigInt(2200), net_irr: BigInt(2200) });
    const item = data.sheets[2].rows[0]; expect(item.price_irr).toBe(BigInt(1000)); expect(item.gross_irr).toBe(BigInt(2000));
    expect(item.total_irr).toBeUndefined(); expect(item.shipping_irr).toBeUndefined();
  });
  it("rejects when two otherwise valid detail sheets exceed the combined limit", async () => {
    const knex = { raw: jest.fn().mockResolvedValueOnce({ rows: new Array(12501).fill({}) }).mockResolvedValueOnce({ rows: new Array(12500).fill({}) }) };
    await expect(loadReportData(knex, "orders", parseExportFilters("orders", { start: "2026-09-14", end: "2026-09-14" }))).rejects.toMatchObject({ code: "REPORT_TOO_LARGE", status: 413 });
  });
  it("binds UTC strings regardless of the Node process timezone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Asia/Tehran";
      const filters = parseExportFilters("orders", { start: "2026-10-01", end: "2026-10-01" });
      expect(utcBindings([filters.startAt, filters.endExclusive])).toEqual(["2026-09-30T20:30:00.000Z", "2026-10-01T20:30:00.000Z"]);
    } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
  });
  it("counts customers and orders once across multiple selected product codes", async () => {
    const knex = { raw: jest.fn().mockResolvedValue({ rows: [
      { order_id: "1", customer_id: "1", sku: "A", count: 1, price_toman: "1", gross_toman: "1", status: "Started" },
      { order_id: "1", customer_id: "1", sku: "B", count: 1, price_toman: "2", gross_toman: "2", status: "Started" },
    ] }) };
    const data = await loadReportData(knex, "product-buyers", parseExportFilters("product-buyers", { start: "2026-09-14", end: "2026-09-14", productCodes: "A,B" }));
    expect(data.sheets[0].rows[0]).toMatchObject({ orders: 1, customers: 1, units: 2, gross_irr: BigInt(30) });
    expect(data.sheets[1].rows.map((row) => row.orders)).toEqual([1, 1]);
  });
  it("lists complete, partial and unknown wallet funding without adding it twice to ledger totals", async () => {
    const knex = { raw: jest.fn().mockResolvedValueOnce({ rows: [{ id: "1", type: "Minus", amount_irr: "4000", order_id: "1" }] }).mockResolvedValueOnce({ rows: [
      { order_id: "1", wallet_charges_irr: "4000", other_charges_irr: "6000" },
      { order_id: "2", wallet_charges_irr: "10000", other_charges_irr: "0" },
      { order_id: "3", wallet_charges_irr: null, other_charges_irr: null },
    ] }) };
    const data = await loadReportData(knex, "wallet", parseExportFilters("wallet", { start: "2026-09-14", end: "2026-09-14" }));
    expect(data.rowCount).toBe(4);
    expect(data.sheets[0].rows[0]).toMatchObject({ debits_irr: BigInt(4000), net_irr: BigInt(-4000) });
    expect(data.sheets[3].rows.map((row) => row.payment_kind)).toEqual(["بخشی با کیف پول", "کامل با کیف پول", "نامشخص"]);
  });
  it("exports detached inventory snapshots without treating unknown stock as zero", async () => {
    const knex = { raw: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ order_id: "1", sku: "OLD", title: "نام تاریخی", count: 2, variation_id: null }] }) };
    const data = await loadReportData(knex, "inventory-history", parseExportFilters("inventory-history", { productCode: "OLD" }));
    expect(data.rowCount).toBe(1);
    expect(data.sheets[0].rows[0]).toMatchObject({ product_id: "نامشخص", current: null, reserved: null, available: null });
    expect(data.sheets[1].rows[0]).toMatchObject({ title: "نام تاریخی", variation_id: "نامشخص" });
  });
});
