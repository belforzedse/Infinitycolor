import { CART_STOCK_LIMIT_MESSAGE, isCartStockLimitError } from "../cartStock";

describe("cart stock errors", () => {
  it("recognizes the structured stock error contract", () => {
    expect(
      isCartStockLimitError({
        message: "Request failed",
        errorCode: "CART_STOCK_EXCEEDED",
      }),
    ).toBe(true);
  });

  it.each(["Not enough stock", "Insufficient stock for requested quantity"])(
    "keeps compatibility with the legacy backend message: %s",
    (message) => {
      expect(isCartStockLimitError({ message })).toBe(true);
    },
  );

  it("does not turn unrelated cart failures into a stock message", () => {
    expect(isCartStockLimitError({ message: "Network error" })).toBe(false);
    expect(CART_STOCK_LIMIT_MESSAGE).toBe("موجودی بیشتری از این کالا در دسترس نیست.");
  });
});
