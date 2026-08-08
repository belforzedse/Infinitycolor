import {
  buildCanonicalPdpPath,
  canonicalProductSlug,
  safeDecodeProductSlug,
  shouldRedirectToCanonicalSlug,
} from "../productSlug";

const PERSIAN = "ست-تاپ-و-دامن-فلامنت-y00574";
const ENCODED = "%d8%b3%d8%aa-%d8%aa%d8%a7%d9%be-%d9%88-%d8%af%d8%a7%d9%85%d9%86-%d9%81%d9%84%d8%a7%d9%85%d9%86%d8%aa-y00574";

describe("productSlug helpers", () => {
  it("decodes Y00574's percent-encoded historical slug", () => {
    expect(safeDecodeProductSlug(ENCODED)).toBe(PERSIAN);
    expect(canonicalProductSlug(ENCODED)).toBe(PERSIAN);
  });

  it("leaves a clean Persian slug unchanged", () => {
    expect(canonicalProductSlug(PERSIAN)).toBe(PERSIAN);
  });

  it("preserves ZWNJ inside a slug", () => {
    const withZwnj = "دامن\u200cکوتاه";
    expect(canonicalProductSlug(withZwnj)).toBe(withZwnj);
  });

  it("redirects literal encoded route segments to the canonical form", () => {
    expect(shouldRedirectToCanonicalSlug(ENCODED, ENCODED)).toBe(true);
    expect(shouldRedirectToCanonicalSlug(ENCODED, PERSIAN)).toBe(true);
    expect(buildCanonicalPdpPath(ENCODED)).toBe(`/pdp/${encodeURIComponent(PERSIAN)}`);
  });

  it("does not redirect when the route is already canonical", () => {
    expect(shouldRedirectToCanonicalSlug(PERSIAN, PERSIAN)).toBe(false);
    // Pre-repair: storefront requests Persian while Strapi still stores encoded.
    // Serving the Persian URL is correct — do not bounce to the encoded form.
    expect(shouldRedirectToCanonicalSlug(PERSIAN, ENCODED)).toBe(false);
  });

  it("never redirects numeric ID URLs (proxy owns those)", () => {
    expect(shouldRedirectToCanonicalSlug("2833", PERSIAN)).toBe(false);
  });
});
