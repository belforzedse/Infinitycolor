import { computePaidAmountToman } from "../paidAmount";

const order = (transactions: any[], overrides: any = {}) => ({
  Status: "Started",
  contract: { Amount: 0, contract_transactions: transactions, ...(overrides.contract || {}) },
  ...overrides,
});

describe("computePaidAmountToman", () => {
  it("treats transaction Amount as already net of discount", () => {
    // subtotal 1,200,000 T, discount 200,000 T, shipping 0
    // => computeTotals total = 1,000,000 T => Amount = 10,000,000 IRR
    // DiscountAmount is informational; subtracting it again under-refunds.
    expect(
      computePaidAmountToman(
        order([
          {
            Type: "Gateway",
            Status: "Success",
            Amount: 10_000_000,
            DiscountAmount: 2_000_000,
          },
        ]),
      ),
    ).toBe(1_000_000);
  });

  it("nets a full refund to zero so the order leaves the paid-sales population", () => {
    expect(
      computePaidAmountToman(
        order([
          {
            Type: "Gateway",
            Status: "Success",
            Amount: 10_000_000,
            DiscountAmount: 2_000_000,
          },
          { Type: "Return", Status: "Success", Amount: 10_000_000 },
        ]),
      ),
    ).toBe(0);
  });

  it("subtracts partial refunds", () => {
    expect(
      computePaidAmountToman(
        order([
          { Type: "Gateway", Status: "Success", Amount: 10_000_000 },
          { Type: "Return", Status: "Success", Amount: 4_000_000 },
        ]),
      ),
    ).toBe(600_000);
  });

  it("ignores failed gateway transactions", () => {
    expect(
      computePaidAmountToman(
        order([
          { Type: "Gateway", Status: "Failed", Amount: 10_000_000 },
          { Type: "Gateway", Status: "Success", Amount: 5_000_000 },
        ]),
      ),
    ).toBe(500_000);
  });

  it("returns zero while the order is still Paying", () => {
    expect(
      computePaidAmountToman({
        Status: "Paying",
        contract: {
          Amount: 999_999,
          contract_transactions: [
            { Type: "Gateway", Status: "Success", Amount: 10_000_000 },
          ],
        },
      }),
    ).toBe(0);
  });

  it("falls back to the contract amount when no transactions exist", () => {
    expect(
      computePaidAmountToman({
        Status: "Started",
        contract: { Amount: 750_000, contract_transactions: [] },
      }),
    ).toBe(750_000);
  });
});
