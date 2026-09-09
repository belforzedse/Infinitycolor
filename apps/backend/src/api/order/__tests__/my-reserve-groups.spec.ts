import {
  getMyReserveGroupHandler,
  listMyReserveGroupsHandler,
} from "../controllers/handlers/myReserveGroups";

jest.mock("../../../utils/roles", () => ({
  resolveCustomerTargetUserId: jest.fn(async (ctx: any) => ctx?.state?.user?.id ?? null),
}));

function createStrapi(groups: any[], orderCount = 2) {
  const groupQuery = {
    findMany: jest.fn().mockResolvedValue(groups),
    findOne: jest.fn().mockResolvedValue(groups[0] ?? null),
    count: jest.fn().mockResolvedValue(groups.length),
  };
  const orderQuery = { count: jest.fn().mockResolvedValue(orderCount) };
  return {
    strapi: {
      log: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
      db: {
        query: jest.fn((uid: string) =>
          uid === "api::order.order" ? orderQuery : groupQuery,
        ),
      },
    } as any,
    groupQuery,
    orderQuery,
  };
}

const group = (overrides: Record<string, unknown> = {}) => ({
  id: 5,
  groupKey: "grp-1",
  State: "ReadyToFulfill",
  ClosureReason: "Expired",
  expiresAt: "2026-09-01T00:00:00.000Z",
  activatedAt: "2026-08-30T00:00:00.000Z",
  closedAt: "2026-09-01T00:00:00.000Z",
  lastOrderAttachedAt: "2026-08-31T00:00:00.000Z",
  lastActivityAt: "2026-09-01T00:00:00.000Z",
  ShippingCostPaid: 45_000,
  ShippingMethodTitle: "پست پیشتاز",
  ShippingBarcode: "ANP-1",
  rootOrder: { id: 41 },
  delivery_address: {
    FullAddress: "خیابان آزادی",
    shipping_city: { Title: "تهران", shipping_province: { Title: "تهران" } },
  },
  ...overrides,
});

const ctx = (extra: Record<string, unknown> = {}) => ({
  state: { user: { id: 10 } },
  query: {},
  unauthorized: jest.fn(),
  notFound: jest.fn(() => ({ notFound: true })),
  ...extra,
});

describe("customer reserve group endpoints", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns closed groups too, so reserve history does not disappear", async () => {
    const { strapi, groupQuery } = createStrapi([group()]);

    const result: any = await listMyReserveGroupsHandler(strapi, ctx() as any);

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      reserveGroupId: "grp-1",
      state: "ReadyToFulfill",
      closureReason: "Expired",
      isActive: false,
      orderCount: 2,
      shippingCostPaid: 45_000,
      shippingBarcode: "ANP-1",
      rootOrderId: 41,
    });
    // Only the state that never shipped is excluded.
    expect(groupQuery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          State: { $ne: "PendingActivation" },
          owner: { id: 10 },
        }),
      }),
    );
  });

  it("scopes every read to the signed-in owner", async () => {
    const { strapi, groupQuery } = createStrapi([group()]);

    await getMyReserveGroupHandler(strapi, ctx({ params: { groupKey: "grp-1" } }) as any);

    expect(groupQuery.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupKey: "grp-1", owner: { id: 10 } } }),
    );
  });

  it("marks a window with a future deadline as active", async () => {
    const future = new Date(Date.now() + 10 * 3_600_000).toISOString();
    const { strapi } = createStrapi([group({ State: "Active", ClosureReason: null, expiresAt: future })]);

    const result: any = await listMyReserveGroupsHandler(strapi, ctx() as any);

    expect(result.data[0].isActive).toBe(true);
  });

  it("does not call an expired Active row active", async () => {
    const { strapi } = createStrapi([
      group({ State: "Active", ClosureReason: null, expiresAt: "2020-01-01T00:00:00.000Z" }),
    ]);

    const result: any = await listMyReserveGroupsHandler(strapi, ctx() as any);

    expect(result.data[0].isActive).toBe(false);
  });

  it("renders the destination the way the address picker does", async () => {
    const { strapi } = createStrapi([group()]);

    const result: any = await listMyReserveGroupsHandler(strapi, ctx() as any);

    expect(result.data[0].destination).toBe("خیابان آزادی - تهران، تهران");
  });

  it("404s an unknown group instead of leaking an empty payload", async () => {
    const { strapi, groupQuery } = createStrapi([]);
    groupQuery.findOne.mockResolvedValue(null);
    const c = ctx({ params: { groupKey: "nope" } });

    await getMyReserveGroupHandler(strapi, c as any);

    expect(c.notFound).toHaveBeenCalled();
  });
});
