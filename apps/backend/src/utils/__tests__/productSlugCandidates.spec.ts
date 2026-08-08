import {
  buildProductSlugCandidates,
  encodeSlugLower,
  foldArabicToPersian,
  safeDecodeSlug,
} from "../productSlugCandidates";

describe("buildProductSlugCandidates", () => {
  const persian = "ست-تاپ-و-دامن-فلامنت-y00574";
  /** How WooCommerce / the catalog importer stored 1402 production slugs. */
  const storedEncoded = encodeSlugLower(persian);

  it("includes both the decoded Persian form and the lowercase-encoded form", () => {
    const candidates = buildProductSlugCandidates(persian);
    expect(candidates).toContain(persian);
    expect(candidates).toContain(storedEncoded);
  });

  it("finds the stored encoded slug when the inbound value is already decoded", () => {
    // This is the storefront case: Koa has decoded the path segment.
    const candidates = buildProductSlugCandidates(persian);
    expect(candidates).toContain(storedEncoded);
  });

  it("finds the decoded form when the inbound value is the stored encoded slug", () => {
    // Request path was /pdp/%d8%b3… and something handed us the literal.
    const candidates = buildProductSlugCandidates(storedEncoded);
    expect(candidates).toContain(persian);
    expect(candidates).toContain(storedEncoded);
  });

  it("handles double-encoded inbound values", () => {
    const doubleEncoded = encodeURIComponent(storedEncoded);
    const candidates = buildProductSlugCandidates(doubleEncoded);
    expect(candidates).toContain(persian);
    expect(candidates).toContain(storedEncoded);
  });

  it("folds Arabic yeh/kaf to Persian forms in the candidate set only", () => {
    // Arabic ي (U+064A) instead of Persian ی (U+06CC)
    const arabicYeh = persian.replace("فلامنت", "فلامن\u064A");
    const candidates = buildProductSlugCandidates(arabicYeh);
    expect(candidates).toContain(foldArabicToPersian(arabicYeh.normalize("NFC")));
  });

  it("deduplicates while preserving order", () => {
    const candidates = buildProductSlugCandidates("simple-slug");
    expect(candidates).toEqual([...new Set(candidates)]);
    expect(candidates[0]).toBe("simple-slug");
  });

  it("safeDecodeSlug never throws on malformed percent-encoding", () => {
    expect(safeDecodeSlug("%E0%A4%A")).toBe("%E0%A4%A");
  });
});
