import {
  buildSearchwiseFeedPayload,
  buildSearchwiseProduct,
  isSearchwiseAuthorized,
  parseSearchwisePage,
  parseSearchwiseSize,
} from "../services/searchwise-feed";

const options = {
  siteUrl: "https://store.example",
  mediaBaseUrl: "https://api.example",
  priceMultiplier: 10,
  brand: "Example Brand",
};

const makeProduct = (overrides: Record<string, unknown> = {}) => ({
  id: 10,
  Title: "پیراهن مردانه مدل Classic",
  Slug: "classic-shirt",
  Description: "<p>پارچه نخی مناسب روزمره</p>",
  ProductType: "Variable",
  CleaningTips: "شستشو با آب سرد",
  ReturnConditions: "تا ۷ روز",
  CoverImage: {
    url: "/uploads/main.jpg",
    mime: "image/jpeg",
    formats: {
      thumbnail: { url: "/uploads/main-thumb.jpg" },
    },
  },
  Media: [
    { url: "/uploads/side.jpg", mime: "image/jpeg" },
    { url: "/uploads/demo.mp4", mime: "video/mp4" },
    { url: "/uploads/main.jpg", mime: "image/jpeg" },
  ],
  product_main_category: {
    Title: "پیراهن",
    parent: {
      Title: "لباس مردانه",
      parent: {
        Title: "مردانه",
      },
    },
  },
  product_tags: [{ Title: "نخی" }, { Title: "تابستانی" }],
  product_variations: [
    {
      id: 1,
      IsPublished: true,
      SKU: "SHIRT-BLK-L",
      Price: 100000,
      DiscountPrice: 80000,
      product_stock: { Count: 3, reservedCount: 1 },
      product_variation_color: { Title: "مشکی" },
      product_variation_size: { Title: "L" },
      product_variation_model: { Title: "Classic" },
    },
    {
      id: 2,
      IsPublished: true,
      SKU: "SHIRT-WHT-M",
      Price: 120000,
      product_stock: { Count: 0 },
      product_variation_color: { Title: "سفید" },
      product_variation_size: { Title: "M" },
      product_variation_model: { Title: "Classic" },
    },
    {
      id: 3,
      IsPublished: false,
      SKU: "HIDDEN",
      Price: 1,
      product_stock: { Count: 10 },
    },
  ],
  ...overrides,
});

describe("Searchwise feed mapper", () => {
  const originalToken = process.env.SEARCHWISE_FEED_TOKEN;

  afterEach(() => {
    process.env.SEARCHWISE_FEED_TOKEN = originalToken;
  });

  it("maps required Searchwise fields with cover image first and prices in Rial", () => {
    const item = buildSearchwiseProduct(makeProduct(), options);

    expect(item).toMatchObject({
      id: "10",
      title: "پیراهن مردانه مدل Classic",
      subtitle: "Classic",
      link: "https://store.example/pdp/classic-shirt",
      availability: "in stock",
      regular_price: 1000000,
      sale_price: 800000,
      category: "مردانه < لباس مردانه < پیراهن",
      brand: "Example Brand",
      GTIN: "",
      color: ["مشکی", "سفید"],
      size: ["L", "M"],
    });
    expect(item?.image_link).toEqual([
      "https://api.example/uploads/main.jpg",
      "https://api.example/uploads/side.jpg",
    ]);
    expect(item?.description).toMatchObject({
      "دسته بندی": "مردانه < لباس مردانه < پیراهن",
      "نوع محصول": "Variable",
      SKU: ["SHIRT-BLK-L", "SHIRT-WHT-M"],
      "توضیحات": "پارچه نخی مناسب روزمره",
    });
  });

  it("keeps published priced out-of-stock products indexable", () => {
    const item = buildSearchwiseProduct(
      makeProduct({
        product_variations: [
          {
            IsPublished: true,
            SKU: "OUT",
            Price: 50000,
            product_stock: { Count: 0 },
          },
        ],
      }),
      options,
    );

    expect(item?.availability).toBe("out of stock");
    expect(item?.regular_price).toBe(500000);
    expect(item?.sale_price).toBe(500000);
  });

  it("omits products that do not have a stable slug or published priced variation", () => {
    expect(buildSearchwiseProduct(makeProduct({ Slug: "" }), options)).toBeNull();
    expect(
      buildSearchwiseProduct(
        makeProduct({
          product_variations: [{ IsPublished: false, Price: 100000 }],
        }),
        options,
      ),
    ).toBeNull();
  });

  it("adds pagination metadata to feed payloads", () => {
    const payload = buildSearchwiseFeedPayload(
      [makeProduct()],
      { page: 2, size: 1, pageCount: 3, total: 3 },
      options,
    );

    expect(payload.data).toHaveLength(1);
    expect(payload.meta.pagination).toEqual({ page: 2, size: 1, pageCount: 3, total: 3 });
    expect(payload.meta.generatedAt).toEqual(expect.any(String));
  });

  it("normalizes pagination inputs", () => {
    expect(parseSearchwisePage("0")).toBe(1);
    expect(parseSearchwisePage("3")).toBe(3);
    expect(parseSearchwiseSize("0")).toBe(100);
    expect(parseSearchwiseSize("1500")).toBe(1000);
  });

  it("requires token auth only when configured", () => {
    delete process.env.SEARCHWISE_FEED_TOKEN;
    expect(isSearchwiseAuthorized({})).toBe(true);

    process.env.SEARCHWISE_FEED_TOKEN = "secret";
    expect(isSearchwiseAuthorized({})).toBe(false);
    expect(isSearchwiseAuthorized({ "x-searchwise-token": "secret" })).toBe(true);
    expect(isSearchwiseAuthorized({ authorization: "Bearer secret" })).toBe(true);
  });
});
