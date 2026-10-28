import { summarizeSettledCharges } from "../settledCharges";

describe("summarizeSettledCharges", () => {
  it("sums successful non-return legs in IRR and keeps the latest settlement time", () => {
    expect(
      summarizeSettledCharges([
        { Type: "Gateway", Status: "Success", Amount: 20_000, SettledAt: "2026-09-20T08:30:00.000Z" },
        { Type: "Gateway", Status: "success", Amount: "4000", VerifiedAt: "2026-09-20T08:31:00.000Z" },
        { Type: "Gateway", Status: "Failed", Amount: 20_000 },
        { Type: "Gateway", Status: "Pending", Amount: 20_000 },
        { Type: "Return", Status: "Success", Amount: 5_000 },
        { Type: "Manual", Status: "Success", Amount: 0 },
      ]),
    ).toEqual({ amountIrr: 24_000, settledAt: "2026-09-20T08:31:00.000Z", legCount: 2 });
  });

  it("is empty for missing or malformed input", () => {
    expect(summarizeSettledCharges(undefined)).toEqual({ amountIrr: 0, settledAt: null, legCount: 0 });
    expect(summarizeSettledCharges([{ Status: "Success", Amount: "abc" }])).toEqual({
      amountIrr: 0,
      settledAt: null,
      legCount: 0,
    });
  });
});
