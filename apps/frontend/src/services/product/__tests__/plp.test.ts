jest.mock("@/utils/fetchWithTimeout", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import fetchWithTimeout from "@/utils/fetchWithTimeout";
import {
  buildPLPMetadata,
  buildPLPProductsQuery,
  getPLPProducts,
  parsePLPQuery,
  type PLPQuery,
} from "../plp";

const paramsObject = (params: URLSearchParams) =>
  Array.from(params.entries()).reduce<Record<string, string[]>>((acc, [key, value]) => {
    acc[key] = [...(acc[key] || []), value];
    return acc;
  }, {});

describe("PLP query helpers", () => {
  it("normalizes invalid page values to page 1", () => {
    expect(parsePLPQuery({ page: "-2" }).page).toBe(1);
    expect(parsePLPQuery({ page: "abc" }).page).toBe(1);
    expect(parsePLPQuery({ page: "3" }).page).toBe(3);
  });

  it("builds a server-side card query for multiple filters plus sort", () => {
    const query: PLPQuery = {
      page: 4,
      available: true,
      minPrice: "100000",
      maxPrice: "900000",
      search: "scarf",
      sort: "price:asc",
      hasDiscount: true,
      size: ["XL"],
      color: ["blue"],
    };

    const params = buildPLPProductsQuery(
      query,
      ["parent", "child"],
      24,
      {
        sizeTitles: ["XL", "L/XL", "M"],
        colors: [
          { title: "E2E Blue", colorCode: "#0057ff" },
          { title: "آبی تیره", colorCode: "#4C5E74" },
          { title: "سرمه ای", colorCode: "#1E3A8A" },
        ],
      },
    );
    const entries = paramsObject(params);

    expect(params.get("view")).toBe("card");
    expect(params.get("pagination[page]")).toBe("4");
    expect(params.get("pagination[pageSize]")).toBe("24");
    expect(params.get("requireCoverImage")).toBe("true");
    expect(params.get("availability")).toBe("available");
    expect(params.get("price[min]")).toBe("100000");
    expect(params.get("price[max]")).toBe("900000");
    expect(params.get("hasDiscount")).toBe("true");
    expect(params.get("sort[0]")).toBe("price:asc");

    expect(entries["filters[$and][3][$or][0][product_main_category][Slug][$in][0]"]).toEqual([
      "parent",
    ]);
    expect(entries["filters[$and][3][$or][0][product_main_category][Slug][$in][1]"]).toEqual([
      "child",
    ]);
    expect(entries["filters[$and][3][$or][1][product_other_categories][Slug][$in][0]"]).toEqual([
      "parent",
    ]);
    expect(parsePLPQuery({ size: "3xl,xl" }).size).toEqual(["3xl", "xl"]);
    expect(parsePLPQuery({ color: "blue" }).color).toEqual(["blue"]);
    expect(entries["filters[$and][4][$or][0][Title][$containsi]"]).toEqual(["scarf"]);
    const sizeTitles = Object.entries(entries)
      .filter(([key]) => key.includes("product_variation_size][Title][$in]"))
      .flatMap(([, values]) => values);
    const colorTitles = Object.entries(entries)
      .filter(([key]) => key.includes("product_variation_color][Title][$in]"))
      .flatMap(([, values]) => values);
    expect(sizeTitles).toEqual(expect.arrayContaining(["XL", "L/XL"]));
    expect(sizeTitles).not.toEqual(expect.arrayContaining(["M"]));
    expect(colorTitles).toEqual(expect.arrayContaining(["E2E Blue", "آبی تیره"]));
    expect(colorTitles).not.toEqual(expect.arrayContaining(["سرمه ای"]));
  });

  it("hints excludeDiscount only for the exact unfiltered default-sort PLP view", () => {
    const defaultView = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "LastEditedByAdminAt:desc",
    });
    expect(defaultView.get("excludeDiscount")).toBe("true");

    // Pagination beyond page 1 is still the same base view.
    const secondPage = buildPLPProductsQuery({
      page: 2,
      available: false,
      sort: "LastEditedByAdminAt:desc",
    });
    expect(secondPage.get("excludeDiscount")).toBe("true");
  });

  it("withholds the excludeDiscount hint once any filter, category, or other sort applies", () => {
    const noSort = buildPLPProductsQuery({ page: 1, available: false });
    expect(noSort.has("excludeDiscount")).toBe(false);

    const otherSort = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "price:asc",
    });
    expect(otherSort.has("excludeDiscount")).toBe(false);

    const withCategory = buildPLPProductsQuery(
      { page: 1, available: false, sort: "LastEditedByAdminAt:desc" },
      ["manto"],
    );
    expect(withCategory.has("excludeDiscount")).toBe(false);

    const withHasDiscount = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "LastEditedByAdminAt:desc",
      hasDiscount: true,
    });
    expect(withHasDiscount.has("excludeDiscount")).toBe(false);

    const withSearch = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "LastEditedByAdminAt:desc",
      search: "scarf",
    });
    expect(withSearch.has("excludeDiscount")).toBe(false);

    const withPrice = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "LastEditedByAdminAt:desc",
      minPrice: "1000",
    });
    expect(withPrice.has("excludeDiscount")).toBe(false);
  });

  it("hints the curated section for each canonical View all URL", () => {
    const newest = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "LastEditedByAdminAt:desc",
    });
    expect(newest.get("curated")).toBe("newest");

    const popular = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "AverageRating:desc",
    });
    expect(popular.get("curated")).toBe("popular");

    const discount = buildPLPProductsQuery({
      page: 1,
      available: false,
      hasDiscount: true,
    });
    expect(discount.get("curated")).toBe("discount");

    // Pagination beyond page 1 stays on the same curated view.
    const secondPage = buildPLPProductsQuery({
      page: 2,
      available: false,
      hasDiscount: true,
    });
    expect(secondPage.get("curated")).toBe("discount");
  });

  it("withholds the curated hint once any filter, category, or other sort applies", () => {
    const bare = buildPLPProductsQuery({ page: 1, available: false });
    expect(bare.has("curated")).toBe(false);

    const otherSort = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "price:asc",
    });
    expect(otherSort.has("curated")).toBe(false);

    const withCategory = buildPLPProductsQuery(
      { page: 1, available: false, sort: "LastEditedByAdminAt:desc" },
      ["manto"],
    );
    expect(withCategory.has("curated")).toBe(false);

    const discountWithSort = buildPLPProductsQuery({
      page: 1,
      available: false,
      hasDiscount: true,
      sort: "Price:asc",
    });
    expect(discountWithSort.has("curated")).toBe(false);

    const popularWithHasDiscount = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "AverageRating:desc",
      hasDiscount: true,
    });
    expect(popularWithHasDiscount.has("curated")).toBe(false);

    const withSearch = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "LastEditedByAdminAt:desc",
      search: "scarf",
    });
    expect(withSearch.has("curated")).toBe(false);

    const withAvailable = buildPLPProductsQuery({
      page: 1,
      available: true,
      sort: "LastEditedByAdminAt:desc",
    });
    expect(withAvailable.has("curated")).toBe(false);
  });

  it("does not emit unsupported product filters", () => {
    const params = buildPLPProductsQuery({
      page: 1,
      available: false,
      material: "cotton",
      season: "winter",
      gender: "women",
      usage: "daily",
    });

    const serialized = params.toString();
    expect(serialized).not.toContain("Material");
    expect(serialized).not.toContain("Season");
    expect(serialized).not.toContain("Gender");
    expect(serialized).not.toContain("Usage");
  });
});

describe("PLP product failures", () => {
  const query: PLPQuery = { page: 1, available: false };

  it("does not represent a network failure as an empty catalog", async () => {
    (fetchWithTimeout as jest.Mock).mockRejectedValueOnce(new Error("offline"));

    await expect(getPLPProducts(query)).rejects.toMatchObject({ code: "FETCH_FAILED" });
  });

  it("does not represent a backend rejection as no results", async () => {
    (fetchWithTimeout as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 503,
      url: "http://backend/products",
      json: jest.fn().mockResolvedValue({ error: { message: "unavailable" } }),
    });

    await expect(getPLPProducts(query)).rejects.toMatchObject({ code: "API_ERROR", status: 503 });
  });
});

describe("category PLP metadata", () => {
  const query: PLPQuery = { page: 1, available: false };
  const category = {
    data: {} as any,
    slug: "manto",
    title: "مانتو",
    allCategories: [],
    categorySlugs: ["manto"],
  };

  it("uses imported editorial title and summary for document, social, and canonical metadata", () => {
    const metadata = buildPLPMetadata(query, category, {
      id: 7,
      title: "راهنمای خرید مانتو زنانه",
      paragraph: "مقدمه",
      content: "<p>متن</p>",
      audio: null,
      seoDescription: "خلاصه محتوای واردشده",
      isRtl: true,
      updatedAt: null,
    });

    expect(metadata.title).toBe("راهنمای خرید مانتو زنانه");
    expect(metadata.description).toBe("خلاصه محتوای واردشده");
    expect(metadata.openGraph).toEqual(
      expect.objectContaining({
        title: "راهنمای خرید مانتو زنانه",
        description: "خلاصه محتوای واردشده",
      }),
    );
    expect(metadata.twitter).toEqual(
      expect.objectContaining({
        title: "راهنمای خرید مانتو زنانه",
        description: "خلاصه محتوای واردشده",
      }),
    );
    expect(metadata.alternates).toEqual(
      expect.objectContaining({ canonical: expect.stringContaining("/plp/category/manto") }),
    );
  });

  it("keeps generic metadata when editorial is unavailable", () => {
    const metadata = buildPLPMetadata(query, category, null);
    expect(metadata.title).toBe("خرید مانتو");
    expect(metadata.description).toContain("بهترین قیمت");
  });
});
