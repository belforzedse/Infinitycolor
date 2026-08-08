/**
 * Regression tests for on-demand revalidation.
 *
 * The failure this guards against is silent: `revalidatePath` and
 * `revalidateTag` resolve successfully whether or not anything matched, so a
 * mis-encoded Persian path or a tag no fetch ever attached looks identical to a
 * working invalidation from the caller's side.
 *
 * @jest-environment node
 */

const revalidatePath = jest.fn();
const revalidateTag = jest.fn();

jest.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
  revalidateTag: (...args: unknown[]) => revalidateTag(...args),
}));

import { POST, buildPdpPath } from "../revalidate/route";
import {
  HOME_PRODUCTS_TAG,
  PRODUCT_COLLECTION_TAG,
  PRODUCT_TAG,
  SITEMAP_TAG,
  productSlugTag,
} from "@/constants/cacheTags";

const SECRET = "test-revalidation-secret";
const PERSIAN_SLUG = "ست-تاپ-و-دامن-فلامنت-y00574";
const ENCODED_SLUG = encodeURIComponent(PERSIAN_SLUG);
/** The literal percent-encoded form 1402 production rows were stored with. */
const LEGACY_ENCODED_SLUG =
  "%d8%b3%d8%aa-%d8%aa%d8%a7%d9%be-%d9%88-%d8%af%d8%a7%d9%85%d9%86-%d9%81%d9%84%d8%a7%d9%85%d9%86%d8%aa-y00574";

function request(body: unknown, token: string | null = SECRET) {
  return {
    headers: { get: (k: string) => (k === "authorization" && token ? `Bearer ${token}` : null) },
    json: async () => body,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.REVALIDATION_SECRET = SECRET;
});

describe("buildPdpPath", () => {
  it("encodes a decoded Persian slug to the form Next stored the route under", () => {
    expect(buildPdpPath(PERSIAN_SLUG)).toBe(`/pdp/${ENCODED_SLUG}`);
  });

  it("normalizes the legacy percent-encoded slug to the same canonical path", () => {
    expect(buildPdpPath(LEGACY_ENCODED_SLUG)).toBe(`/pdp/${ENCODED_SLUG}`);
  });

  it("accepts a slug that already carries the /pdp/ prefix without doubling it", () => {
    expect(buildPdpPath(`/pdp/${PERSIAN_SLUG}`)).toBe(`/pdp/${ENCODED_SLUG}`);
  });

  it("leaves an ASCII slug untouched", () => {
    expect(buildPdpPath("scarf-around-zip-oppsi-s00518")).toBe(
      "/pdp/scarf-around-zip-oppsi-s00518",
    );
  });
});

describe("POST /api/revalidate auth", () => {
  it("rejects a missing bearer header with 401", async () => {
    const res = await POST(request({ type: "product", path: "x" }, null));
    expect(res.status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("rejects a wrong token of a different length with 403", async () => {
    const res = await POST(request({ type: "product", path: "x" }, "short"));
    expect(res.status).toBe(403);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  // Exercises the timingSafeEqual branch itself, which the length pre-check
  // short-circuits for every other rejection case.
  it("rejects a wrong token of identical length with 403", async () => {
    const sameLengthWrongToken = "X".repeat(SECRET.length);
    expect(sameLengthWrongToken).toHaveLength(SECRET.length);
    expect(sameLengthWrongToken).not.toBe(SECRET);

    const res = await POST(request({ type: "product", path: "x" }, sameLengthWrongToken));
    expect(res.status).toBe(403);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("accepts the exact secret", async () => {
    const res = await POST(request({ type: "product", path: PERSIAN_SLUG }, SECRET));
    expect(res.status).not.toBe(403);
    expect(revalidateTag).toHaveBeenCalled();
  });

  it("refuses to run at all when no secret is configured", async () => {
    delete process.env.REVALIDATION_SECRET;
    const res = await POST(request({ type: "product", path: "x" }));
    expect(res.status).toBe(500);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});

describe("product revalidation", () => {
  it("invalidates the slug tag for a Persian slug", async () => {
    await POST(request({ type: "product", path: PERSIAN_SLUG }));

    const tags = revalidateTag.mock.calls.map(([t]) => t);
    expect(tags).toContain(productSlugTag(PERSIAN_SLUG));
    expect(tags).toEqual(
      expect.arrayContaining([PRODUCT_TAG, PRODUCT_COLLECTION_TAG, HOME_PRODUCTS_TAG, SITEMAP_TAG]),
    );
  });

  it("derives the same slug tag whether Strapi sends the decoded or encoded slug", async () => {
    await POST(request({ type: "product", path: PERSIAN_SLUG }));
    const decodedTags = revalidateTag.mock.calls.map(([t]) => t);

    jest.clearAllMocks();
    await POST(request({ type: "product", path: LEGACY_ENCODED_SLUG }));
    const encodedTags = revalidateTag.mock.calls.map(([t]) => t);

    expect(encodedTags).toEqual(decodedTags);
  });

  it("revalidates the PDP path using Next's encoding, not the raw Persian text", async () => {
    await POST(request({ type: "product", path: PERSIAN_SLUG }));

    const paths = revalidatePath.mock.calls.map(([p]) => p);
    expect(paths).toContain(`/pdp/${ENCODED_SLUG}`);
    // The unencoded path is what silently matched nothing before.
    expect(paths).not.toContain(`/pdp/${PERSIAN_SLUG}`);
  });

  it("no longer invalidates tags that no fetch attaches", async () => {
    await POST(request({ type: "product", path: PERSIAN_SLUG }));

    const tags = revalidateTag.mock.calls.map(([t]) => t);
    expect(tags).not.toContain("home-products-critical");
    expect(tags).not.toContain("home-products-optional");
  });
});

describe("sitemap freshness", () => {
  it.each([
    ["product", { type: "product", path: PERSIAN_SLUG }],
    ["blog-post", { type: "blog-post", path: "/a-post" }],
    ["blog-listing", { type: "blog-listing", path: "/blog" }],
    ["site-settings", { type: "site-settings", path: "/" }],
  ])("invalidates the sitemap tag for %s", async (_label, body) => {
    await POST(request(body));
    expect(revalidateTag.mock.calls.map(([t]) => t)).toContain(SITEMAP_TAG);
  });
});
