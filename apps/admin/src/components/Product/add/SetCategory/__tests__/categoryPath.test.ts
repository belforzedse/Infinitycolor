import { categoryMatchesQuery, categoryPathLabel } from "../categoryPath";
import type { categoryResponseType } from "@/services/super-admin/product/category/getAll";

const withParent = (
  id: number,
  title: string,
  slug: string,
  parent?: string,
): categoryResponseType =>
  ({
    id,
    attributes: {
      Title: title,
      Slug: slug,
      parent: parent ? { data: { id: 1, attributes: { Title: parent } } } : null,
    },
  }) as categoryResponseType;

/**
 * The product-category picker disambiguated options with the raw slug, which is
 * a routing detail staff do not think in. The owner asked for the hierarchy to
 * be visible when assigning categories, so options carry a parent path instead.
 */
describe("categoryPathLabel", () => {
  it("shows where a nested category sits", () => {
    expect(categoryPathLabel(withParent(2, "سوتین اسفنجی", "padded-bra", "لباس زیر"))).toBe(
      "لباس زیر › سوتین اسفنجی",
    );
  });

  it("returns nothing for a top-level category", () => {
    expect(categoryPathLabel(withParent(1, "لباس زیر", "underwear"))).toBeNull();
  });
});

describe("categoryMatchesQuery", () => {
  const child = withParent(2, "سوتین اسفنجی", "padded-bra", "لباس زیر");

  it("matches on the category's own name", () => {
    expect(categoryMatchesQuery(child, "سوتین")).toBe(true);
  });

  it("matches on the parent's name, so a section finds what sits under it", () => {
    expect(categoryMatchesQuery(child, "لباس زیر")).toBe(true);
  });

  it("still matches on the slug", () => {
    expect(categoryMatchesQuery(child, "padded")).toBe(true);
  });

  it("is case-insensitive and ignores surrounding space", () => {
    expect(categoryMatchesQuery(child, "  PADDED  ")).toBe(true);
  });

  it("returns everything for an empty query", () => {
    expect(categoryMatchesQuery(child, "   ")).toBe(true);
  });

  it("rejects a non-match", () => {
    expect(categoryMatchesQuery(child, "کفش")).toBe(false);
  });
});
