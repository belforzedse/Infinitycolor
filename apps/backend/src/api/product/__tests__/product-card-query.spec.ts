import {
  buildRatingOrderClause,
  isEnabledCardParam,
  parseCardPriceFilter,
  parseFindProductCardsPagination,
  parseQuerySortKey,
} from "../services/product-card-query";

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
});
