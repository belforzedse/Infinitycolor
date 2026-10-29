jest.mock("@/utils/fetchWithTimeout", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import fetchWithTimeout from "@/utils/fetchWithTimeout";
import {
  buildOfferPLPMetadata,
  buildPLPMetadata,
  buildPLPPageCopy,
  buildPLPProductsQuery,
  getPLPProducts,
  PLPProductsError,
  parsePLPQuery,
  serializePLPProductsQuery,
  type PLPQuery,
} from "../plp";
import { getOfferPlpHref, parsePLPOffer } from "@/utils/plpRoutes";

const paramsObject = (params: URLSearchParams) =>
  Array.from(params.entries()).reduce<Record<string, string[]>>((acc, [key, value]) => {
    acc[key] = [...(acc[key] || []), value];
    return acc;
  }, {});

describe("PLP query helpers", () => {
  it("requests the exclusive Oppsi collection only for its dedicated search page", () => {
    for (const search of ["Oppsi", "OPPSI", " oppsi "]) {
      expect(buildPLPProductsQuery({ page: 1, available: false, search }).get("oppsi")).toBe("true");
    }
    for (const search of [undefined, "مانتو", "مانتو Oppsi"]) {
      expect(buildPLPProductsQuery({ page: 1, available: false, search }).has("oppsi")).toBe(false);
    }
  });
  it("preserves all matching color IDs and exact-title fallbacks in one OR group", () => {
    const params = buildPLPProductsQuery(
      { page: 1, available: false, color: ["blue"] },
      [],
      30,
      { colors: [
        { title: "آبی", colorCode: null, ids: [11, 12] },
        { title: "آبی روشن", colorCode: null, ids: [13] },
        { title: "آبی ناشناخته", colorCode: null },
        { title: "سرمه‌ای", colorCode: null, ids: [99] },
      ] },
    );
    expect(params.get("filters[$and][3][$or][0][product_variations][product_variation_color][id][$in]"))
      .toBe("11,12,13");
    expect(params.get("filters[$and][3][$or][1][product_variations][product_variation_color][Title][$in][0]"))
      .toBe("آبی ناشناخته");
    expect(params.get("filters[$and][3][$or][1][product_variations][product_variation_color][Title][$in][1]"))
      .toBe("blue");
    expect(params.toString()).not.toContain("99");
  });

  it("keeps invalid or unavailable IDs on the exact-title fallback", () => {
    const params = buildPLPProductsQuery(
      { page: 1, available: false, color: ["blue"] }, [], 30,
      { colors: [{ title: "آبی", colorCode: null, ids: [1, -2] }] },
    );
    expect(params.get("filters[$and][3][product_variations][product_variation_color][Title][$in][0]"))
      .toBe("آبی");
    expect(params.toString()).not.toContain("%5Bid%5D");
  });

  it("compacts only key grammar, preserving encoded search and title values", () => {
    const params = buildPLPProductsQuery({
      page: 2, available: true, search: "آبی & filters[$or]=حمله + #?", color: ["آبی [روشن]"],
    });
    const serialized = serializePLPProductsQuery(params);
    expect([...new URLSearchParams(serialized)]).toEqual([...params]);
    expect(serialized).toContain("filters[$and]");
    expect(serialized).toContain("%26");
    expect(serialized).toContain("%5B%24or%5D");
  });

  it("keeps 99 expanded shades well below the HTTP request budget with trace headers", async () => {
    const colors = Array.from({ length: 99 }, (_, index) => ({
      title: `${["آبی", "قرمز", "سبز", "سرمه‌ای"][index % 4]} روشن شماره ${index}`,
      colorCode: null,
      ids: [10_000 + index],
    }));
    const query = { page: 1, available: false, color: ["blue", "red", "green", "navy"], sort: "AverageRating:desc" };
    const oldParams = buildPLPProductsQuery(query, [], 30, {
      colors: colors.map(({ title, colorCode }) => ({ title, colorCode })),
    });
    const params = buildPLPProductsQuery(query, [], 30, { colors });
    const oldTarget = `/api/products?${oldParams}`;
    const target = `/api/products?${serializePLPProductsQuery(params)}`;
    expect(oldTarget.length).toBeGreaterThan(16_384);
    expect(target.length + 1024).toBeLessThan(8_192);

    // Use Node's real HTTP parser, including tracing overhead, rather than a mocked 431.
    const { createServer, get } = await import("node:http");
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    const status = (path: string) => new Promise<number | undefined>((resolve, reject) => {
      get({ hostname: "127.0.0.1", port, path, headers: { baggage: "x".repeat(1024) } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      }).on("error", reject);
    });
    try {
      expect(await status(oldTarget)).toBe(431);
      expect(await status(target)).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

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

    const params = buildPLPProductsQuery(query, ["parent", "child"], 24, {
      sizeTitles: ["XL", "L/XL", "M"],
      colors: [
        { title: "E2E Blue", colorCode: "#0057ff" },
        { title: "آبی تیره", colorCode: "#4C5E74" },
        { title: "سرمه ای", colorCode: "#1E3A8A" },
      ],
    });
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

  it("treats /plp's newest sort as a plain sort now that Newest has its own listing", () => {
    const newest = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "LastEditedByAdminAt:desc",
    });
    expect(newest.has("curated")).toBe(false);
    expect(newest.has("offer")).toBe(false);
  });

  it("sends an offer listing to the backend without any /plp view hints", () => {
    const params = buildPLPProductsQuery({
      page: 2,
      available: true,
      size: ["m"],
      offer: "newest",
    });

    expect(params.get("offer")).toBe("newest");
    expect(params.has("curated")).toBe(false);
    expect(params.has("excludeDiscount")).toBe(false);
    // Still the normal card query: same eligibility, paging and filters as any PLP.
    expect(params.get("view")).toBe("card");
    expect(params.get("pagination[page]")).toBe("2");
    expect(params.get("requireCoverImage")).toBe("true");
    expect(params.get("availability")).toBe("available");
    expect(Array.from(params.values())).toContain("Active");
    // No shopper sort means the backend's own Newest ranking.
    expect(params.has("sort[0]")).toBe(false);

    const sorted = buildPLPProductsQuery({
      page: 1,
      available: false,
      sort: "price:asc",
      offer: "newest",
    });
    expect(sorted.get("sort[0]")).toBe("price:asc");
    expect(sorted.get("offer")).toBe("newest");
  });

  it("only accepts known offer types from the URL", () => {
    expect(parsePLPOffer("newest")).toBe("newest");
    expect(parsePLPOffer("oppsi")).toBeUndefined();
    expect(parsePLPOffer(["newest"])).toBeUndefined();
    expect(parsePLPOffer(undefined)).toBeUndefined();
    expect(getOfferPlpHref("newest")).toBe("/offer?type=newest");
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
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it("preserves a successful empty result and its pagination", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: jest
        .fn()
        .mockResolvedValue({ data: [], meta: { pagination: { total: 0, pageCount: 0 } } }),
    });
    await expect(getPLPProducts(query)).resolves.toEqual({
      products: [],
      pagination: { page: 1, pageSize: 30, pageCount: 0, total: 0 },
    });
  });

  it("does not represent a network failure as an empty catalog", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("offline"));

    await expect(getPLPProducts(query)).rejects.toMatchObject({ code: "FETCH_FAILED" });
  });

  it("retains a redacted connection cause and the failed request stage", async () => {
    const socketError = Object.assign(new Error("private socket address and token"), {
      code: "ECONNRESET",
    });
    socketError.stack =
      "Error: private socket address and token\n    at read (node:internal/streams/readable:7:4)";
    const error = new TypeError("fetch failed: https://user:password@host/products?search=private");
    error.cause = socketError;
    (global.fetch as jest.Mock).mockRejectedValue(error);

    const failure = await getPLPProducts(query).catch((error) => error);
    expect(failure).toBeInstanceOf(PLPProductsError);
    expect(failure).toMatchObject({
      code: "FETCH_FAILED",
      failureStage: "request",
      cause: { name: "TypeError", cause: { code: "ECONNRESET" } },
    });
    expect(failure.cause.cause.stack).toContain("node:internal/streams/readable:7:4");
    expect(String(failure.cause)).not.toContain("password");
    expect(JSON.stringify(failure)).not.toMatch(/private|password|search=|socket address/);
  });

  it("distinguishes an unreadable response from a failed fetch without losing HTTP status", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockRejectedValue(new SyntaxError("private HTML response")),
    });
    const failure = await getPLPProducts(query).catch((error) => error);
    expect(failure).toMatchObject({
      code: "FETCH_FAILED",
      status: 200,
      failureStage: "response_json",
      cause: { name: "SyntaxError" },
    });
    expect(String(failure.cause)).not.toContain("private HTML response");
  });

  it("retains AbortError as an actionable request failure", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(getPLPProducts(query)).rejects.toMatchObject({
      code: "FETCH_FAILED",
      failureStage: "request",
      cause: { name: "AbortError" },
    });
  });

  it("distinguishes invalid product data from invalid JSON", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ data: null }),
    });
    await expect(getPLPProducts(query)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      failureStage: "response_normalization",
      status: 200,
    });
  });

  it("preserves HTTP 431 and malformed-response receipts without retrying them", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 431, headers: { get: () => "receipt-431" } });
    await expect(getPLPProducts(query)).rejects.toMatchObject({
      status: 431,
      requestId: "receipt-431",
      attempts: 1,
      failureStage: "response_status",
      requestShape: { request_target_bytes: expect.any(Number) },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    jest
      .mocked(fetch)
      .mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "receipt-invalid" },
        json: async () => ({ data: null }),
      });
    await expect(getPLPProducts(query)).rejects.toMatchObject({
      status: 200,
      requestId: "receipt-invalid",
      attempts: 1,
      failureStage: "response_normalization",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not represent a backend rejection as no results", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
      url: "http://backend/products",
      json: jest.fn().mockResolvedValue({ error: { message: "unavailable" } }),
    });

    await expect(getPLPProducts(query)).rejects.toMatchObject({
      code: "API_ERROR",
      status: 503,
      failureStage: "response_status",
    });
  });
});

describe("offer PLP metadata", () => {
  it("canonicalizes every view of the Newest listing to /offer?type=newest", () => {
    const metadata = buildOfferPLPMetadata("newest");
    expect(metadata.title).toBe("جدیدترین محصولات");
    expect(metadata.alternates?.canonical).toMatch(/\/offer\?type=newest$/);

    const copy = buildPLPPageCopy({ page: 3, available: true, offer: "newest" });
    expect(copy.pageName).toBe("جدیدترین محصولات");
    expect(copy.url).toMatch(/\/offer\?type=newest$/);
  });
});

describe("category PLP metadata", () => {
  const query: PLPQuery = { page: 1, available: false };
  beforeEach(() => {
    global.fetch = jest.fn();
  });
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
