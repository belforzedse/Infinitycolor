jest.mock("@strapi/utils", () => ({
  sanitize: { contentAPI: { output: jest.fn(async (rows) => rows) } },
}));

import controller from "../admin-order-list";
import routeConfig from "../../routes/admin-order-list";

function createContext(body: Record<string, unknown> = {}) {
  return {
    request: { body },
    state: { auth: {}, user: { id: 1 } },
    body: null as any,
    badRequest: jest.fn(),
    set: jest.fn(),
  };
}

function installStrapi(rows: any[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const count = jest.fn().mockResolvedValue(49_518);
  const reserveFindMany = jest.fn().mockResolvedValue([]);
  const reserveCount = jest.fn().mockResolvedValue(7);
  const info = jest.fn();
  (global as any).strapi = {
    query: jest.fn((uid: string) =>
      uid === "api::reserve-group.reserve-group"
        ? { findMany: reserveFindMany, count: reserveCount }
        : { findMany, count },
    ),
    contentType: jest.fn(() => ({})),
    log: { info },
  };
  return { findMany, count, reserveFindMany, reserveCount, info };
}

describe("bounded admin orders list", () => {
  it("uses the order-read capability policy on every orders-list route", () => {
    const orderRead = {
      name: "global::require-capability",
      config: { capability: "order.read" },
    };
    expect(routeConfig.routes.map((route) => route.handler)).toEqual([
      "admin-order-list.query",
      "admin-order-list.counts",
      "admin-order-list.shippingMethods",
      "admin-order-list.queryReserveGroups",
      "admin-order-list.getReserveGroup",
    ]);
    for (const route of routeConfig.routes) {
      const policies = (route.config as { policies: unknown[] }).policies;
      expect(policies[0]).toEqual(orderRead);
    }
  });

  it.each([
    ["paying", { Status: { $in: ["Paying"] } }],
    ["inprogress", { Status: { $in: ["Started", "Shipment"] } }],
  ])("keeps the %s status tab in its own server-side bucket", async (tab, expected) => {
    const { findMany } = installStrapi();

    await controller.query(createContext({ tab }));

    expect(findMany.mock.calls[0][0].where.$and).toContainEqual(expected);
  });

  it("counts every tab from the same current filters and keeps active reserves separate", async () => {
    const { count, reserveCount } = installStrapi();
    count
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);
    const ctx = createContext({
      search: "Ali",
      shippingMethodCodes: ["post"],
      filters: [{ field: "[Description]", operator: "$containsi", value: "vip" }],
    });

    await controller.counts(ctx);

    expect(count).toHaveBeenCalledTimes(6);
    const baseConditions = [
      { Description: { $containsi: "vip" } },
      {
        $or: [
          { ShippingMethodCode: { $in: ["post"] } },
          {
            $and: [
              { ShippingMethodCode: { $null: true } },
              { shipping: { Code: { $in: ["post"] } } },
            ],
          },
        ],
      },
      {
        $or: [
          { contract: { external_id: { $containsi: "Ali" } } },
          { user: { user_info: { FirstName: { $containsi: "Ali" } } } },
          { user: { user_info: { LastName: { $containsi: "Ali" } } } },
          { ShippingBarcode: { $containsi: "Ali" } },
        ],
      },
    ];
    for (const [index, call] of count.mock.calls.entries()) {
      expect(call[0].where.$and).toEqual(expect.arrayContaining(baseConditions));
      if (index === 0) expect(call[0].where.$and).toEqual(baseConditions);
    }
    expect(count.mock.calls[1][0].where.$and).toContainEqual({
      Status: { $in: ["Paying"] },
    });
    expect(count.mock.calls[2][0].where.$and).toContainEqual({
      Status: { $in: ["Started", "Shipment"] },
    });
    expect(count.mock.calls[3][0].where.$and).toContainEqual({
      Status: { $in: ["Done"] },
    });
    expect(count.mock.calls[4][0].where.$and).toContainEqual({
      Status: { $in: ["Returned", "Cancelled"] },
    });
    expect(count.mock.calls[5][0].where.$and).toContainEqual({ Type: { $eq: "Manual" } });
    expect(count.mock.calls[3][0].where.$and).not.toContainEqual({
      Type: { $ne: "Manual" },
    });
    expect(count.mock.calls[5][0].where.$and).not.toContainEqual({
      Status: expect.anything(),
    });
    expect(reserveCount).toHaveBeenCalledWith({
      where: {
        State: { $eq: "Active" },
        expiresAt: { $gt: expect.any(String) },
      },
    });
    expect(ctx.body.data).toEqual({
      counts: {
        all: 12,
        paying: 2,
        inprogress: 4,
        completed: 5,
        cancelled: 1,
        manual: 3,
      },
      activeReserveGroups: 7,
    });
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("rejects malformed count criteria before any aggregate query", async () => {
    const { count, reserveCount } = installStrapi();
    const ctx = createContext({
      shippingMethodCodes: ["post", { code: "tipax" }],
    });

    await controller.counts(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Each shipping method code must be a string",
    );
    expect(count).not.toHaveBeenCalled();
    expect(reserveCount).not.toHaveBeenCalled();
  });

  it("rejects inherited object keys as order tabs before querying", async () => {
    const { findMany, count } = installStrapi();
    const ctx = createContext({ tab: "toString" });

    await controller.query(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith("Unsupported orders-list tab");
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it("uses the counter's active and unexpired reserve population on the reserve board", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-12T10:00:00.000Z"));
    try {
      const { reserveFindMany, reserveCount } = installStrapi();
      const ctx = createContext({ tab: "active" });

      await controller.queryReserveGroups(ctx);

      const where = {
        $and: [
          {
            State: { $eq: "Active" },
            expiresAt: { $gt: "2026-09-12T10:00:00.000Z" },
          },
        ],
      };
      expect(reserveFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where }),
      );
      expect(reserveCount).toHaveBeenCalledWith({ where });
    } finally {
      jest.useRealTimers();
    }
  });

  it("returns an explicit bounded projection and stable tab/sort query", async () => {
    const { findMany } = installStrapi([
      {
        id: 7,
        Description: "safe",
        Status: "Done",
        Date: "2026-08-06T00:00:00.000Z",
        user: {
          id: 2,
          phone: "synthetic",
          email: "must-not-leak@example.test",
          user_info: { id: 3, FirstName: "Test", LastName: "User", NationalCode: "secret" },
        },
        contract: { id: 4, Amount: 1000, private_note: "secret" },
      },
    ]);
    const ctx = createContext({
      page: 2,
      pageSize: 500,
      tab: "completed",
      sort: "newest",
      search: "synthetic-transaction",
      filters: [{ field: "[id]", operator: "$gte", value: "7" }],
    });

    await controller.query(ctx);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 100,
        limit: 100,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    const query = findMany.mock.calls[0][0];
    expect(query.where.$and).toEqual(
      expect.arrayContaining([
        { id: { $gte: 7 } },
        { Status: { $in: ["Done"] } },
        // A textual query fans out across the transaction id, customer name and
        // shipping barcode; numeric queries take the cheaper id-first branch.
        {
          $or: [
            { contract: { external_id: { $containsi: "synthetic-transaction" } } },
            { user: { user_info: { FirstName: { $containsi: "synthetic-transaction" } } } },
            { user: { user_info: { LastName: { $containsi: "synthetic-transaction" } } } },
            { ShippingBarcode: { $containsi: "synthetic-transaction" } },
          ],
        },
      ]),
    );
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(JSON.stringify(ctx.body)).not.toContain("must-not-leak");
    expect(JSON.stringify(ctx.body)).not.toContain("NationalCode");
    expect(ctx.body.data[0].attributes.user.data.attributes.user_info.data.attributes).toEqual({
      FirstName: "Test",
      LastName: "User",
    });
    expect(ctx.body.data[0].attributes.contract.data.attributes.Amount).toBe(1000);
    expect(ctx.body.meta.pagination).toEqual({
      page: 2,
      pageSize: 100,
      pageCount: 496,
      total: 49_518,
    });
  });

  it("keeps customer names and amounts even when auth-aware sanitize would strip relations", async () => {
    const { sanitize } = require("@strapi/utils");
    (sanitize.contentAPI.output as jest.Mock).mockImplementationOnce(async (rows: any[]) =>
      rows.map((row) => ({ ...row, user: undefined, contract: undefined })),
    );
    // Re-install after the destructive mock so the next call uses pass-through again
    // only for this assertion path we care about the controller not passing auth.
    installStrapi([
      {
        id: 9,
        Status: "Started",
        user: {
          id: 2,
          phone: "0912",
          user_info: { id: 3, FirstName: "Ali", LastName: "Rezaei" },
        },
        contract: { id: 4, Amount: 250000, Type: "Online", Status: "Confirmed", TaxPercent: 9 },
      },
    ]);
    const ctx = createContext({ page: 1, pageSize: 25, tab: "all", sort: "last-edited" });

    await controller.query(ctx);

    expect(sanitize.contentAPI.output).toHaveBeenCalledWith(
      expect.any(Array),
      expect.anything(),
    );
    expect(sanitize.contentAPI.output.mock.calls.at(-1)).toHaveLength(2);
  });

  it("resolves a numeric search against the order number without touching name columns", async () => {
    const { findMany } = installStrapi();
    const ctx = createContext({ search: "۱۲۳" });

    await controller.query(ctx);

    expect(findMany.mock.calls[0][0].where.$and).toEqual([
      {
        $or: [
          { id: { $eq: 123 } },
          { contract: { external_id: { $containsi: "123" } } },
          { ShippingBarcode: { $containsi: "123" } },
          { user: { phone: { $containsi: "123" } } },
        ],
      },
    ]);
  });

  it("rejects unknown filters before querying", async () => {
    const { findMany } = installStrapi();
    const ctx = createContext({
      filters: [{ field: "[user][password]", operator: "$containsi", value: "x" }],
    });

    await controller.query(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith("Unsupported orders-list filter field");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("combines selected shipping methods with OR semantics", async () => {
    const { findMany, count } = installStrapi();
    const ctx = createContext({ shippingMethodCodes: ["post", "tipax", "post"] });

    await controller.query(ctx);

    const shippingCondition = {
      $or: [
        { ShippingMethodCode: { $in: ["post", "tipax"] } },
        {
          $and: [
            { ShippingMethodCode: { $null: true } },
            { shipping: { Code: { $in: ["post", "tipax"] } } },
          ],
        },
      ],
    };
    expect(findMany.mock.calls[0][0].where.$and).toContainEqual(shippingCondition);
    expect(count).toHaveBeenCalledWith({ where: { $and: [shippingCondition] } });
  });

  it("rejects malformed shipping-method filters before querying", async () => {
    const { findMany } = installStrapi();
    const ctx = createContext({ shippingMethodCodes: ["post", { code: "tipax" }] });

    await controller.query(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith(
      "Each shipping method code must be a string",
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns bounded shipping-method checkbox options", async () => {
    const { findMany } = installStrapi([
      { id: 1, Title: "پست", Code: "post", SortOrder: 1 },
      { id: 2, Title: "تیپاکس", Code: "tipax", SortOrder: 2 },
      { id: 3, Title: "پست تکراری", Code: "post", SortOrder: 3 },
      { id: 4, Title: "حضوری", Code: null, SortOrder: 4 },
    ]);
    const ctx = createContext();

    await controller.shippingMethods(ctx);

    expect(findMany).toHaveBeenCalledWith({
      select: ["id", "Title", "Code", "SortOrder"],
      orderBy: [{ SortOrder: "asc" }, { id: "asc" }],
      limit: 100,
    });
    expect(ctx.body).toEqual({
      data: [
        { code: "post", title: "پست" },
        { code: "tipax", title: "تیپاکس" },
        { code: "4", title: "حضوری" },
      ],
    });
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
});
