import { excelMoney, integer, sumIrr, tomanText, tomanToIrr } from "../lib/money";
import { inventorySummary, paymentSummary, splitPaymentControl, stockCountChange, walletSummary } from "../lib/semantics";

describe("integer export money", () => {
  it("keeps IRR exact, converts Toman once, and retains a tenth of a Toman", () => {
    expect(tomanToIrr("123")).toBe(BigInt(1230)); expect(tomanText("1231")).toBe("123.1");
    expect(tomanText("-1")).toBe("-0.1"); expect(excelMoney("1231")).toBe(123.1);
    expect(sumIrr([{ x: "9007199254740993" }, { x: "1" }], "x")).toBe(BigInt("9007199254740994"));
    expect(excelMoney("9007199254740993")).toBe("900719925474099.3");
  });
  it("fails instead of silently rounding unsafe or fractional source amounts", () => {
    expect(() => integer(Number.MAX_SAFE_INTEGER + 1)).toThrow("UNSAFE_REPORT_AMOUNT");
    expect(() => integer("1.5")).toThrow("INVALID_REPORT_AMOUNT");
  });
});
describe("report semantics", () => {
  it("separates wallet refunds from bank cash outflow", () => {
    const result = paymentSummary([
      { provider: "Wallet", kind: "refund", amount_irr: "1501", evidence: "CT" },
      { provider: "Mellat", kind: "charge", amount_irr: "10000", evidence: "CT" },
      { provider: "Mellat", kind: "refund", amount_irr: "2000", evidence: "CT" },
    ]);
    expect(result[0].cash_irr).toBe(BigInt(0));
    expect(result[1].cash_irr + result[2].cash_irr).toBe(BigInt(8000));
  });
  it("includes full ledger credits/debits and manual adjustments separately", () => {
    const [summary] = walletSummary([{ type: "Add", amount_irr: "11", adjustment_id: "1" }, { type: "Minus", amount_irr: "7" }]);
    expect(summary).toMatchObject({ count: 2, credits_irr: BigInt(11), debits_irr: BigInt(7), net_irr: BigInt(4), adjustment_credits_irr: BigInt(11) });
    expect(walletSummary([])[0].net_irr).toBe(BigInt(0));
  });
  it("supports normalized and legacy stock Count changes, leaving invalid evidence unknown", () => {
    expect(stockCountChange([{ field: "Count", from: 3, to: 1 }])).toEqual({ from: 3, to: 1 });
    expect(stockCountChange({ Count: { from: 0, to: 4 } })).toEqual({ from: 0, to: 4 });
    expect(stockCountChange({ Count: { from: null, to: 4 } })).toBeNull();
    expect(stockCountChange([{ field: "Price", from: 3, to: 1 }])).toBeNull();
  });
  it("does not infer opening stock or complete history from a matching closing count", () => {
    const [summary] = inventorySummary([{ variation_id: "1", stock_id: "2", sku: "N", current_count: 3, reserved_count: 1 }], [{ stock_id: "2", type: "Add", count: 3, description: "Stock updated" }], [
      { variation_id: "1", sku: "N", count: 2, reservation_status: "Released" },
      { variation_id: "1", sku: "N", count: 1, reservation_status: "Consumed" },
    ]);
    expect(summary).toMatchObject({ opening: null, available_count: 2, recorded_difference: null, consumed_units: 1 });
    expect(summary.reconciliation).toContain("نامشخص");
  });
  it("records explicitly evidenced opening without counting a duplicate audit movement", () => {
    const [summary] = inventorySummary([{ variation_id: "1", stock_id: "2", current_count: 3, reserved_count: 0 }], [{ stock_id: "2", type: "Add", count: 5, description: "Initial stock" }, { stock_id: "2", type: "Minus", count: 2, description: "Stock updated" }], []);
    expect(summary).toMatchObject({ opening: 5, recorded_delta: 3, recorded_difference: 0 });
  });
  it("never assigns a shared-code order to another or an unknown variation", () => {
    const result = inventorySummary([
      { variation_id: "1", sku: "N", stock_id: "1", current_count: 2 },
      { variation_id: "2", sku: "N", stock_id: "2", current_count: 2 },
    ], [], [{ variation_id: "1", sku: "N", count: 2, reservation_status: "Consumed" }, { variation_id: null, sku: "N", count: 10, reservation_status: "Consumed" }]);
    expect(result.map((row) => row.consumed_units)).toEqual([2, 0]);
  });
  it("keeps legacy manual adjustment rows when audit evidence is unavailable", () => {
    expect(walletSummary([{ type: "Add", cause: "Admin Wallet Adjustment", amount_irr: "100" }])[0].adjustment_credits_irr).toBe(BigInt(100));
  });
  it("does not claim cash timing from the request date of an unmapped successful topup", () => {
    const [row] = paymentSummary([{ provider: "Mellat", kind: "wallet-topup", amount_irr: "100", evidence: "شارژ موفق؛ تاریخ ثبت درخواست" }]);
    expect(row.amount_irr).toBe(BigInt(100)); expect(row.cash_irr).toBeNull();
  });
  it("controls full split funding against the current invoice without money rounding", () => {
    const result = splitPaymentControl({ gross_toman: "180", shipping_toman: "30", discount_toman: "10", wallet_charges_irr: "800", charges_irr: "2000", net_irr: "2000" });
    expect(result).toMatchObject({ invoice_irr: BigInt(2000), control_irr: BigInt(0), wallet_share: "40.0٪", control: "برابر" });
  });
  it("reconciles the synthetic 12-variation 56/53/3 example without assigning unpaid orders to sales", () => {
    // Regression arithmetic only; these are not live n-00119 records.
    const opening = [5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4];
    const sold = [5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 3, 2];
    const variations = opening.map((value, i) => ({ variation_id: String(i), stock_id: String(i), sku: "N-00119", current_count: value - sold[i], reserved_count: 0 }));
    const logs = opening.flatMap((value, i) => [{ stock_id: String(i), type: "Add", count: value, description: "Initial stock" }, { stock_id: String(i), type: "Minus", count: sold[i], description: "Stock updated" }]);
    const orders = [
      ...sold.map((count, i) => ({ variation_id: String(i), sku: "N-00119", count, reservation_status: "Consumed" })),
      ...Array.from({ length: 25 }, (_, i) => ({ variation_id: String(i % 12), sku: "N-00119", count: 9, reservation_status: "Released" })),
    ];
    const result = inventorySummary(variations, logs, orders);
    expect(orders).toHaveLength(37); expect(result).toHaveLength(12);
    expect(result.reduce((sum, row) => sum + row.opening, 0)).toBe(56);
    expect(result.reduce((sum, row) => sum + row.consumed_units, 0)).toBe(53);
    expect(result.reduce((sum, row) => sum + row.current_count, 0)).toBe(3);
    expect(result.every((row) => row.recorded_difference === 0 && row.reconciliation.includes("نامشخص"))).toBe(true);
  });
});
