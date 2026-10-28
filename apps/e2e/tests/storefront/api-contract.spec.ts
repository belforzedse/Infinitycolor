import { expect, test } from "@playwright/test";
import {
  E2E_CATEGORY_SLUG,
  E2E_PRODUCT_SLUG,
  E2E_PRODUCT_TITLE,
  E2E_UPLOAD_FIXTURE_FILE,
  E2E_XXXL_PRODUCT_SLUG,
} from "../../fixtures/storefront";
import {
  cacheBustingSearchParam,
  strapiApiURL,
  strapiOrigin,
} from "../../helpers/env";

type HomepageProductCard = {
  attributes?: {
    IsAvailable?: boolean;
    Slug?: string;
    Title?: string;
  };
};

function withCacheBust(url: URL) {
  const { key, value } = cacheBustingSearchParam();
  url.searchParams.set(key, value);
  return url;
}

test.describe("storefront API contract", () => {
  test("@smoke @api backend health and seeded product card contract", async ({
    request,
  }) => {
    const health = await request.get(`${strapiOrigin()}/_health`);
    expect(health.ok()).toBeTruthy();

    const cardUrl = withCacheBust(new URL(`${strapiApiURL()}/products`));
    cardUrl.searchParams.set("view", "card");
    cardUrl.searchParams.set("filters[Slug][$eq]", E2E_PRODUCT_SLUG);
    cardUrl.searchParams.set("filters[Status][$eq]", "Active");
    cardUrl.searchParams.set("filters[removedAt][$null]", "true");
    cardUrl.searchParams.set("filters[product_variations][Price][$gte]", "1");
    cardUrl.searchParams.set(
      "filters[product_variations][product_stock][Count][$gt]",
      "0",
    );
    cardUrl.searchParams.set("pagination[limit]", "1");

    const cardResponse = await request.get(cardUrl.toString());
    expect(cardResponse.ok()).toBeTruthy();
    const cardPayload = await cardResponse.json();
    const [product] = cardPayload.data ?? [];

    expect(product?.attributes?.Title).toBe(E2E_PRODUCT_TITLE);
    expect(product?.attributes?.Slug).toBe(E2E_PRODUCT_SLUG);
    expect(product?.attributes?.IsAvailable).toBe(true);
    expect(Number(product?.attributes?.Price)).toBeGreaterThan(0);
    expect(Number(product?.attributes?.InventoryCount)).toBeGreaterThan(0);
    expect(product?.attributes?.CoverImage?.url).toContain("/uploads/");
    expect(product?.attributes?.product_main_category?.Slug).toBe(
      E2E_CATEGORY_SLUG,
    );

    const uploadResponse = await request.get(
      `${strapiOrigin()}${product.attributes.CoverImage.url}`,
    );
    expect(uploadResponse.ok()).toBeTruthy();
    expect(uploadResponse.headers()["content-type"]).toContain("image/");

    const fixtureUploadResponse = await request.get(
      `${strapiOrigin()}/uploads/${E2E_UPLOAD_FIXTURE_FILE}`,
    );
    expect(fixtureUploadResponse.ok()).toBeTruthy();
    expect(fixtureUploadResponse.headers()["content-type"]).toContain("image/");
  });

  test("@smoke @api homepage sections include the seeded storefront product", async ({
    request,
  }) => {
    const url = withCacheBust(
      new URL(`${strapiApiURL()}/products/homepage-sections`),
    );
    const response = await request.get(url.toString());
    expect(response.ok()).toBeTruthy();

    const payload = await response.json();
    const sections = payload?.data?.sections;
    expect(Array.isArray(sections)).toBeTruthy();
    expect(sections.length).toBeGreaterThan(0);

    const newestSection = sections.find(
      (section: { id?: string }) => section.id === "newest",
    );
    expect(newestSection).toBeTruthy();

    const newestCards = (newestSection?.products ?? []) as HomepageProductCard[];
    expect(newestCards.length).toBeGreaterThan(0);
    // Newest never shows a discount: the discounted smoke product is left out of it and
    // the full-price alias product is in it.
    const newestSlugs = newestCards.map((card) => card.attributes?.Slug);
    expect(newestSlugs).toContain(E2E_XXXL_PRODUCT_SLUG);
    expect(newestSlugs).not.toContain(E2E_PRODUCT_SLUG);

    const cards = sections.flatMap(
      (section: { products?: HomepageProductCard[] }) => section.products ?? [],
    ) as HomepageProductCard[];
    const seededCard = cards.find(
      (card) => card.attributes?.Slug === E2E_PRODUCT_SLUG,
    );

    expect(seededCard?.attributes?.Title).toBe(E2E_PRODUCT_TITLE);
    expect(seededCard?.attributes?.IsAvailable).toBe(true);
  });

  test("@smoke @api PDP detail contract exposes stock, media, and hexless color variation", async ({
    request,
  }) => {
    const url = withCacheBust(
      new URL(
        `${strapiApiURL()}/products/by-slug/${encodeURIComponent(E2E_PRODUCT_SLUG)}`,
      ),
    );
    const response = await request.get(url.toString());
    expect(response.ok()).toBeTruthy();

    const payload = await response.json();
    const product = payload?.data;
    const variations =
      product?.attributes?.product_variations?.data ??
      product?.product_variations ??
      [];

    expect(product?.attributes?.Title ?? product?.Title).toBe(
      E2E_PRODUCT_TITLE,
    );
    expect(variations.length).toBeGreaterThanOrEqual(3);

    const hasStockedVariation = variations.some((variation: any) => {
      const attrs = variation.attributes ?? variation;
      const count =
        attrs.product_stock?.data?.attributes?.Count ??
        attrs.product_stock?.Count ??
        0;
      return attrs.IsPublished === true && Number(count) > 0;
    });
    const hasHexlessColor = variations.some((variation: any) => {
      const attrs = variation.attributes ?? variation;
      const color =
        attrs.product_variation_color?.data?.attributes ??
        attrs.product_variation_color ??
        null;
      return color && (color.ColorCode === null || color.ColorCode === "");
    });

    expect(hasStockedVariation).toBe(true);
    expect(hasHexlessColor).toBe(true);
  });
});
