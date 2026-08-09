/**
 * Phase 2 slug-resolution contract tests for the PDP.
 *
 * Pins the Y00574 class of failures at the storefront boundary: historical
 * percent-encoded imports must canonicalize to the decoded Persian slug, ZWNJ
 * must be preserved, and numeric IDs must stay under proxy ownership. Backend
 * candidate-set coverage lives in productSlugCandidates.spec.ts /
 * product-by-slug.spec.ts.
 */

import {
  buildCanonicalPdpPath,
  canonicalProductSlug,
  shouldRedirectToCanonicalSlug,
} from "@/utils/productSlug";

const Y00574_PERSIAN = "ست-تاپ-و-دامن-فلامنت-y00574";
const Y00574_ENCODED =
  "%d8%b3%d8%aa-%d8%aa%d8%a7%d9%be-%d9%88-%d8%af%d8%a7%d9%85%d9%86-%d9%81%d9%84%d8%a7%d9%85%d9%86%d8%aa-y00574";

describe("PDP slug resolution (Y00574 class)", () => {
  it("canonicalizes the live W00238 slug regression", () => {
    const persian = "کت-آدلینا-w00238";
    const encoded = "%da%a9%d8%aa-%d8%a2%d8%af%d9%84%db%8c%d9%86%d8%a7-w00238";

    expect(canonicalProductSlug(encoded)).toBe(persian);
    expect(buildCanonicalPdpPath(encoded)).toBe(`/pdp/${encodeURIComponent(persian)}`);
  });

  it("canonicalizes Y00574's encoded historical slug to Persian", () => {
    expect(canonicalProductSlug(Y00574_ENCODED)).toBe(Y00574_PERSIAN);
    expect(buildCanonicalPdpPath(Y00574_ENCODED)).toBe(
      `/pdp/${encodeURIComponent(Y00574_PERSIAN)}`,
    );
  });

  it("does not bounce an already-canonical Persian URL", () => {
    expect(shouldRedirectToCanonicalSlug(Y00574_PERSIAN, Y00574_PERSIAN)).toBe(false);
    // Pre-repair: request is Persian while Strapi still stores encoded — stay put.
    expect(shouldRedirectToCanonicalSlug(Y00574_PERSIAN, Y00574_ENCODED)).toBe(false);
  });

  it("does not self-redirect an encoded Next.js route parameter after repair", () => {
    expect(shouldRedirectToCanonicalSlug(Y00574_ENCODED, Y00574_PERSIAN)).toBe(false);
  });

  it("preserves ZWNJ in the canonical slug", () => {
    const withZwnj = "دامن\u200cکوتاه-zwnj-test";
    expect(canonicalProductSlug(withZwnj)).toBe(withZwnj);
    expect(shouldRedirectToCanonicalSlug(withZwnj, withZwnj)).toBe(false);
  });

  it("leaves Arabic yeh/kaf as stored (folding is lookup-only on the API)", () => {
    const arabicYeh = "كييف";
    expect(canonicalProductSlug(arabicYeh)).toBe(arabicYeh);
  });

  it("never redirects numeric ID URLs from the page (proxy owns /pdp/123)", () => {
    expect(shouldRedirectToCanonicalSlug("2833", Y00574_PERSIAN)).toBe(false);
  });

  it("treats a nonexistent/empty slug as having no redirect target", () => {
    expect(shouldRedirectToCanonicalSlug("definitely-not-a-real-product-zzz999", "")).toBe(false);
  });
});
