import { isCanonicalCuratedView, CURATED_SECTION_SETTINGS_FIELD } from "../services/product";
import type { FindProductCardsParams } from "../services/product-card-query";

describe("isCanonicalCuratedView", () => {
  it("maps each curated section to its settings field", () => {
    expect(CURATED_SECTION_SETTINGS_FIELD).toEqual({
      newest: "homeNewestProductIds",
      popular: "homeFavoriteProductIds",
      discount: "homeDiscountedProductIds",
    });
  });

  it("matches the exact unfiltered default view for each section", () => {
    expect(isCanonicalCuratedView("newest", { sort: "LastEditedByAdminAt:desc" })).toBe(true);
    expect(isCanonicalCuratedView("popular", { sort: "AverageRating:desc" })).toBe(true);
    expect(isCanonicalCuratedView("discount", { hasDiscount: "true" })).toBe(true);
  });

  it("matches Strapi's actual array-form sort (`sort[0]=X` parses to `sort: [X]`)", () => {
    // This is what the request genuinely looks like once it reaches the controller --
    // plp.ts sends `sort[0]=LastEditedByAdminAt:desc`, and Strapi's qs parser turns that
    // into an array, never a bare string. A check that only accepted a string here would
    // silently never match a real request and disable curation entirely.
    expect(isCanonicalCuratedView("newest", { sort: ["LastEditedByAdminAt:desc"] })).toBe(true);
    expect(isCanonicalCuratedView("popular", { sort: ["AverageRating:desc"] })).toBe(true);
    expect(isCanonicalCuratedView("newest", { sort: ["AverageRating:desc"] })).toBe(false);
  });

  it("rejects a section/query mismatch", () => {
    expect(isCanonicalCuratedView("newest", { sort: "AverageRating:desc" })).toBe(false);
    expect(isCanonicalCuratedView("popular", { sort: "LastEditedByAdminAt:desc" })).toBe(false);
    expect(isCanonicalCuratedView("discount", {})).toBe(false);
    expect(isCanonicalCuratedView("unknown-section", { sort: "LastEditedByAdminAt:desc" })).toBe(
      false,
    );
  });

  it("drops curation once hasDiscount is combined with a non-discount section's sort", () => {
    expect(
      isCanonicalCuratedView("popular", { sort: "AverageRating:desc", hasDiscount: "true" }),
    ).toBe(false);
    expect(
      isCanonicalCuratedView("discount", { hasDiscount: "true", sort: "AverageRating:desc" }),
    ).toBe(false);
  });

  it("drops curation once the shopper touches availability or price", () => {
    const base: FindProductCardsParams = { sort: "LastEditedByAdminAt:desc" };
    expect(isCanonicalCuratedView("newest", { ...base, availability: "available" })).toBe(false);
    expect(isCanonicalCuratedView("newest", { ...base, price: { min: "1000" } })).toBe(false);
    expect(isCanonicalCuratedView("newest", { ...base, price: { max: "1000" } })).toBe(false);
    expect(isCanonicalCuratedView("newest", { ...base, price: {} })).toBe(true);
  });
});
