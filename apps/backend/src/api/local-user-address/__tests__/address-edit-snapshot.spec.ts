/**
 * Editing a saved address must not rewrite where already-placed orders went.
 *
 * `orders.delivery_address` points straight at the shopper's address-book row,
 * so a PUT that mutates that row silently changes the recorded destination of
 * every order ever shipped to it -- including ones already handed to the carrier
 * under the old address. These tests pin the freeze-before-write that gives those
 * orders a private copy of the values they were placed with.
 */

const baseStrapi: any = {
  query: jest.fn(() => ({
    findOne: jest.fn(async ({ where }: any) => ({
      id: where.id,
      IsActive: true,
      blocked: false,
      role: { name: where.id === 7 ? "Superadmin" : "Customer" },
    })),
  })),
  db: {
    query: jest.fn(),
    transaction: jest.fn(async (cb: any) => cb({ trx: { id: "trx" } })),
  },
};

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, extension: any) => (params: any) => {
      const base = {
        update: jest.fn(async () => ({ data: { id: 2 }, meta: {} })),
        delete: jest.fn(async () => ({ data: { id: 2 }, meta: {} })),
        sanitizeOutput: jest.fn(async (entity: any) => entity),
        transformResponse: jest.fn((entity: any) => ({ data: entity })),
      };
      const ext = extension(params);
      Object.setPrototypeOf(ext, base);
      return ext;
    },
  },
}));

import controllerImport from "../controllers/local-user-address";

const controller = controllerImport as any;

const ADDRESS_UID = "api::local-user-address.local-user-address";
const ORDER_UID = "api::order.order";
const RESERVE_GROUP_UID = "api::reserve-group.reserve-group";

const SAVED_ADDRESS = {
  id: 2,
  user: { id: 6 },
  shipping_city: { id: 10 },
  PostalCode: "1234567890",
  FullAddress: "نشانی قدیمی",
  FullName: "گیرنده",
  Phone: "+989121111111",
  Description: null,
  IsTemporary: false,
};

const createCtx = (overrides: Record<string, any> = {}): any => ({
  query: {},
  params: { id: "2" },
  request: { body: { data: { FullAddress: "نشانی جدید" } } },
  state: { user: { id: 6, role: { name: "Customer" } } },
  notFound: jest.fn((message: string) => ({ status: 404, message })),
  ...overrides,
});

/** Routes db.query by uid so order/reserve-group lookups stay distinguishable. */
function wireQueries({ orderIds = [], reserveGroupIds = [] as number[] } = {} as any) {
  const addressQuery = {
    findOne: jest.fn().mockResolvedValue(SAVED_ADDRESS),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 99 }),
    update: jest.fn().mockResolvedValue({ id: 2 }),
  };
  const orderQuery = {
    findMany: jest.fn().mockResolvedValue(orderIds.map((id: number) => ({ id }))),
    update: jest.fn().mockResolvedValue({}),
  };
  const reserveGroupQuery = {
    findMany: jest.fn().mockResolvedValue(reserveGroupIds.map((id: number) => ({ id }))),
    update: jest.fn().mockResolvedValue({}),
  };
  baseStrapi.db.query.mockImplementation((uid: string) => {
    if (uid === ORDER_UID) return orderQuery;
    if (uid === RESERVE_GROUP_UID) return reserveGroupQuery;
    return addressQuery;
  });
  return { addressQuery, orderQuery, reserveGroupQuery };
}

describe("local-user-address update freezes referencing orders", () => {
  let addressController: any;

  beforeEach(() => {
    jest.clearAllMocks();
    addressController = controller({ strapi: baseStrapi });
  });

  it("snapshots the pre-edit values and repoints every referencing order", async () => {
    const { addressQuery, orderQuery } = wireQueries({ orderIds: [41, 42] });
    const ctx = createCtx();

    await addressController.update(ctx);

    // The copy carries the values the orders were placed with, hidden from the book.
    expect(addressQuery.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          IsTemporary: true,
          shipping_city: 10,
          PostalCode: "1234567890",
          FullAddress: "نشانی قدیمی",
          FullName: "گیرنده",
          Phone: "+989121111111",
          user: 6,
        }),
      }),
    );
    expect(orderQuery.update).toHaveBeenCalledTimes(2);
    for (const id of [41, 42]) {
      expect(orderQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id }, data: { delivery_address: 99 } }),
      );
    }
    // The book row is still edited in place, so its id survives the edit.
    expect(Object.getPrototypeOf(addressController).update).toHaveBeenCalledWith(ctx);
    expect(addressQuery.update).not.toHaveBeenCalled();
  });

  it("repoints reserve groups alongside their orders", async () => {
    const { reserveGroupQuery } = wireQueries({ orderIds: [41], reserveGroupIds: [7] });

    await addressController.update(createCtx());

    expect(reserveGroupQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 }, data: { delivery_address: 99 } }),
    );
  });

  it("skips the snapshot entirely when no order points at the address", async () => {
    const { addressQuery, orderQuery } = wireQueries({});
    const ctx = createCtx();

    await addressController.update(ctx);

    expect(addressQuery.create).not.toHaveBeenCalled();
    expect(orderQuery.update).not.toHaveBeenCalled();
    expect(Object.getPrototypeOf(addressController).update).toHaveBeenCalledWith(ctx);
  });

  it("does not freeze anything when the caller does not own the address", async () => {
    const { addressQuery } = wireQueries({ orderIds: [41] });
    addressQuery.findOne.mockResolvedValue({ ...SAVED_ADDRESS, user: { id: 99 } });
    const ctx = createCtx();

    await addressController.update(ctx);

    expect(ctx.notFound).toHaveBeenCalledWith("Address not found");
    expect(addressQuery.create).not.toHaveBeenCalled();
    expect(Object.getPrototypeOf(addressController).update).not.toHaveBeenCalled();
  });
});
