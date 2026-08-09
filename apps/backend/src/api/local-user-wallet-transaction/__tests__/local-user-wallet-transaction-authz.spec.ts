/**
 * Ownership-scoping regression tests for local-user-wallet-transaction.
 *
 * The content-API grant table (Customer has find/findOne on this content-type) only
 * answers "can this role call this action at all" - it has no concept of row ownership.
 * Without the controller override, any Customer could read another user's wallet
 * transactions via the plain (unfiltered) list, or by id. These tests pin the fix.
 */

const baseStrapi = {
  query: jest.fn(() => ({
    findOne: jest.fn(async ({ where }: any) => ({
      id: where.id,
      IsActive: true,
      blocked: false,
      role: {
        name: where.id === 7 ? "Superadmin" : where.id === 9 ? "Store Manager" : "Customer",
      },
    })),
  })),
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
      };
      const ext = extension(params);
      Object.setPrototypeOf(ext, base);
      return ext;
    },
  },
}));

import controllerImport from "../controllers/local-user-wallet-transaction";

const controller = controllerImport as any;

const TX_UID = "api::local-user-wallet-transaction.local-user-wallet-transaction";
const WALLET_UID = "api::local-user-wallet.local-user-wallet";

function createCtx(overrides: Record<string, any> = {}): any {
  return {
    query: {},
    params: {},
    state: { user: { id: 6 } },
    notFound: jest.fn((message: string) => ({ status: 404, message })),
    ...overrides,
  };
}

function mockQueries({
  wallet,
  ownTxns,
  txnWithWallet,
}: {
  wallet?: { id: number } | null;
  ownTxns?: Array<{ id: number }>;
  txnWithWallet?: any;
}) {
  baseStrapi.db.query.mockImplementation((uid: string) => {
    if (uid === WALLET_UID) {
      return { findOne: jest.fn().mockResolvedValue(wallet ?? null) };
    }
    if (uid === TX_UID) {
      return {
        findMany: jest.fn().mockResolvedValue(ownTxns ?? []),
        findOne: jest.fn().mockResolvedValue(txnWithWallet ?? null),
      };
    }
    return {};
  });
}

describe("local-user-wallet-transaction ownership scoping", () => {
  let txnController: any;

  beforeEach(() => {
    jest.clearAllMocks();
    txnController = controller({ strapi: baseStrapi as any });
  });

  describe("find", () => {
    it("scopes a Customer's list to their own wallet's transaction ids", async () => {
      mockQueries({ wallet: { id: 6 }, ownTxns: [{ id: 5 }, { id: 8 }] });
      const ctx = createCtx({ state: { user: { id: 6, role: { name: "Customer" } } } });

      await txnController.find(ctx);

      expect(ctx.query.filters).toEqual({ id: { $in: [5, 8] } });
      expect(Object.getPrototypeOf(txnController).find).toHaveBeenCalledWith(ctx);
    });

    it("forces a sentinel id when the Customer's wallet has no transactions", async () => {
      mockQueries({ wallet: { id: 6 }, ownTxns: [] });
      const ctx = createCtx({ state: { user: { id: 6, role: { name: "Customer" } } } });

      await txnController.find(ctx);

      // An empty $in array does not round-trip through Koa's ctx.query setter and
      // silently vanishes, which would leave the list completely unfiltered - this is
      // exactly the case that leaked another user's transaction during manual testing.
      expect(ctx.query.filters).toEqual({ id: { $in: [-1] } });
    });

    it("forces a sentinel id when the Customer has no wallet at all", async () => {
      mockQueries({ wallet: null });
      const ctx = createCtx({ state: { user: { id: 6, role: { name: "Customer" } } } });

      await txnController.find(ctx);

      expect(ctx.query.filters).toEqual({ id: { $in: [-1] } });
    });

    it("does not scope Superadmin", async () => {
      const ctx = createCtx({ state: { user: { id: 7, role: { name: "Superadmin" } } } });

      await txnController.find(ctx);

      expect(baseStrapi.db.query).not.toHaveBeenCalled();
      expect(ctx.query.filters).toBeUndefined();
      expect(Object.getPrototypeOf(txnController).find).toHaveBeenCalledWith(ctx);
    });
  });

  describe("findOne", () => {
    it("allows a Customer to read their own transaction", async () => {
      mockQueries({ txnWithWallet: { id: 5, user_wallet: { user: { id: 6 } } } });
      const ctx = createCtx({
        params: { id: "5" },
        state: { user: { id: 6, role: { name: "Customer" } } },
      });

      await txnController.findOne(ctx);

      expect(ctx.notFound).not.toHaveBeenCalled();
      expect(Object.getPrototypeOf(txnController).findOne).toHaveBeenCalledWith(ctx);
    });

    it("blocks a Customer from reading another user's transaction (404, not 403)", async () => {
      mockQueries({ txnWithWallet: { id: 1, user_wallet: { user: { id: 11 } } } });
      const ctx = createCtx({
        params: { id: "1" },
        state: { user: { id: 6, role: { name: "Customer" } } },
      });

      await txnController.findOne(ctx);

      expect(ctx.notFound).toHaveBeenCalledWith("Transaction not found");
      expect(Object.getPrototypeOf(txnController).findOne).not.toHaveBeenCalled();
    });

    it("blocks a Customer when the transaction does not exist", async () => {
      mockQueries({ txnWithWallet: null });
      const ctx = createCtx({
        params: { id: "999" },
        state: { user: { id: 6, role: { name: "Customer" } } },
      });

      await txnController.findOne(ctx);

      expect(ctx.notFound).toHaveBeenCalledWith("Transaction not found");
      expect(Object.getPrototypeOf(txnController).findOne).not.toHaveBeenCalled();
    });

    it("scopes Store manager to their own transactions", async () => {
      mockQueries({ txnWithWallet: { id: 1, user_wallet: { user: { id: 22 } } } });
      const ctx = createCtx({
        params: { id: "1" },
        state: { user: { id: 9, role: { name: "Store manager" } } },
      });

      await txnController.findOne(ctx);

      expect(baseStrapi.db.query).toHaveBeenCalledWith(TX_UID);
      expect(ctx.notFound).toHaveBeenCalledWith("Transaction not found");
      expect(Object.getPrototypeOf(txnController).findOne).not.toHaveBeenCalled();
    });
  });
});
