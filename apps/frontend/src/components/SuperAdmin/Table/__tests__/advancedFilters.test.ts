import {
  buildAdvancedFiltersObject,
  buildAdvancedFiltersQuery,
  buildSuperAdminTableRequestUrl,
  parseAdvancedFiltersParam,
  sanitizeAdvancedFilters,
  serializeAdvancedFiltersParam,
  type AdvancedFilterField,
} from "../advancedFilters";

const fields: AdvancedFilterField[] = [
  { id: "[Title]", title: "نام", type: "text" },
  { id: "[contract][Amount]", title: "مبلغ", type: "number" },
  { id: "[createdAt]", title: "تاریخ ایجاد", type: "date" },
  { id: "[IsActive]", title: "فعال", type: "boolean" },
  { id: "[Status]", title: "وضعیت", type: "select", options: [{ id: "Active", title: "فعال" }] },
];

describe("advanced super-admin filters", () => {
  it("parses the legacy encoded URL state safely", () => {
    const raw = serializeAdvancedFiltersParam([
      { field: "[Title]", operator: "$containsi", value: "مانتو" },
    ]);

    expect(parseAdvancedFiltersParam(raw)).toEqual([
      { field: "[Title]", operator: "$containsi", value: "مانتو" },
    ]);
    expect(parseAdvancedFiltersParam("not-json")).toEqual([]);
  });

  it("drops unknown fields, unsupported operators, and incomplete values", () => {
    expect(
      sanitizeAdvancedFilters(
        [
          { field: "[Title]", operator: "$containsi", value: "کیف" },
          { field: "[Title]", operator: "$gt", value: "10" },
          { field: "[missing]", operator: "$eq", value: "x" },
          { field: "[createdAt]", operator: "$gte", value: "" },
        ],
        fields,
      ),
    ).toEqual([{ field: "[Title]", operator: "$containsi", value: "کیف" }]);
  });

  it("builds nested Strapi v4 filter objects with typed values", () => {
    expect(
      buildAdvancedFiltersObject(
        [
          { field: "[Title]", operator: "$containsi", value: "کفش" },
          { field: "[contract][Amount]", operator: "$gte", value: "250000" },
          { field: "[IsActive]", operator: "$eq", value: "true" },
          { field: "[createdAt]", operator: "$notNull", value: "" },
        ],
        fields,
      ),
    ).toEqual({
      Title: { $containsi: "کفش" },
      contract: { Amount: { $gte: 250000 } },
      IsActive: { $eq: true },
      createdAt: { $notNull: true },
    });
  });

  it("serializes filters and pagination as Strapi-compatible query params", () => {
    const query = buildAdvancedFiltersQuery(
      [
        { field: "[Title]", operator: "$containsi", value: "کیف زنانه" },
        { field: "[Status]", operator: "$eq", value: "Active" },
      ],
      fields,
    );

    expect(query).toContain(
      "filters[Title][$containsi]=%DA%A9%DB%8C%D9%81%20%D8%B2%D9%86%D8%A7%D9%86%D9%87",
    );
    expect(query).toContain("filters[Status][$eq]=Active");

    expect(
      buildSuperAdminTableRequestUrl({
        url: "/orders?sort[0]=createdAt:desc",
        page: "2",
        pageSize: "50",
        filters: [{ field: "[contract][Amount]", operator: "$lt", value: "900000" }],
        filterFields: fields,
      }),
    ).toBe(
      "/orders?sort[0]=createdAt:desc&pagination[page]=2&pagination[pageSize]=50&filters[contract][Amount][$lt]=900000",
    );
  });
});
