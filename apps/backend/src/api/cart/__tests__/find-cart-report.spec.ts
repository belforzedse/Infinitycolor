import {
  buildCartReportFilters,
  boundedCartReportPagination,
  CART_REPORT_QUERY,
  findCartReportHandler,
  projectCartReportRow,
} from "../controllers/handlers/findCartReport";

function createContext(query: Record<string, unknown> = {}) {
  return {
    query,
    body: undefined as unknown,
    set: jest.fn(),
  };
}

function installStrapi(rows: unknown[] = [], total = rows.length) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const count = jest.fn().mockResolvedValue(total);
  const strapi = {
    query: jest.fn(() => ({ findMany, count })),
  };
  return { strapi, findMany, count };
}

describe("admin cart report", () => {
  it("maps phone filters onto the users-permissions phone column", () => {
    expect(
      buildCartReportFilters({
        user: { Phone: { $containsi: "0912" } },
      }),
    ).toEqual({
      user: { phone: { $containsi: "0912" } },
    });
  });

  it("drops unknown filter operators and extra user fields", () => {
    expect(
      buildCartReportFilters({
        Status: { $eq: "Pending", $contains: "secret" },
        user: {
          email: { $containsi: "must-not-filter" },
          user_info: { FirstName: { $containsi: "Ali" }, NationalCode: "x" },
        },
      }),
    ).toEqual({
      Status: { $eq: "Pending" },
      user: { user_info: { FirstName: { $containsi: "Ali" } } },
    });
  });

  it("caps page size at 100", () => {
    expect(boundedCartReportPagination({ page: "0", pageSize: "500" })).toEqual({
      page: 1,
      pageSize: 100,
    });
  });

  it("projects names and phones without leaking profile or credential fields", () => {
    const projected = projectCartReportRow({
      id: 7,
      Status: "Pending",
      createdAt: "2026-09-09T00:00:00.000Z",
      user: {
        id: 2,
        phone: "09120000000",
        email: "must-not-leak@example.test",
        password: "secret",
        user_info: {
          id: 3,
          FirstName: "سارا",
          LastName: "کریمی",
          NationalCode: "secret-code",
          Bio: "private",
        },
      },
      cart_items: [
        {
          id: 11,
          Sum: "120000",
          Count: 1,
          product_variation: {
            id: 8,
            SKU: "hidden",
            product: {
              id: 9,
              Title: "کت",
              Description: "must-not-leak",
              CoverImage: {
                id: 12,
                name: "cover",
                url: "/uploads/cover.jpg",
                formats: { thumbnail: { url: "/uploads/thumb.jpg" } },
                hash: "must-not-leak",
              },
            },
          },
        },
      ],
    });

    expect(projected.attributes.user.data?.attributes.Phone).toBe("09120000000");
    expect(projected.attributes.user.data?.attributes.user_info.data?.attributes).toEqual({
      FirstName: "سارا",
      LastName: "کریمی",
    });
    expect(projected.attributes.cart_items.data[0]?.attributes.product_variation.data).toEqual({
      id: 8,
      attributes: {
        product: {
          data: {
            id: 9,
            attributes: {
              Title: "کت",
              CoverImage: {
                data: {
                  id: 12,
                  attributes: {
                    name: "cover",
                    url: "/uploads/cover.jpg",
                    formats: { thumbnail: { url: "/uploads/thumb.jpg" } },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("must-not-leak");
    expect(JSON.stringify(projected)).not.toContain("secret-code");
    expect(JSON.stringify(projected)).not.toContain("hidden");
  });

  it("keeps an empty customer slot when the cart has no user", () => {
    const projected = projectCartReportRow({
      id: 1,
      Status: "Empty",
      cart_items: null,
    });
    expect(projected.attributes.user.data).toBeNull();
    expect(projected.attributes.cart_items.data).toEqual([]);
  });

  it("loads the bounded projection without forwarding caller populate or auth sanitize", async () => {
    const { strapi, findMany, count } = installStrapi(
      [
        {
          id: 4,
          Status: "Left",
          createdAt: "2026-09-01T00:00:00.000Z",
          user: {
            id: 2,
            phone: "0912",
            user_info: { id: 3, FirstName: "Ali", LastName: "Rezaei" },
          },
          cart_items: [],
        },
      ],
      49,
    );
    const ctx = createContext({
      filters: { user: { phone: { $containsi: "0912" } } },
      pagination: { page: 2, pageSize: 10 },
      populate: { user: { populate: "*" } },
      fields: ["Status", "secret"],
      sort: "id:asc",
    });

    const body = await findCartReportHandler(
      strapi as unknown as import("@strapi/strapi").Strapi,
    )(ctx);

    expect(findMany).toHaveBeenCalledWith({
      where: { user: { phone: { $containsi: "0912" } } },
      ...CART_REPORT_QUERY,
      offset: 10,
      limit: 10,
    });
    expect(count).toHaveBeenCalledWith({
      where: { user: { phone: { $containsi: "0912" } } },
    });
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(body.data[0].attributes.user.data?.attributes.user_info.data?.attributes).toEqual({
      FirstName: "Ali",
      LastName: "Rezaei",
    });
    expect(body.meta.pagination).toEqual({
      page: 2,
      pageSize: 10,
      pageCount: 5,
      total: 49,
    });
  });
});
