/**
 * Ownership-scoping regression tests for local-user-address.
 *
 * The content-API grant table (Customer has find/findOne/update/delete on this
 * content-type) only answers "can this role call this action at all" - it has no
 * concept of row ownership. Without the controller override, any Customer could
 * target another user's address by id. These tests pin the fix.
 */

const baseStrapi = {
  db: {
    query: jest.fn(),
  },
};

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, extension: any) => (params: any) => {
      const base = {
        find: jest.fn(async () => ({ data: [], meta: {} })),
        findOne: jest.fn(async () => ({ data: { id: 1 }, meta: {} })),
        update: jest.fn(async () => ({ data: { id: 1 }, meta: {} })),
        delete: jest.fn(async () => ({ data: { id: 1 }, meta: {} })),
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

function createCtx(overrides: Record<string, any> = {}): any {
  return {
    query: {},
    params: {},
    state: { user: { id: 6 } },
    notFound: jest.fn((message: string) => ({ status: 404, message })),
    ...overrides,
  };
}

function queryMock(impl: Partial<{ findOne: any; findMany: any }>) {
  return {
    findOne: impl.findOne ?? jest.fn(),
    findMany: impl.findMany ?? jest.fn(),
  };
}

describe("local-user-address ownership scoping", () => {
  let addressController: any;

  beforeEach(() => {
    jest.clearAllMocks();
    addressController = controller({ strapi: baseStrapi as any });
  });

  describe("find", () => {
    it("scopes a Customer's list to their own address ids", async () => {
      baseStrapi.db.query.mockReturnValue(
        queryMock({ findMany: jest.fn().mockResolvedValue([{ id: 2 }, { id: 9 }]) }),
      );
      const ctx = createCtx({ state: { user: { id: 6, role: { name: "Customer" } } } });

      await addressController.find(ctx);

      expect(baseStrapi.db.query).toHaveBeenCalledWith(ADDRESS_UID);
      expect(ctx.query.filters).toEqual({ id: { $in: [2, 9] } });
      expect(Object.getPrototypeOf(addressController).find).toHaveBeenCalledWith(ctx);
    });

    it("forces a sentinel id (never a bypass) when the Customer owns nothing", async () => {
      baseStrapi.db.query.mockReturnValue(queryMock({ findMany: jest.fn().mockResolvedValue([]) }));
      const ctx = createCtx({ state: { user: { id: 6, role: { name: "Customer" } } } });

      await addressController.find(ctx);

      // An empty $in array does not round-trip through Koa's ctx.query setter and
      // silently vanishes, which would leave the list completely unfiltered.
      expect(ctx.query.filters).toEqual({ id: { $in: [-1] } });
    });

    it("does not scope management roles", async () => {
      const ctx = createCtx({ state: { user: { id: 7, role: { name: "Superadmin" } } } });

      await addressController.find(ctx);

      expect(baseStrapi.db.query).not.toHaveBeenCalled();
      expect(ctx.query.filters).toBeUndefined();
      expect(Object.getPrototypeOf(addressController).find).toHaveBeenCalledWith(ctx);
    });
  });

  describe("findOne / update / delete", () => {
    const cases: Array<"findOne" | "update" | "delete"> = ["findOne", "update", "delete"];

    it.each(cases)("%s: allows a Customer to access their own address", async (action) => {
      baseStrapi.db.query.mockReturnValue(
        queryMock({ findOne: jest.fn().mockResolvedValue({ id: 2, user: { id: 6 } }) }),
      );
      const ctx = createCtx({
        params: { id: "2" },
        state: { user: { id: 6, role: { name: "Customer" } } },
      });

      await addressController[action](ctx);

      expect(ctx.notFound).not.toHaveBeenCalled();
      expect(Object.getPrototypeOf(addressController)[action]).toHaveBeenCalledWith(ctx);
    });

    it.each(cases)("%s: blocks a Customer from another user's address (404, not 403)", async (action) => {
      baseStrapi.db.query.mockReturnValue(
        queryMock({ findOne: jest.fn().mockResolvedValue({ id: 3, user: { id: 11 } }) }),
      );
      const ctx = createCtx({
        params: { id: "3" },
        state: { user: { id: 6, role: { name: "Customer" } } },
      });

      await addressController[action](ctx);

      expect(ctx.notFound).toHaveBeenCalledWith("Address not found");
      expect(Object.getPrototypeOf(addressController)[action]).not.toHaveBeenCalled();
    });

    it.each(cases)("%s: blocks a Customer when the address does not exist", async (action) => {
      baseStrapi.db.query.mockReturnValue(queryMock({ findOne: jest.fn().mockResolvedValue(null) }));
      const ctx = createCtx({
        params: { id: "999" },
        state: { user: { id: 6, role: { name: "Customer" } } },
      });

      await addressController[action](ctx);

      expect(ctx.notFound).toHaveBeenCalledWith("Address not found");
      expect(Object.getPrototypeOf(addressController)[action]).not.toHaveBeenCalled();
    });

    it.each(cases)("%s: management roles bypass ownership entirely", async (action) => {
      const ctx = createCtx({
        params: { id: "3" },
        state: { user: { id: 9, role: { name: "Store manager" } } },
      });

      await addressController[action](ctx);

      expect(baseStrapi.db.query).not.toHaveBeenCalled();
      expect(ctx.notFound).not.toHaveBeenCalled();
      expect(Object.getPrototypeOf(addressController)[action]).toHaveBeenCalledWith(ctx);
    });
  });
});
