import { getCategoryPlpHref, isActiveNavHref } from "../plpRoutes";

describe("isActiveNavHref", () => {
  it("does not treat Oppsi or discounts as the bare product list", () => {
    expect(isActiveNavHref("/plp?search=Oppsi", "/plp")).toBe(false);
    expect(isActiveNavHref("/plp?hasDiscount=true", "/plp")).toBe(false);
    expect(isActiveNavHref("/plp", "/plp")).toBe(true);
  });

  it("lights the matching query destination only", () => {
    expect(isActiveNavHref("/plp?search=Oppsi", "/plp", "search=Oppsi")).toBe(true);
    expect(isActiveNavHref("/plp?hasDiscount=true", "/plp", "search=Oppsi")).toBe(false);
    expect(isActiveNavHref("/plp?hasDiscount=true", "/plp", "hasDiscount=true")).toBe(true);
    expect(isActiveNavHref("/plp?search=Oppsi", "/plp", "hasDiscount=true")).toBe(false);
  });

  it("keeps category paths distinct from /plp", () => {
    expect(isActiveNavHref(getCategoryPlpHref("dress"), "/plp")).toBe(false);
    expect(isActiveNavHref(getCategoryPlpHref("dress"), "/plp/category/dress")).toBe(true);
  });

  it("reads query from URLSearchParams without throwing on empty search", () => {
    expect(isActiveNavHref("/plp?hasDiscount=true", "/plp", new URLSearchParams("hasDiscount=true"))).toBe(
      true,
    );
    expect(isActiveNavHref("/plp?hasDiscount=true", "/plp", null)).toBe(false);
  });
});
