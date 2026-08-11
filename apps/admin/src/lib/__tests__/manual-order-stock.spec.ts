import { requireManualOrderStockSuccess } from "../manual-order-stock";

it("accepts complete application and idempotent replay", () => {
  expect(
    requireManualOrderStockSuccess({ data: { success: true, applied: true } }),
  ).toMatchObject({ applied: true });
  expect(
    requireManualOrderStockSuccess({ data: { data: { success: true, alreadyApplied: true } } }),
  ).toMatchObject({ alreadyApplied: true });
});

it("rejects legacy partial success and ambiguous 200 responses", () => {
  expect(() =>
    requireManualOrderStockSuccess({
      data: { success: true, partial: true, results: [{ stockId: 1 }] },
    }),
  ).toThrow("MANUAL_STOCK_NOT_APPLIED");
  expect(() => requireManualOrderStockSuccess({ data: { success: true } })).toThrow(
    "MANUAL_STOCK_NOT_APPLIED",
  );
});

it("preserves the backend integrity error code", () => {
  expect(() =>
    requireManualOrderStockSuccess({
      data: {
        success: false,
        errorCode: "MANUAL_STOCK_DECREMENT_FAILED",
        error: "insufficient stock",
      },
    }),
  ).toThrow("MANUAL_STOCK_DECREMENT_FAILED: insufficient stock");
});
