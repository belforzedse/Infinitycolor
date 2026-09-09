const mockFetch = jest.fn();

jest.mock("@/utils/fetchWithTimeout", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFetch(...args),
}));
jest.mock("@/utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn() },
}));

import {
  getPublishedCategoryEditorial,
  isCanonicalCategoryEditorialView,
} from "../categoryEditorial";
import type { PLPQuery } from "../plp";

const canonical: PLPQuery = { page: 1, available: false };

describe("category editorial storefront service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fetches the slug-specific public projection with the matching cache tag", async () => {
    const editorial = {
      id: 7,
      title: "راهنما",
      paragraph: "مقدمه",
      content: "<p>متن</p>",
      audio: null,
      seoDescription: "مقدمه متن",
      isRtl: true,
      updatedAt: null,
    };
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: editorial }) });

    await expect(getPublishedCategoryEditorial("روسری زنانه")).resolves.toEqual(editorial);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(
        "/category-editorial/public/%D8%B1%D9%88%D8%B3%D8%B1%DB%8C%20%D8%B2%D9%86%D8%A7%D9%86%D9%87",
      ),
      expect.objectContaining({
        next: {
          revalidate: 3600,
          tags: ["category:slug:روسری زنانه"],
        },
      }),
    );
  });

  it("fails closed when content is absent or the backend is unavailable", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: null }) });
    await expect(getPublishedCategoryEditorial("خالی")).resolves.toBeNull();
    mockFetch.mockRejectedValueOnce(new Error("offline"));
    await expect(getPublishedCategoryEditorial("خطا")).resolves.toBeNull();
  });

  it.each([
    { page: 2 },
    { search: "ابریشم" },
    { available: true },
    { minPrice: "1000" },
    { maxPrice: "9000" },
    { size: ["M"] },
    { color: ["blue"] },
    { material: "silk" },
    { season: "summer" },
    { gender: "women" },
    { usage: "daily" },
    { sort: "createdAt:desc" },
    { hasDiscount: true },
  ])("hides editorial for non-canonical query %#", (variant) => {
    expect(isCanonicalCategoryEditorialView({ ...canonical, ...variant })).toBe(false);
  });

  it("allows only the unfiltered first category page", () => {
    expect(isCanonicalCategoryEditorialView(canonical)).toBe(true);
  });
});
