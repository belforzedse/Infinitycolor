import {
  applyAvailabilityAwareOrder,
  applyExcludeDiscountFilter,
  buildRatingOrderClause,
  isEnabledCardParam,
  parseCardPriceFilter,
  parseFindProductCardsPagination,
  parseQuerySortKey,
} from "../services/product-card-query";

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

describe("product card query helpers", () => {
  it("parses pagination with safe bounds", () => {
    expect(parseFindProductCardsPagination({ page: "3", pageSize: "40" })).toMatchObject({
      page: 3,
      limit: 40,
      start: 80,
      withCount: true,
    });

    expect(parseFindProductCardsPagination({ page: "-1", pageSize: "500" })).toMatchObject({
      page: 1,
      limit: 100,
      start: 0,
    });

    expect(
      parseFindProductCardsPagination({ limit: "10", start: "20", withCount: "false" }),
    ).toMatchObject({
      page: 1,
      limit: 10,
      start: 20,
      withCount: false,
    });
  });

  it("normalizes card query flags and price filters", () => {
    expect(isEnabledCardParam(true)).toBe(true);
    expect(isEnabledCardParam("true")).toBe(true);
    expect(isEnabledCardParam("1")).toBe(true);
    expect(isEnabledCardParam("false")).toBe(false);

    expect(parseCardPriceFilter({ min: "100000", max: "900000" })).toEqual({
      min: 100000,
      max: 900000,
    });
    expect(parseCardPriceFilter({ min: "bad", max: "" })).toEqual({
      min: undefined,
      max: undefined,
    });
  });

  it("reads the first Strapi sort entry, including computed price sorts", () => {
    expect(parseQuerySortKey("price:asc")).toBe("price:asc");
    expect(parseQuerySortKey(["AverageRating:desc", "Title:asc"])).toBe("AverageRating:desc");
    expect(parseQuerySortKey(undefined)).toBeUndefined();
  });

  it("orders rated products in either direction before unrated products", () => {
    expect(buildRatingOrderClause("AverageRating:desc")).toBe("p.average_rating DESC NULLS LAST");
    expect(buildRatingOrderClause("AverageRating:asc")).toBe("p.average_rating ASC NULLS LAST");
    expect(buildRatingOrderClause("createdAt:desc")).toBeNull();
  });

  it("defaults PLP \"newest\" to LastEditedByAdminAt, falling back through PublishedAt to createdAt", () => {
    const { query, calls } = createOrderTrackingQuery();
    applyAvailabilityAwareOrder(fakeKnex, query, fakeStrapi, undefined);

    const orderByRawCalls = calls.filter((call) => call.method === "orderByRaw");
    expect(orderByRawCalls[1].args[0]).toBe(
      "COALESCE(p.last_edited_by_admin_at, p.published_at, p.created_at) DESC",
    );
  });

  it("tie-breaks by id in the same direction as the primary sort, not always ascending", () => {
    const desc = createOrderTrackingQuery();
    applyAvailabilityAwareOrder(fakeKnex, desc.query, fakeStrapi, "LastEditedByAdminAt:desc");
    expect(desc.calls.at(-1)).toEqual({ method: "orderBy", args: ["p.id", "desc"] });

    const asc = createOrderTrackingQuery();
    applyAvailabilityAwareOrder(fakeKnex, asc.query, fakeStrapi, "LastEditedByAdminAt:asc");
    expect(asc.calls.at(-1)).toEqual({ method: "orderBy", args: ["p.id", "asc"] });
  });

  it("prepends a stable stock-partitioned curated ordering ahead of the normal sort", () => {
    const { query, calls } = createOrderTrackingQuery();
    applyAvailabilityAwareOrder(fakeKnex, query, fakeStrapi, "LastEditedByAdminAt:desc", [
      73, 11, 42,
    ]);

    const orderByRawCalls = calls.filter((call) => call.method === "orderByRaw");

    // Tier 0/1 (curated, in-stock then out-of-stock) ahead of tier 2/3 (fallback).
    expect(orderByRawCalls[0].args[0]).toContain("string_to_array(?, ',')::integer[]");
    expect(orderByRawCalls[0].args[0]).toContain("CASE");
    expect(orderByRawCalls[0].args[1]).toEqual(["73,11,42", "73,11,42"]);

    // Curated items keep their exact admin order within their tier.
    expect(orderByRawCalls[1].args).toEqual([
      "array_position(string_to_array(?, ',')::integer[], p.id) ASC NULLS LAST",
      ["73,11,42"],
    ]);

    // The existing sort-key clause is untouched and still applied after curated tiering
    // (it only affects ordering within the fallback tiers, since curated rows are
    // already fully ordered by the two clauses above).
    expect(orderByRawCalls[2].args[0]).toBe(
      "COALESCE(p.last_edited_by_admin_at, p.published_at, p.created_at) DESC",
    );
  });

  it("falls back to the plain availability-first ordering when there are no curated ids", () => {
    const { query, calls } = createOrderTrackingQuery();
    applyAvailabilityAwareOrder(fakeKnex, query, fakeStrapi, "LastEditedByAdminAt:desc", []);

    const orderByRawCalls = calls.filter((call) => call.method === "orderByRaw");
    expect(orderByRawCalls[0].args[0]).not.toContain("string_to_array");
    expect(orderByRawCalls[0].args[0].endsWith(" DESC")).toBe(true);
  });

  it("bypasses the hide-discounted-on-newest exclusion for curated picks", () => {
    const calls: string[] = [];
    const subBuilder: any = {
      whereNotExists: () => {
        calls.push("sub.whereNotExists");
        return subBuilder;
      },
      orWhereIn: (column: string, ids: unknown[]) => {
        calls.push(`sub.orWhereIn:${column}:${(ids as number[]).join(",")}`);
        return subBuilder;
      },
    };
    const query: any = {
      whereNotExists: () => {
        calls.push("whereNotExists");
        return query;
      },
      where: (fn: (this: any) => void) => {
        calls.push("where");
        fn.call(subBuilder);
        return query;
      },
    };

    applyExcludeDiscountFilter(fakeKnex, query, fakeStrapi, true);
    expect(calls).toEqual(["whereNotExists"]);

    calls.length = 0;
    applyExcludeDiscountFilter(fakeKnex, query, fakeStrapi, true, [5, 9]);
    expect(calls).toEqual(["where", "sub.whereNotExists", "sub.orWhereIn:p.id:5,9"]);
  });
});
