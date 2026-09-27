import createMiddleware, {
  stripRelationFilters,
  stripRelationPopulate,
} from "../public-product-visibility";

const VISIBLE = { Status: "Active", removedAt: { $null: true } };

function makeStrapi(found: unknown = { id: 1 }) {
  const findOne = jest.fn().mockResolvedValue(found);
  return {
    strapi: {
      db: { query: jest.fn(() => ({ findOne })) },
      contentType: jest.fn(() => ({
        attributes: {
          Title: { type: "string" },
          products: { type: "relation" },
          product_others: { type: "relation" },
          Image: { type: "media" },
          parent: { type: "relation" },
        },
      })),
    },
    findOne,
  };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return { query: {}, params: {}, state: {}, notFound: jest.fn(), ...overrides } as any;
}

describe("public product visibility middleware", () => {
  it("only lists entries of public products for public readers", async () => {
    const { strapi } = makeStrapi();
    const middleware = createMiddleware({ mode: "owner", uid: "api::product-variation.product-variation" }, { strapi });
    const request = ctx({ query: { filters: { SKU: { $eq: "A" } } } });
    const next = jest.fn();

    await middleware(request, next);

    expect(request.query.filters).toEqual({ $and: [{ SKU: { $eq: "A" } }, { product: VISIBLE }] });
    expect(next).toHaveBeenCalled();
  });

  it("answers 404 for a single entry of a hidden product", async () => {
    const { strapi, findOne } = makeStrapi(null);
    const middleware = createMiddleware({ mode: "owner", uid: "api::product-faq.product-faq" }, { strapi });
    const request = ctx({ params: { id: "9" } });
    const next = jest.fn();

    await middleware(request, next);

    expect(findOne).toHaveBeenCalledWith({ where: { id: "9", product: VISIBLE }, select: ["id"] });
    expect(request.notFound).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("leaves staff holding product.read untouched", async () => {
    const { strapi } = makeStrapi();
    const middleware = createMiddleware({ mode: "owner", uid: "api::product-variation.product-variation" }, { strapi });
    const request = ctx({
      state: { user: { role: { type: "store-manager", name: "Store Manager" } } },
      query: { filters: { SKU: { $eq: "A" } } },
    });
    await middleware(request, jest.fn());
    expect(request.query.filters).toEqual({ SKU: { $eq: "A" } });
  });

  it("gives API tokens the public view, as the product routes do", async () => {
    const { strapi } = makeStrapi();
    const middleware = createMiddleware({ mode: "owner", uid: "api::product-variation.product-variation" }, { strapi });
    const request = ctx({ state: { auth: { strategy: { name: "api-token" } } } });
    await middleware(request, jest.fn());
    expect(request.query.filters).toEqual({ product: VISIBLE });
  });

  it("keeps staff without product.read on the public view", async () => {
    const { strapi } = makeStrapi();
    const middleware = createMiddleware({ mode: "owner", uid: "api::product-review.product-review" }, { strapi });
    const request = ctx({ state: { user: { role: { type: "editor", name: "Editor" } } } });
    await middleware(request, jest.fn());
    expect(request.query.filters).toEqual({ product: VISIBLE });
  });

  it("keeps customers on the public view", async () => {
    const { strapi } = makeStrapi();
    const middleware = createMiddleware({ mode: "owner", uid: "api::product-review.product-review" }, { strapi });
    const request = ctx({ state: { user: { role: { type: "authenticated", name: "Authenticated" } } } });
    await middleware(request, jest.fn());
    expect(request.query.filters).toEqual({ product: VISIBLE });
  });

  it("stops public readers from populating or filtering categories by their products", async () => {
    const { strapi } = makeStrapi();
    const middleware = createMiddleware(
      { mode: "strip", uid: "api::product-category.product-category", relations: ["products", "product_others"] },
      { strapi },
    );
    const request = ctx({
      query: {
        populate: "*",
        filters: { $and: [{ Slug: { $eq: "shoes" } }, { products: { Title: { $containsi: "secret" } } }] },
      },
    });

    await middleware(request, jest.fn());

    expect(request.query.populate).toEqual(["Image", "parent"]);
    expect(request.query.filters).toEqual({ $and: [{ Slug: { $eq: "shoes" } }, {}] });
  });
});

describe("relation stripping helpers", () => {
  const relations = new Set(["products"]);

  it.each([
    ["products", ""],
    ["products,parent", "parent"],
    ["products.product_variations,parent", "parent"],
    [["products", "parent"], ["parent"]],
    [{ products: { populate: "*" }, parent: true }, { parent: true }],
    [undefined, undefined],
  ])("strips %j", (populate, expected) => {
    expect(stripRelationPopulate(populate, relations, ["products", "parent"])).toEqual(expected);
  });

  it("removes nested filter clauses that walk into the relation", () => {
    expect(
      stripRelationFilters({ $or: [{ products: { id: 1 } }, { Title: "x" }], products: { id: 2 } }, relations),
    ).toEqual({ $or: [{}, { Title: "x" }] });
  });
});
