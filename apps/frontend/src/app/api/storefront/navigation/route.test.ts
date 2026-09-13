/**
 * @jest-environment node
 */

const mockCacheLife = jest.fn();
const mockCacheTag = jest.fn();
const mockGetNavbarProductCategories = jest.fn();

jest.mock("next/cache", () => ({
  cacheLife: (...args: unknown[]) => mockCacheLife(...args),
  cacheTag: (...args: unknown[]) => mockCacheTag(...args),
}));

jest.mock("@/services/product/categories", () => ({
  getNavbarProductCategories: (...args: unknown[]) => mockGetNavbarProductCategories(...args),
}));

import { GET } from "./route";

describe("GET /api/storefront/navigation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("serves the navbar through the shared public cache", async () => {
    mockGetNavbarProductCategories.mockResolvedValue([{ id: 1, slug: "coats" }]);

    const response = await GET(
      new Request("https://storefront.test/api/storefront/navigation?includeChildren=1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: 1, slug: "coats" }]);
    expect(mockGetNavbarProductCategories).toHaveBeenCalledWith({ includeChildren: true });
    expect(mockCacheLife).toHaveBeenCalledWith("storefrontPublic");
    expect(mockCacheTag).toHaveBeenCalledWith("navigation", "product-categories");
    expect(response.headers.get("cache-control")).toContain("stale-while-revalidate=3300");
  });

  it("returns an uncached 503 when a cache fill fails", async () => {
    mockGetNavbarProductCategories.mockRejectedValue(new Error("upstream timeout"));

    const response = await GET(
      new Request("https://storefront.test/api/storefront/navigation?includeChildren=1"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
