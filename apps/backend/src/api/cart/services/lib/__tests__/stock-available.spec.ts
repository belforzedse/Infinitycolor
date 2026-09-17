/**
 * Available stock must subtract reservations under every key shape cart/checkout
 * may see (schema camelCase, legacy PascalCase, and knex snake_case).
 */
import { getAvailableStockCount, validateAndNormalizeStock } from "../stock";

describe("validateAndNormalizeStock / getAvailableStockCount", () => {
  it("reads Strapi schema keys Count + reservedCount", () => {
    const result = validateAndNormalizeStock({ Count: 5, reservedCount: 2 });
    expect(result).toEqual({
      isValid: true,
      stock: { Count: 5, ReservedCount: 2 },
    });
    expect(getAvailableStockCount({ Count: 5, reservedCount: 2 })).toBe(3);
  });

  it("reads DB/knex lowercase keys count + reserved_count", () => {
    const result = validateAndNormalizeStock({ count: 4, reserved_count: 1 });
    expect(result).toEqual({
      isValid: true,
      stock: { Count: 4, ReservedCount: 1 },
    });
    expect(getAvailableStockCount({ count: 4, reserved_count: 1 })).toBe(3);
  });

  it("reads legacy ReservedCount and mixed key shapes", () => {
    expect(
      validateAndNormalizeStock({ Count: 3, ReservedCount: 1 }),
    ).toEqual({
      isValid: true,
      stock: { Count: 3, ReservedCount: 1 },
    });
    expect(getAvailableStockCount({ Count: 10, reserved_count: 3 })).toBe(7);
    expect(getAvailableStockCount({ count: 8, reservedCount: 2 })).toBe(6);
  });

  it("treats a fully reserved last unit as unavailable", () => {
    expect(getAvailableStockCount({ Count: 1, reservedCount: 1 })).toBe(0);
    expect(getAvailableStockCount({ count: 1, reserved_count: 1 })).toBe(0);
  });

  it("defaults missing reserved to 0 and clamps negative availability", () => {
    expect(getAvailableStockCount({ Count: 2 })).toBe(2);
    expect(getAvailableStockCount({ Count: 1, reservedCount: 5 })).toBe(0);
  });

  it("returns 0 for invalid or missing stock", () => {
    expect(getAvailableStockCount(null)).toBe(0);
    expect(getAvailableStockCount(undefined)).toBe(0);
    expect(getAvailableStockCount({ Count: -1 } as any)).toBe(0);
  });
});
