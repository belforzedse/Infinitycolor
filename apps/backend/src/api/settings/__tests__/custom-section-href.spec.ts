import { sanitizeCustomSectionHref } from "../services/custom-section-href";

describe("custom section «مشاهده همه» href sanitizer", () => {
  it.each([
    ["", ""],
    ["   ", ""],
    ["/plp", "/plp"],
    ["/plp?hasDiscount=true", "/plp?hasDiscount=true"],
    ["/plp/category/manto", "/plp/category/manto"],
    ["  /plp?x=1  ", "/plp?x=1"],
    [
      "/plp/category/%D9%85%D8%A7%D9%86%D8%AA%D9%88",
      "/plp/category/%D9%85%D8%A7%D9%86%D8%AA%D9%88",
    ],
  ])("accepts %p", (input, expected) => {
    expect(sanitizeCustomSectionHref(input)).toBe(expected);
  });

  it.each([
    ["javascript:alert(1)"],
    ["//evil.com"],
    ["//evil.com/plp"],
    ["https://evil.com"],
    ["http://evil.com/plp"],
    ["plp"],
    ["../plp"],
    ["/plp with space"],
    ["/plp\\evil"],
    ["/plp\nSet-Cookie: x=1"],
  ])("rejects %p", (input) => {
    expect(sanitizeCustomSectionHref(input)).toBeNull();
  });

  it("rejects a control character that \\s does not match", () => {
    expect(sanitizeCustomSectionHref(`/plp${String.fromCharCode(1)}`)).toBeNull();
  });

  it("rejects a path longer than 2048 characters", () => {
    expect(sanitizeCustomSectionHref(`/${"a".repeat(2048)}`)).toBeNull();
  });

  it.each([[null], [undefined], [42], [{}], [["/plp"]], [true]])(
    "rejects the non-string value %p",
    (input) => {
      expect(sanitizeCustomSectionHref(input)).toBeNull();
    },
  );
});
