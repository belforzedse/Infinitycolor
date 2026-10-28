import { describe, it, expect } from "@jest/globals";
import { chargeableVariationPrice } from "../productAvailability";

describe("chargeableVariationPrice", () => {
  it("charges the discount only when it is above zero and below the base price", () => {
    expect(chargeableVariationPrice({ Price: "3499000", DiscountPrice: "2999000" })).toBe(2999000);
    expect(chargeableVariationPrice({ Price: "3499000", DiscountPrice: null })).toBe(3499000);
    // A stray 0 discount sold 10 units for nothing (order 113615).
    expect(chargeableVariationPrice({ Price: "1999000", DiscountPrice: "0" })).toBe(1999000);
    expect(chargeableVariationPrice({ Price: 1999000, DiscountPrice: 2500000 })).toBe(1999000);
  });

  it("returns 0 for a variation that has no price, whatever its discount", () => {
    // Postgres bigints arrive as strings; "0" is truthy.
    expect(chargeableVariationPrice({ Price: "0", DiscountPrice: null })).toBe(0);
    expect(chargeableVariationPrice({ Price: null, DiscountPrice: "5000" })).toBe(0);
    expect(chargeableVariationPrice(undefined)).toBe(0);
  });
});
