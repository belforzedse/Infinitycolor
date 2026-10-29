const mockStrapi: any = {};

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreService: jest.fn((_uid, factory) => factory({ strapi: mockStrapi })),
  },
}));

jest.mock("../services/product-card-query", () => ({
  ...jest.requireActual("../services/product-card-query"),
  findOrderedProductIds: jest.fn(async () => ({ ids: [], pagination: { page: 1, pageSize: 25 } })),
}));

import productService from "../services/product";
import {
  applyNewestOfferExclusion,
  applyNewestOfferOrder,
  findOrderedProductIds,
  NEWEST_LISTED_AT_SQL,
} from "../services/product-card-query";

const service = productService as any;
const findOrderedProductIdsMock = findOrderedProductIds as jest.Mock;

function createOrderTrackingQuery() {
  const calls: Array<{ method: "orderByRaw" | "orderBy"; args: unknown[] }> = [];
  const query: any = {
    orderByRaw: (...args: unknown[]) => {
      calls.push({ method: "orderByRaw", args });
      return query;
    },
    orderBy: (...args: unknown[]) => {
      calls.push({ method: "orderBy", args });
      return query;
    },
  };
  return { query, calls };
}

const fakeKnex = { raw: (sql: string) => ({ toQuery: () => sql }) };
const fakeStrapi = { db: { metadata: { get: () => undefined } } };

const sqlOf = (call: { args: unknown[] }) => String(call.args[0]);

describe("applyNewestOfferOrder", () => {
  it("puts the curated picks first in their exact order, then the rest by listing date", () => {
    const { query, calls } = createOrderTrackingQuery();
    applyNewestOfferOrder(fakeKnex, query, fakeStrapi, undefined, [73, 11, 42]);

    expect(calls).toHaveLength(5);
    expect(calls[0]).toEqual({
      method: "orderByRaw",
      args: [
        "CASE WHEN p.id = ANY(string_to_array(?, ',')::integer[]) THEN 0 ELSE 1 END",
        ["73,11,42"],
      ],
    });
    expect(calls[1]).toEqual({
      method: "orderByRaw",
      args: [
        "array_position(string_to_array(?, ',')::integer[], p.id) ASC NULLS LAST",
        ["73,11,42"],
      ],
    });
    // Stock only splits what follows the curated block: the curated CASE never mentions it.
    expect(sqlOf(calls[0])).not.toContain("EXISTS");
    expect(sqlOf(calls[2])).toMatch(/^EXISTS \([\s\S]*\) DESC$/);
    expect(calls[3]).toEqual({ method: "orderByRaw", args: [`${NEWEST_LISTED_AT_SQL} DESC`] });
    expect(calls[4]).toEqual({ method: "orderBy", args: ["p.id", "desc"] });
  });

  it("ranks by listing date, never by the last admin edit", () => {
    expect(NEWEST_LISTED_AT_SQL).toBe("COALESCE(p.published_at, p.created_at AT TIME ZONE 'UTC')");
    expect(NEWEST_LISTED_AT_SQL).not.toContain("last_edited_by_admin_at");
  });

  it("treats the storefront's own newest sort option as the default ranking", () => {
    const explicit = createOrderTrackingQuery();
    applyNewestOfferOrder(fakeKnex, explicit.query, fakeStrapi, "LastEditedByAdminAt:desc", [5]);
    const implicit = createOrderTrackingQuery();
    applyNewestOfferOrder(fakeKnex, implicit.query, fakeStrapi, undefined, [5]);
    expect(explicit.calls).toEqual(implicit.calls);
  });

  it("is plain availability then listing date when nothing is curated", () => {
    const { query, calls } = createOrderTrackingQuery();
    applyNewestOfferOrder(fakeKnex, query, fakeStrapi, undefined, []);

    expect(calls.map(sqlOf).some((sql) => sql.includes("string_to_array"))).toBe(false);
    expect(calls.slice(1)).toEqual([
      { method: "orderByRaw", args: [`${NEWEST_LISTED_AT_SQL} DESC`] },
      { method: "orderBy", args: ["p.id", "desc"] },
    ]);
  });

  it("reverses the listing date for 'oldest' and drops the curated block", () => {
    const { query, calls } = createOrderTrackingQuery();
    applyNewestOfferOrder(fakeKnex, query, fakeStrapi, "LastEditedByAdminAt:asc", [73, 11]);

    expect(calls.map(sqlOf).some((sql) => sql.includes("string_to_array"))).toBe(false);
    expect(calls.slice(1)).toEqual([
      { method: "orderByRaw", args: [`${NEWEST_LISTED_AT_SQL} ASC`] },
      { method: "orderBy", args: ["p.id", "asc"] },
    ]);
  });

  it("orders by a shopper-picked sort like every PLP, without the curated block", () => {
    const { query, calls } = createOrderTrackingQuery();
    applyNewestOfferOrder(fakeKnex, query, fakeStrapi, "price:asc", [73, 11]);

    const sql = calls.map(sqlOf);
    expect(sql.some((clause) => clause.includes("string_to_array"))).toBe(false);
    expect(sql.some((clause) => clause.includes(NEWEST_LISTED_AT_SQL))).toBe(false);
    expect(sql.some((clause) => clause.includes("ASC NULLS LAST") && clause.includes("MIN("))).toBe(
      true,
    );
    expect(calls.at(-1)).toEqual({ method: "orderBy", args: ["p.id", "asc"] });
  });
});

describe("applyNewestOfferExclusion", () => {
  const knexPath = require.resolve("knex", {
    paths: [require.resolve("@strapi/database", { paths: [require.resolve("@strapi/strapi")] })],
  });
  const offlineKnex = require(knexPath)({ client: "pg" });

  it("leaves out every discounted product and every Oppsi product", () => {
    const query = offlineKnex({ p: "products" }).select("p.id");
    applyNewestOfferExclusion(offlineKnex, query, fakeStrapi);
    const sql = query.toString();

    // The storefront's hasDiscount predicate, negated: a real DiscountPrice below Price, or
    // a live general discount, on a published priced variation.
    expect(sql).toMatch(/where not exists \(select 1 from "product_variations" as "pv"/);
    expect(sql).toContain('"pv"."is_published" = true');
    expect(sql).toContain(
      "COALESCE(pv.discount_price, 0)::numeric > 0 AND COALESCE(pv.discount_price, 0)::numeric < COALESCE(pv.price, 0)::numeric",
    );
    expect(sql).toContain('"gd"."removed_at" is null');
    // Oppsi is its own condition, ANDed with the discount one: an Oppsi title is excluded
    // even when no discount was entered.
    expect(sql).toMatch(/\) and LOWER\(COALESCE\(p\.title, ''\)\) NOT LIKE '%oppsi%'$/);
  });
});

describe("Newest in the product service", () => {
  const settings = { homeNewestProductIds: [9, "4", 9, -1, 7] };

  beforeEach(() => {
    findOrderedProductIdsMock.mockClear();
    mockStrapi.db = {
      query: jest.fn(() => ({ findOne: jest.fn(async () => settings) })),
    };
    mockStrapi.entityService = { findMany: jest.fn(async () => []) };
  });

  it("gives an offer=newest listing the full curated list whatever the filters", async () => {
    await service.findProductCards({
      offer: "newest",
      curated: "popular",
      availability: "available",
      filters: { $and: [{ Status: "Active" }] },
      pagination: { page: "2", pageSize: "30" },
    });

    expect(findOrderedProductIdsMock).toHaveBeenCalledTimes(1);
    const params = findOrderedProductIdsMock.mock.calls[0][1];
    expect(params).toMatchObject({
      offer: "newest",
      availability: "available",
      curatedProductIds: [9, 4, 7],
      pagination: { page: "2", pageSize: "30" },
    });
    // The /plp curated hint is not consulted for Newest.
    expect(params.curated).toBeUndefined();
  });

  it("builds the homepage newest rail from the same Newest listing, in stock, 100 cards", async () => {
    await service.findHomepageSections();

    const newestCalls = findOrderedProductIdsMock.mock.calls.filter(
      ([, params]) => params?.offer === "newest",
    );
    expect(newestCalls).toHaveLength(1);
    expect(newestCalls[0][1]).toEqual({
      offer: "newest",
      curatedProductIds: [9, 4, 7],
      availability: "in-stock",
      pagination: { limit: 100, withCount: false },
    });
  });

  it("no longer resolves curated newest ids for the /plp newest sort", async () => {
    await service.findProductCards({ curated: "newest", sort: ["LastEditedByAdminAt:desc"] });

    const params = findOrderedProductIdsMock.mock.calls[0][1];
    expect(params.curatedProductIds).toBeUndefined();
    expect(params.offer).toBeUndefined();
  });
});
