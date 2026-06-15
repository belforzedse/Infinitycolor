import { buildPLPProductsQuery, parsePLPQuery, type PLPQuery } from "../plp";

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
      size: "XL",
    };

    const params = buildPLPProductsQuery(query, ["parent", "child"], 24);
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
    expect(entries["filters[$and][4][$or][0][Title][$containsi]"]).toEqual(["scarf"]);
    expect(
      entries[
        "filters[$and][5][product_variations][product_variation_size][Title][$eq]"
      ],
    ).toEqual(["XL"]);
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
