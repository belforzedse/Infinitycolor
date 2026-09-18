/**
 * Cross-user cart ownership.
 *
 * These tests run the real handlers against the real service ops over a small
 * in-memory store that actually evaluates the `where` clause, including the
 * `cart: { user: { id } }` scoping. That matters: a mocked `findOne` that ignores
 * its filter would keep passing if the ownership scoping were removed, which is
 * exactly the regression being guarded here.
 */
import { updateItemHandler } from "../controllers/handlers/updateItem";
import { removeItemHandler } from "../controllers/handlers/removeItem";
import { getMyCartHandler } from "../controllers/handlers/getMyCart";
import { checkStockHandler } from "../controllers/handlers/checkStock";
import { updateCartItemOp } from "../services/ops/updateCartItem";
import { removeCartItemOp } from "../services/ops/removeCartItem";
import { checkCartStockOp } from "../services/ops/checkCartStock";
import { createCtx } from "../../../__tests__/helpers/test-utils";

const USER_A = 1;
const USER_B = 2;

type CartRow = { id: number; user: { id: number }; Status: string };
type CartItemRow = {
  id: number;
  cart: CartRow;
  Count: number;
  Sum: number;
  product_variation: any;
};

const variationWithStock = (count: number, reservedCount = 0) => ({
  id: 900,
  Price: 1000,
  IsPublished: true,
  product: { id: 800, Title: "Test", SKU: "SKU-1", Status: "Active", removedAt: null },
  product_stock: { id: 700, Count: count, reservedCount },
});

function createCartWorld() {
  const carts: CartRow[] = [
    { id: 10, user: { id: USER_A }, Status: "Pending" },
    { id: 20, user: { id: USER_B }, Status: "Pending" },
  ];
  const items: CartItemRow[] = [
    { id: 101, cart: carts[0], Count: 1, Sum: 1000, product_variation: variationWithStock(9) },
    { id: 202, cart: carts[1], Count: 3, Sum: 3000, product_variation: variationWithStock(9) },
  ];

  // Only the filter shapes these code paths actually use are supported. An
  // unsupported shape throws rather than silently matching everything.
  const matches = (item: CartItemRow, where: any): boolean => {
    if (!where) throw new Error("cart-item query issued without a where clause");
    for (const [key, value] of Object.entries(where)) {
      if (key === "id") {
        if (Number(item.id) !== Number(value)) return false;
      } else if (key === "cart") {
        const cartFilter: any = value;
        if (cartFilter?.user?.id !== undefined) {
          if (Number(item.cart.user.id) !== Number(cartFilter.user.id)) return false;
        } else if (Number(item.cart.id) !== Number(cartFilter)) {
          return false;
        }
      } else {
        throw new Error(`unsupported cart-item filter key: ${key}`);
      }
    }
    return true;
  };

  const deleted: number[] = [];
  const updated: Array<{ id: number; data: any }> = [];

  const strapi: any = {
    log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    entityService: {
      delete: jest.fn(async (_uid: string, id: number) => {
        deleted.push(Number(id));
        const index = items.findIndex((item) => item.id === Number(id));
        if (index >= 0) items.splice(index, 1);
        return { id };
      }),
      update: jest.fn(async (_uid: string, id: number, payload: any) => {
        updated.push({ id: Number(id), data: payload?.data });
        const item = items.find((row) => row.id === Number(id));
        if (item && payload?.data?.Count !== undefined) item.Count = payload.data.Count;
        return { id, ...payload?.data };
      }),
    },
    db: {
      query: jest.fn((uid: string) => {
        if (uid === "api::cart-item.cart-item") {
          return {
            findOne: jest.fn(
              async ({ where }: any) => items.find((item) => matches(item, where)) ?? null,
            ),
            count: jest.fn(
              async ({ where }: any) => items.filter((item) => matches(item, where)).length,
            ),
          };
        }
        if (uid === "api::cart.cart") {
          return {
            findOne: jest.fn(
              async ({ where }: any) =>
                carts.find((cart) => Number(cart.user.id) === Number(where?.user)) ?? null,
            ),
          };
        }
        if (uid === "api::payment-attempt.payment-attempt") {
          return { findOne: jest.fn().mockResolvedValue(null) };
        }
        throw new Error(`unexpected query uid: ${uid}`);
      }),
    },
    service: jest.fn((uid: string) => {
      if (uid !== "api::cart.cart") throw new Error(`unexpected service uid: ${uid}`);
      return {
        removeCartItem: (cartItemId: number, ownerUserId: number) =>
          removeCartItemOp(strapi, cartItemId, ownerUserId),
        updateCartItem: (cartItemId: number, count: number, ownerUserId: number) =>
          updateCartItemOp(strapi, cartItemId, count, ownerUserId),
        checkCartStock: (ownerUserId: number, options?: { attemptId?: string }) =>
          checkCartStockOp(strapi, ownerUserId, options),
        getUserCart: async (userId: number) => {
          const cart = carts.find((row) => row.user.id === Number(userId));
          return { ...cart, cart_items: items.filter((item) => item.cart.id === cart?.id) };
        },
      };
    }),
  };

  return { strapi, items, deleted, updated };
}

const actAs = (userId: number, overrides: Partial<any> = {}) =>
  createCtx({ state: { user: { id: userId, role: { type: "authenticated" } } }, ...overrides });

/**
 * The cart handlers call `ctx.forbidden(...)`, whose test double throws; the handler's
 * own catch block then re-raises it through `ctx.badRequest`, so the surfaced status is
 * 400 while `ctx.forbidden` records the real reason. This mirrors the existing
 * convention in cart-operations-improved.spec.ts — the point of these assertions is
 * that the denial happened and nothing was mutated.
 */
const expectDenied = async (ctx: any, run: Promise<any>, reason: string) => {
  await expect(run).rejects.toMatchObject({ status: 400 });
  expect(ctx.forbidden).toHaveBeenCalledWith(
    reason,
    expect.objectContaining({ data: expect.objectContaining({ success: false }) }),
  );
};

const UPDATE_DENIED = "You do not have permission to update this cart item";
const REMOVE_DENIED = "You do not have permission to remove this cart item";

describe("cart ownership", () => {
  describe("zero-quantity update (the deletion path)", () => {
    it("refuses to delete another user's cart item", async () => {
      const { strapi, items, deleted } = createCartWorld();
      const ctx = actAs(USER_A, { request: { body: { cartItemId: 202, count: 0 } } });

      await expectDenied(ctx, updateItemHandler(strapi)(ctx), UPDATE_DENIED);

      expect(deleted).toEqual([]);
      expect(items.some((item) => item.id === 202)).toBe(true);
    });

    it("deletes the caller's own cart item", async () => {
      const { strapi, items, deleted } = createCartWorld();
      const ctx = actAs(USER_A, { request: { body: { cartItemId: 101, count: 0 } } });

      const result = await updateItemHandler(strapi)(ctx);

      expect(result.data.message).toBe("Cart item removed successfully");
      expect(deleted).toEqual([101]);
      expect(items.some((item) => item.id === 101)).toBe(false);
    });

    it("treats a nonexistent id the same as a foreign one", async () => {
      const { strapi, deleted } = createCartWorld();
      const ctx = actAs(USER_A, { request: { body: { cartItemId: 99999, count: 0 } } });

      await expectDenied(ctx, updateItemHandler(strapi)(ctx), UPDATE_DENIED);
      expect(deleted).toEqual([]);
    });
  });

  describe("quantity update", () => {
    it("refuses to update another user's cart item", async () => {
      const { strapi, updated, items } = createCartWorld();
      const ctx = actAs(USER_A, { request: { body: { cartItemId: 202, count: 5 } } });

      await expectDenied(ctx, updateItemHandler(strapi)(ctx), UPDATE_DENIED);

      expect(updated).toEqual([]);
      expect(items.find((item) => item.id === 202)?.Count).toBe(3);
    });

    it("updates the caller's own cart item", async () => {
      const { strapi, items } = createCartWorld();
      const ctx = actAs(USER_A, { request: { body: { cartItemId: 101, count: 4 } } });

      await updateItemHandler(strapi)(ctx);

      expect(items.find((item) => item.id === 101)?.Count).toBe(4);
    });

    it("returns a stable stock error with the latest available quantity", async () => {
      const { strapi, updated } = createCartWorld();

      await expect(updateCartItemOp(strapi, 101, 10, USER_A)).resolves.toEqual({
        success: false,
        message: "Insufficient stock",
        errorCode: "CART_STOCK_EXCEEDED",
        availableStock: 9,
      });
      expect(updated).toEqual([]);
    });

    it("exposes the stock error contract through the update endpoint", async () => {
      const { strapi } = createCartWorld();
      const ctx = actAs(USER_A, { request: { body: { cartItemId: 101, count: 10 } } });

      await expect(updateItemHandler(strapi)(ctx)).rejects.toMatchObject({ status: 400 });
      expect(ctx.badRequest).toHaveBeenCalledWith("Not enough stock", {
        data: {
          success: false,
          error: "Not enough stock",
          errorCode: "CART_STOCK_EXCEEDED",
          availableStock: 9,
        },
      });
    });

    /**
     * A line can sit above its available count without the shopper doing
     * anything wrong: stock moved, or a reservation (their own abandoned
     * checkout included) lowered availability. The stock gate must then still
     * let them shrink the line, or the cart is stuck at a quantity that is
     * itself the thing being rejected.
     */
    it("allows a decrease while the line still exceeds available stock", async () => {
      const { strapi, items } = createCartWorld();
      const line = items.find((item) => item.id === 101)!;
      line.Count = 5;
      line.product_variation = variationWithStock(5, 4); // available = 1
      const ctx = actAs(USER_A, { request: { body: { cartItemId: 101, count: 4 } } });

      await updateItemHandler(strapi)(ctx);

      expect(ctx.badRequest).not.toHaveBeenCalled();
      expect(items.find((item) => item.id === 101)?.Count).toBe(4);
    });

    it("allows a decrease through the op even with no stock record at all", async () => {
      const { strapi, items, updated } = createCartWorld();
      const line = items.find((item) => item.id === 101)!;
      line.Count = 3;
      line.product_variation = { ...variationWithStock(0), product_stock: null };

      await expect(updateCartItemOp(strapi, 101, 2, USER_A)).resolves.toMatchObject({
        success: true,
      });
      expect(updated).toEqual([{ id: 101, data: { Count: 2, Sum: 2000 } }]);
    });

    it("still rejects an increase on a line that already exceeds available stock", async () => {
      const { strapi, updated, items } = createCartWorld();
      const line = items.find((item) => item.id === 101)!;
      line.Count = 5;
      line.product_variation = variationWithStock(5, 4); // available = 1

      await expect(updateCartItemOp(strapi, 101, 6, USER_A)).resolves.toEqual({
        success: false,
        message: "Insufficient stock",
        errorCode: "CART_STOCK_EXCEEDED",
        availableStock: 1,
      });
      expect(updated).toEqual([]);
    });
  });

  describe("explicit removal", () => {
    it("refuses to remove another user's cart item", async () => {
      const { strapi, deleted, items } = createCartWorld();
      const ctx = actAs(USER_A, { params: { id: 202 } });

      await expectDenied(ctx, removeItemHandler(strapi)(ctx), REMOVE_DENIED);

      expect(deleted).toEqual([]);
      expect(items.some((item) => item.id === 202)).toBe(true);
    });

    it("removes the caller's own cart item", async () => {
      const { strapi, deleted } = createCartWorld();
      const ctx = actAs(USER_A, { params: { id: 101 } });

      await removeItemHandler(strapi)(ctx);

      expect(deleted).toEqual([101]);
    });
  });

  describe("service ops reject an unusable owner outright", () => {
    it("removeCartItemOp requires an owner", async () => {
      const { strapi, deleted } = createCartWorld();
      await expect(removeCartItemOp(strapi, 202, undefined as any)).resolves.toEqual({
        success: false,
        message: "Cart owner is required",
      });
      expect(deleted).toEqual([]);
    });

    it("updateCartItemOp requires an owner", async () => {
      const { strapi, updated } = createCartWorld();
      await expect(updateCartItemOp(strapi, 202, 5, undefined as any)).resolves.toEqual({
        success: false,
        message: "Cart owner is required",
      });
      expect(updated).toEqual([]);
    });

    it("scopes the op itself, not only the handler", async () => {
      const { strapi, deleted } = createCartWorld();
      // Calling the op directly with the wrong owner must still fail: the handler
      // pre-check is defence in depth, the op's own scoping is the control.
      await expect(removeCartItemOp(strapi, 202, USER_A)).resolves.toEqual({
        success: false,
        message: "Cart item not found",
      });
      expect(deleted).toEqual([]);
    });
  });

  describe("cart read", () => {
    it("returns only the authenticated user's own cart", async () => {
      const { strapi } = createCartWorld();
      const ctx = actAs(USER_A);

      const result = await getMyCartHandler(strapi)(ctx);

      expect(result.data.id).toBe(10);
      expect(result.data.cart_items.map((item: any) => item.id)).toEqual([101]);
      expect(result.data.cart_items[0].availableStock).toBe(9);
    });

    it("rejects targeting another user via a client-supplied user id", async () => {
      const { strapi } = createCartWorld();
      const ctx = actAs(USER_A, { query: { targetUserId: USER_B } });

      // resolveCustomerTargetUserId records the denial and returns null, so the
      // handler short-circuits without ever reading a cart.
      await expect(getMyCartHandler(strapi)(ctx)).resolves.toBeUndefined();
      expect(ctx.forbidden).toHaveBeenCalledWith(
        "You do not have permission to target another user",
        expect.objectContaining({
          data: expect.objectContaining({ error: "TARGET_USER_FORBIDDEN" }),
        }),
      );
      expect(strapi.service).not.toHaveBeenCalled();
    });
  });

  describe("stock check mutations stay on the caller's cart", () => {
    it("drops only the authenticated user's reserved last unit", async () => {
      const { strapi, items, deleted } = createCartWorld();
      items[0].product_variation = variationWithStock(1, 1);
      items[1].product_variation = variationWithStock(1, 1);

      const result = await checkCartStockOp(strapi, USER_A);

      expect(result.valid).toBe(false);
      expect(deleted).toEqual([101]);
      expect(items.some((item) => item.id === 101)).toBe(false);
      expect(items.some((item) => item.id === 202)).toBe(true);
    });

    it("does not mutate another user's line even when asked to", async () => {
      const { strapi, items, deleted, updated } = createCartWorld();
      items[1].product_variation = variationWithStock(1, 1);

      await expect(removeCartItemOp(strapi, 202, USER_A)).resolves.toEqual({
        success: false,
        message: "Cart item not found",
      });
      const result = await checkCartStockOp(strapi, USER_A);

      expect(result.valid).toBe(true);
      expect(deleted).toEqual([]);
      expect(updated).toEqual([]);
      expect(items.some((item) => item.id === 202)).toBe(true);
    });

    it("rejects targeting another user via check-stock", async () => {
      const { strapi, deleted } = createCartWorld();
      const ctx = actAs(USER_A, { query: { targetUserId: USER_B } });

      await expect(checkStockHandler(strapi)(ctx)).resolves.toBeUndefined();
      expect(ctx.forbidden).toHaveBeenCalledWith(
        "You do not have permission to target another user",
        expect.objectContaining({
          data: expect.objectContaining({ error: "TARGET_USER_FORBIDDEN" }),
        }),
      );
      expect(deleted).toEqual([]);
    });

    it("lets a store manager correct only their own cart", async () => {
      const { strapi, items, deleted } = createCartWorld();
      items[0].product_variation = variationWithStock(1, 1);
      items[1].product_variation = variationWithStock(1, 1);
      const ctx = actAs(USER_A, {
        state: { user: { id: USER_A, role: { name: "Store Manager" } } },
      });

      const result = await checkStockHandler(strapi)(ctx);

      expect(result.data.valid).toBe(false);
      expect(deleted).toEqual([101]);
      expect(items.some((item) => item.id === 202)).toBe(true);
    });
  });
});
