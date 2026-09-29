import { API_BASE_URL } from "@/constants/api";
import {
  getFeaturedCategoryProductsByRating,
  getBatchedHomepageSections,
  pickBatchedHomepageSection,
  getGifPromoProducts,
  getGifPromoProductsForSlot,
  getHomepageSections,
} from "../homepage";
import { defaultSettings } from "@/types/super-admin/settings";

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("homepage service", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    delete process.env.E2E_DISABLE_HOMEPAGE_FETCH_CACHE;
    delete process.env.E2E_SEED_MODE;
    delete process.env.HOME_BATCHED_SECTIONS_ENABLED;
    delete process.env.HOME_BATCHED_SECTION_ALLOWLIST;
  });

  describe("getHomepageSections", () => {
    it("keeps availability filtering separate from the promotion membership query", async () => {
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ data: [] }),
        });

      await getHomepageSections(defaultSettings());

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const [batchUrl, newUrl, promoUrl] = mockFetch.mock.calls.map(([url]) => new URL(url as string));

      expect(`${batchUrl.origin}${batchUrl.pathname}`).toBe(`${API_BASE_URL}/products`);
      expect(batchUrl.searchParams.get("pagination[limit]")).toBe("36");
      expect(promoUrl.searchParams.get("hasDiscount")).toBe("true");
      expect(promoUrl.searchParams.has("availability")).toBe(false);

      expect(`${newUrl.origin}${newUrl.pathname}`).toBe(`${API_BASE_URL}/products`);
      // The rail is the start of the Newest listing, ranked server-side.
      expect(newUrl.searchParams.get("offer")).toBe("newest");
      expect(newUrl.searchParams.get("availability")).toBe("in-stock");
      expect(newUrl.searchParams.has("sort[0]")).toBe(false);
      expect(newUrl.searchParams.get("pagination[limit]")).toBe("20");
    });

    it("leaves curated newest ids to the Newest listing instead of fetching them by id", async () => {
      await getHomepageSections({ ...defaultSettings(), homeNewestProductIds: [7, 3, 9] });

      const urls = mockFetch.mock.calls.map(([url]) => new URL(url as string));
      const newest = urls.filter((url) => url.searchParams.get("offer") === "newest");
      expect(newest).toHaveLength(1);
      expect(
        urls.some((url) => Array.from(url.searchParams.keys()).some((key) => key.startsWith("filters[id]"))),
      ).toBe(false);
    });

    it("should return empty sections when both requests fail", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network failure"));

      const result = await getHomepageSections();

      expect(result).toEqual({
        discounted: [],
        new: [],
        favorites: [],
      });
    });

    it("should opt out of the Next fetch cache during e2e seeding", async () => {
      process.env.E2E_DISABLE_HOMEPAGE_FETCH_CACHE = "1";
      mockFetch
        .mockResolvedValueOnce({
          json: async () => ({ data: [] }),
        })
        .mockResolvedValueOnce({
          json: async () => ({ data: [] }),
        });

      await getHomepageSections(defaultSettings());

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cache: "no-store" }),
      );
      const [calledUrl] = mockFetch.mock.calls[0];
      expect(new URL(calledUrl as string).searchParams.has("_e2e")).toBe(true);
    });
  });

  describe("getBatchedHomepageSections", () => {
    it("adds an e2e cache-busting query when homepage cache is disabled", async () => {
      process.env.HOME_BATCHED_SECTIONS_ENABLED = "true";
      process.env.HOME_BATCHED_SECTION_ALLOWLIST = "newest";
      process.env.E2E_DISABLE_HOMEPAGE_FETCH_CACHE = "1";
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ data: { sections: [] } }),
      });

      await getBatchedHomepageSections();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, options] = mockFetch.mock.calls[0];
      const url = new URL(calledUrl as string);
      expect(`${url.origin}${url.pathname}`).toBe(`${API_BASE_URL}/products/homepage-sections`);
      expect(url.searchParams.has("_e2e")).toBe(true);
      expect(options).toEqual(expect.objectContaining({ cache: "no-store" }));
    });

    // getHomeSectionProducts is a per-section fallback, so a rendered section proves
    // nothing about the batch path — assert the "customTwo" id survives the mapping.
    it("maps the customTwo section out of the batched payload", async () => {
      process.env.HOME_BATCHED_SECTIONS_ENABLED = "true";
      process.env.HOME_BATCHED_SECTION_ALLOWLIST = "customTwo";
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          data: {
            sections: [
              {
                id: "customTwo",
                products: [
                  {
                    id: 41,
                    attributes: {
                      Title: "شومیز",
                      Slug: "shomiz",
                      Price: 250000,
                      IsAvailable: true,
                    },
                  },
                ],
              },
            ],
          },
        }),
      });

      const batched = await getBatchedHomepageSections();

      expect(pickBatchedHomepageSection(batched, "customTwo")).toHaveLength(1);
    });

    it("maps the customThree section out of the batched payload", async () => {
      process.env.HOME_BATCHED_SECTIONS_ENABLED = "true";
      process.env.HOME_BATCHED_SECTION_ALLOWLIST = "customThree";
      mockFetch.mockResolvedValueOnce({
        json: async () => ({
          data: {
            sections: [
              {
                id: "customThree",
                products: [
                  {
                    id: 42,
                    attributes: {
                      Title: "شلوار",
                      Slug: "shalvar",
                      Price: 320000,
                      IsAvailable: true,
                    },
                  },
                ],
              },
            ],
          },
        }),
      });

      const batched = await getBatchedHomepageSections();

      expect(pickBatchedHomepageSection(batched, "customThree")).toHaveLength(1);
    });
  });

  describe("getFeaturedCategoryProductsByRating", () => {
    it("should query featured category products with top-rated sort and limit", async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ data: [] }),
      });

      await getFeaturedCategoryProductsByRating("special-category", 6);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl] = mockFetch.mock.calls[0];
      const url = new URL(calledUrl as string);

      expect(`${url.origin}${url.pathname}`).toBe(`${API_BASE_URL}/products`);
      expect(url.searchParams.get("filters[product_main_category][Slug][$eq]")).toBe(
        "special-category",
      );
      expect(url.searchParams.get("sort[0]")).toBe("AverageRating:desc");
      expect(url.searchParams.get("pagination[limit]")).toBe("6");
    });

    it("should return empty list without calling API when slug is empty", async () => {
      const result = await getFeaturedCategoryProductsByRating("   ", 6);

      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should return empty list when API fails", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network failure"));

      const result = await getFeaturedCategoryProductsByRating("special-category", 6);

      expect(result).toEqual([]);
    });
  });

  describe("getGifPromoProductsForSlot", () => {
    it("preserves manual product filters and caps at four", async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ data: [] }),
      });

      await getGifPromoProductsForSlot({
        mode: "manual",
        productIds: [4, 3, 2, 1],
        categorySlug: "",
      });

      const [calledUrl] = mockFetch.mock.calls[0];
      const url = new URL(calledUrl as string);

      expect(url.searchParams.get("view")).toBe("card");
      expect(url.searchParams.get("filters[id][$in][0]")).toBe("4");
      expect(url.searchParams.get("filters[id][$in][3]")).toBe("1");
      expect(url.searchParams.get("filters[Status][$eq]")).toBe("Active");
      expect(url.searchParams.get("filters[removedAt][$null]")).toBe("true");
      // Availability is `Count - reservedCount`, which Strapi filters cannot
      // express; the card query turns this param into the SQL predicate.
      expect(url.searchParams.get("availability")).toBe("in-stock");
    });

    it("queries category mode with main category slug and limit 4", async () => {
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ data: [] }),
      });

      await getGifPromoProductsForSlot({
        mode: "category",
        categorySlug: "coats",
        productIds: [],
      });

      const [calledUrl] = mockFetch.mock.calls[0];
      const url = new URL(calledUrl as string);

      expect(url.searchParams.get("filters[product_main_category][Slug][$eq]")).toBe("coats");
      expect(url.searchParams.get("pagination[limit]")).toBe("4");
      expect(url.searchParams.get("sort[0]")).toBe("createdAt:desc");
    });
  });

  describe("getGifPromoProducts", () => {
    it("returns empty slots when disabled", async () => {
      const result = await getGifPromoProducts(defaultSettings());

      expect(result).toEqual({ slot1: [], slot2: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not fetch incomplete slots without GIFs", async () => {
      const settings = {
        ...defaultSettings(),
        homeGifPromoEnabled: true,
        homeGifPromoSlot1Assignment: { mode: "manual" as const, productIds: [1], categorySlug: "" },
        homeGifPromoSlot2Assignment: {
          mode: "category" as const,
          categorySlug: "coats",
          productIds: [],
        },
      };

      const result = await getGifPromoProducts(settings);

      expect(result).toEqual({ slot1: [], slot2: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
