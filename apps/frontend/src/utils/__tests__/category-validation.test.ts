import { buildCategorySlugCandidates } from "../category-validation";

const PERSIAN_CATEGORY = "لباس-مردانه";
const LOWERCASE_WOO_SLUG = encodeURIComponent(PERSIAN_CATEGORY).replace(
  /%[0-9A-Fa-f]{2}/g,
  (match) => match.toLowerCase(),
);

describe("buildCategorySlugCandidates", () => {
  it("matches the lowercase encoded form stored by WooCommerce", () => {
    const { slugs } = buildCategorySlugCandidates(PERSIAN_CATEGORY);

    expect(slugs).toContain(PERSIAN_CATEGORY);
    expect(slugs).toContain(encodeURIComponent(PERSIAN_CATEGORY));
    expect(slugs).toContain(LOWERCASE_WOO_SLUG);
  });

  it("recovers decoded Persian from encoded and double-encoded inputs", () => {
    expect(buildCategorySlugCandidates(LOWERCASE_WOO_SLUG).slugs).toContain(
      PERSIAN_CATEGORY,
    );
    expect(
      buildCategorySlugCandidates(encodeURIComponent(LOWERCASE_WOO_SLUG)).slugs,
    ).toContain(PERSIAN_CATEGORY);
  });

  it("folds Arabic yeh and kaf without dropping ZWNJ", () => {
    const { slugs } = buildCategorySlugCandidates("كیف\u200cمردانه");

    expect(slugs).toContain("کیف\u200cمردانه");
    expect(slugs.some((candidate) => candidate.includes("\u200c"))).toBe(true);
  });

  it("retains the legacy external-id fallback", () => {
    const { slugs, externalId } =
      buildCategorySlugCandidates("لباس-مردانه-1449");

    expect(externalId).toBe("1449");
    expect(slugs).toContain(LOWERCASE_WOO_SLUG);
  });
});
