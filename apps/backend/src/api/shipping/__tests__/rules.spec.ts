import {
  evaluateShippingMethod,
  shippingRuleMatches,
  validateShippingRulesConfig,
  type ShippingContext,
} from "../services/rules";

const baseContext: ShippingContext = {
  subtotal: 120000,
  quantity: 3,
  weight: 900,
  provinceId: 1,
  cityId: 10,
  roleTypes: ["customer"],
  productIds: [100, 101],
  categoryIds: [20],
};

describe("shipping rules", () => {
  it("uses base price when no active rules exist", () => {
    const result = evaluateShippingMethod({ Price: 69000, Rules: [] }, baseContext);

    expect(result).toEqual({
      eligible: true,
      price: 69000,
      matchedRule: null,
    });
  });

  it("matches city and province restrictions", () => {
    const result = evaluateShippingMethod(
      {
        Price: 79000,
        Rules: [
          {
            id: "local",
            active: true,
            priority: 10,
            provinceIds: [1],
            cityIds: [10],
            price: 25000,
          },
        ],
      },
      baseContext,
    );

    expect(result.eligible).toBe(true);
    expect(result.price).toBe(25000);
    expect(result.matchedRule?.id).toBe("local");
  });

  it("rejects excluded province and city restrictions", () => {
    const result = evaluateShippingMethod(
      {
        Price: 79000,
        Rules: [
          {
            id: "blocked-location",
            active: true,
            excludedProvinceIds: [1],
            excludedCityIds: [10],
            price: 25000,
          },
        ],
      },
      baseContext,
    );

    expect(result.eligible).toBe(false);
  });

  it("keeps methods eligible when excluded locations do not match", () => {
    const result = evaluateShippingMethod(
      {
        Price: 79000,
        Rules: [
          {
            id: "other-location-block",
            active: true,
            excludedProvinceIds: [2],
            excludedCityIds: [20],
            price: 25000,
          },
        ],
      },
      baseContext,
    );

    expect(result.eligible).toBe(true);
    expect(result.price).toBe(25000);
    expect(result.matchedRule?.id).toBe("other-location-block");
  });

  it("rejects methods when active rules exist but none match", () => {
    const result = evaluateShippingMethod(
      {
        Price: 25000,
        Rules: [{ active: true, provinceIds: [2], cityIds: [20], price: 25000 }],
      },
      baseContext,
    );

    expect(result.eligible).toBe(false);
  });

  it("uses highest priority matching rule", () => {
    const result = evaluateShippingMethod(
      {
        Price: 50000,
        Rules: [
          { id: "low", active: true, priority: 1, minSubtotal: 10000, price: 40000 },
          { id: "high", active: true, priority: 20, minSubtotal: 10000, price: 10000 },
        ],
      },
      baseContext,
    );

    expect(result.price).toBe(10000);
    expect(result.matchedRule?.id).toBe("high");
  });

  it("applies free shipping threshold after rule price", () => {
    const result = evaluateShippingMethod(
      {
        Price: 50000,
        Rules: [
          {
            active: true,
            priority: 1,
            minSubtotal: 10000,
            price: 25000,
            freeShippingThreshold: 100000,
          },
        ],
      },
      baseContext,
    );

    expect(result.price).toBe(0);
  });

  it("matches role, product, category, quantity and weight rules", () => {
    const rule = validateShippingRulesConfig([
      {
        active: true,
        minQuantity: 2,
        maxQuantity: 5,
        minWeight: 500,
        maxWeight: 1000,
        roleTypes: ["customer"],
        productIds: [101],
        categoryIds: [20],
      },
    ])[0];

    expect(shippingRuleMatches(rule, baseContext)).toBe(true);
  });

  it("keeps inactive rules saved but ignored", () => {
    const result = evaluateShippingMethod(
      {
        Price: 50000,
        Rules: [{ active: false, priority: 99, price: 0 }],
      },
      baseContext,
    );

    expect(result.eligible).toBe(true);
    expect(result.price).toBe(50000);
  });

  it("rejects invalid rule ranges and negative prices", () => {
    expect(() =>
      validateShippingRulesConfig([{ active: true, minSubtotal: 10, maxSubtotal: 1 }]),
    ).toThrow(/invalid subtotal range/);
    expect(() => validateShippingRulesConfig([{ active: true, price: -1 }])).toThrow(
      /negative price/,
    );
  });
});
