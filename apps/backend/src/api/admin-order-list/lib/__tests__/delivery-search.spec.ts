import latinCase from "../../../../../database/order-search-latin-case.json";
import {
  normalizeOrderAddress,
  normalizeOrderPostal,
  normalizeOrderSku,
  parseDeliverySearch,
} from "../delivery-search";
const context = () => ({ badRequest: jest.fn() });

describe("order delivery search validation", () => {
  it("preserves exact SKU case, internal spaces, and leading zeroes", () => {
    expect(normalizeOrderSku("  Ab-۰۰۱  ٢  ")).toBe("Ab-001  2");
    expect(normalizeOrderSku("A\u0301-01")).toBe("Á-01");
  });
  it("normalizes Arabic letters, compatibility characters, digits and separators in addresses", () => {
    expect(normalizeOrderAddress("  خيابان\u200cكاشاني   ＡＢＣ ۱۲  ")).toBe(
      "خیابان کاشانی abc 12",
    );
    expect(normalizeOrderPostal("۰۱۲۳۴ - ٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeOrderAddress("CAFÉ Étage")).toBe("café étage");
    expect(normalizeOrderAddress("Ā Œ İ")).toBe("ā œ i\u0307");
    expect(normalizeOrderSku("Ā Œ İ CAFÉ")).toBe("Ā Œ İ CAFÉ");
  });
  it("uses the pinned Unicode Latin table after compatibility normalization", () => {
    const upper = latinCase.upper + latinCase.multiple.map(([value]) => value).join("");
    expect(normalizeOrderAddress(upper)).toBe(
      upper.normalize("NFKC").replace(/\p{Script=Latin}/gu, (letter) => letter.toLowerCase()),
    );
  });
  it("combines valid filters without losing leading-zero postal codes", () => {
    expect(
      parseDeliverySearch(context(), {
        cityId: "۱۲",
        productCode: " Aa  ۰۱ ",
        postalCode: "۰۱۲۳۴-۵۶۷۸۹",
        addressText: "خيابان كاشاني",
      }),
    ).toEqual({
      cityId: 12,
      productCode: "Aa  01",
      postalCode: "0123456789",
      addressText: "خیابان کاشانی",
    });
  });
  it.each([
    { cityId: -1 },
    { cityId: "1e3" },
    { cityId: [] },
    { postalCode: "012345678x" },
    { postalCode: "123" },
    { productCode: {} },
    { productCode: "x".repeat(256) },
    { addressText: "ab" },
    { addressText: "x".repeat(201) },
  ])("rejects malformed criteria %j", (input) => {
    const ctx = context();
    expect(parseDeliverySearch(ctx, input)).toBeNull();
    expect(ctx.badRequest).toHaveBeenCalledTimes(1);
  });
  it("ignores empty optional filters", () => {
    expect(
      parseDeliverySearch(context(), {
        cityId: "",
        productCode: "  ",
        postalCode: "",
        addressText: "",
      }),
    ).toEqual({});
  });
});
