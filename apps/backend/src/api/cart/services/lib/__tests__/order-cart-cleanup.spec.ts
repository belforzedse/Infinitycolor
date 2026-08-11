/**
 * Post-payment cart cleanup consumes the checkout snapshot, not the live cart.
 *
 * The store below is deliberately behavioral rather than a bag of jest.fn()s: it applies
 * the guarded cart_cleanup_completed_at CAS and the cart mutations to real rows, so the
 * assertions describe what the customer's cart actually looks like afterwards.
 */
import {
  consumeCheckoutCartLines,
  consumeCheckoutCartLinesSafely,
} from "../order-cart-cleanup";

const USER_ID = 1;
const OTHER_USER_ID = 2;

type CartItemRow = {
  id: number;
  cartId: number;
  Count: number;
  Sum: number;
  product_variation: { id: number; Price: number; DiscountPrice?: number | null };
};

function createWorld(options: {
  orderItems: Array<{ sourceCartItemId: number | null; count: number }>;
  cartItems: CartItemRow[];
  cartCleanupCompletedAt?: Date | null;
  orderUserId?: number;
}) {
  const carts = [
    { id: 500, user: { id: USER_ID }, Status: "Pending" },
    { id: 600, user: { id: OTHER_USER_ID }, Status: "Pending" },
  ];
  const cartItems = [...options.cartItems];
  const order = {
    id: 42,
    user: { id: options.orderUserId ?? USER_ID },
    CartCleanupCompletedAt: options.cartCleanupCompletedAt ?? null,
    order_items: options.orderItems.map((item, index) => ({
      id: 900 + index,
      SourceCartItemId: item.sourceCartItemId,
      Count: item.count,
    })),
  };

  const ownerOf = (cartId: number) => carts.find((cart) => cart.id === cartId)?.user.id;

  const strapi: any = {
    log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    db: {
      inTransaction: () => false,
      connection: { raw: jest.fn(async () => ({ rows: [] })) },
      transaction: jest.fn(async (cb: any) => {
        const trx = {
          raw: jest.fn(async (sql: string, bindings: any[]) => {
            if (/UPDATE orders/.test(sql) && /cart_cleanup_completed_at = \?/.test(sql)) {
              // The real guard: only the first caller claims the marker.
              if (order.CartCleanupCompletedAt !== null) return { rows: [] };
              order.CartCleanupCompletedAt = bindings[0];
              return { rows: [{ id: order.id }] };
            }
            throw new Error(`unexpected raw sql: ${sql}`);
          }),
        };
        return cb({ trx });
      }),
      query: jest.fn((uid: string) => {
        if (uid === "api::order.order") {
          return { findOne: jest.fn(async () => order) };
        }
        if (uid === "api::cart-item.cart-item") {
          return {
            findOne: jest.fn(async ({ where }: any) => {
              const found = cartItems.find((item) => item.id === Number(where.id));
              if (!found) return null;
              // Ownership scoping is part of the contract under test.
              const requiredOwner = where?.cart?.user?.id;
              if (requiredOwner !== undefined && ownerOf(found.cartId) !== Number(requiredOwner)) {
                return null;
              }
              return {
                ...found,
                cart: carts.find((cart) => cart.id === found.cartId),
              };
            }),
            update: jest.fn(async ({ where, data }: any) => {
              const item = cartItems.find((row) => row.id === Number(where.id));
              if (item) Object.assign(item, data);
              return item;
            }),
            delete: jest.fn(async ({ where }: any) => {
              const index = cartItems.findIndex((row) => row.id === Number(where.id));
              if (index >= 0) cartItems.splice(index, 1);
            }),
            count: jest.fn(async ({ where }: any) =>
              cartItems.filter((row) => row.cartId === Number(where.cart)).length,
            ),
          };
        }
        if (uid === "api::cart.cart") {
          return {
            update: jest.fn(async ({ where, data }: any) => {
              const cart = carts.find((row) => row.id === Number(where.id));
              if (cart) Object.assign(cart, data);
              return cart;
            }),
          };
        }
        if (uid === "api::order-log.order-log") {
          return { create: jest.fn(async () => ({ id: 1 })) };
        }
        throw new Error(`unexpected uid ${uid}`);
      }),
    },
  };

  return { strapi, cartItems, carts, order };
}

const line = (id: number, count: number, price = 1000): CartItemRow => ({
  id,
  cartId: 500,
  Count: count,
  Sum: count * price,
  product_variation: { id: 700 + id, Price: price },
});

describe("consumeCheckoutCartLines", () => {
  it("leaves an item added after checkout untouched", async () => {
    // Checkout consumed line 10 (A x1); the customer then added B as line 42.
    const { strapi, cartItems } = createWorld({
      orderItems: [{ sourceCartItemId: 10, count: 1 }],
      cartItems: [line(10, 1), line(42, 1)],
    });

    await expect(consumeCheckoutCartLines(strapi, 42)).resolves.toMatchObject({
      status: "applied",
      consumedLines: 1,
      deletedLines: 1,
    });

    expect(cartItems.map((item) => item.id)).toEqual([42]);
  });

  it("consumes only the historical quantity when the same line was increased", async () => {
    // Checkout consumed A x1 from line 10; the customer then raised line 10 to x2.
    const { strapi, cartItems } = createWorld({
      orderItems: [{ sourceCartItemId: 10, count: 1 }],
      cartItems: [line(10, 2)],
    });

    await consumeCheckoutCartLines(strapi, 42);

    const remaining = cartItems.find((item) => item.id === 10);
    expect(remaining?.Count).toBe(1);
    expect(remaining?.Sum).toBe(1000);
  });

  it("does not touch a re-added line for the same SKU", async () => {
    // Source line 10 was deleted and the same SKU re-added as line 42.
    const { strapi, cartItems } = createWorld({
      orderItems: [{ sourceCartItemId: 10, count: 1 }],
      cartItems: [line(42, 1)],
    });

    await expect(consumeCheckoutCartLines(strapi, 42)).resolves.toMatchObject({
      status: "applied",
      consumedLines: 0,
    });

    expect(cartItems.map((item) => item.id)).toEqual([42]);
    expect(cartItems[0].Count).toBe(1);
  });

  it("is idempotent: a repeat run consumes nothing more", async () => {
    const { strapi, cartItems } = createWorld({
      orderItems: [{ sourceCartItemId: 10, count: 1 }],
      cartItems: [line(10, 2)],
    });

    await consumeCheckoutCartLines(strapi, 42);
    await expect(consumeCheckoutCartLines(strapi, 42)).resolves.toEqual({
      status: "already_applied",
    });

    expect(cartItems.find((item) => item.id === 10)?.Count).toBe(1);
  });

  it("empties the cart status only when nothing is left", async () => {
    const { strapi, carts } = createWorld({
      orderItems: [{ sourceCartItemId: 10, count: 1 }],
      cartItems: [line(10, 1)],
    });

    await consumeCheckoutCartLines(strapi, 42);

    expect(carts.find((cart) => cart.id === 500)?.Status).toBe("Empty");
  });

  it("keeps the cart pending while other lines remain", async () => {
    const { strapi, carts } = createWorld({
      orderItems: [{ sourceCartItemId: 10, count: 1 }],
      cartItems: [line(10, 1), line(11, 1)],
    });

    await consumeCheckoutCartLines(strapi, 42);

    expect(carts.find((cart) => cart.id === 500)?.Status).toBe("Pending");
  });

  it("never reaches into another customer's cart", async () => {
    const { strapi, cartItems } = createWorld({
      orderItems: [{ sourceCartItemId: 10, count: 1 }],
      cartItems: [{ ...line(10, 1), cartId: 600 }],
    });

    await expect(consumeCheckoutCartLines(strapi, 42)).resolves.toMatchObject({
      consumedLines: 0,
    });
    expect(cartItems[0].Count).toBe(1);
  });

  it("marks pre-migration orders complete without touching the cart", async () => {
    const { strapi, cartItems } = createWorld({
      orderItems: [{ sourceCartItemId: null, count: 1 }],
      cartItems: [line(10, 1)],
    });

    await expect(consumeCheckoutCartLines(strapi, 42)).resolves.toEqual({
      status: "nothing_to_consume",
    });
    expect(cartItems.find((item) => item.id === 10)?.Count).toBe(1);
  });
});

describe("consumeCheckoutCartLinesSafely", () => {
  it("reports failure without throwing, so a confirmed payment stays confirmed", async () => {
    const { strapi } = createWorld({
      orderItems: [{ sourceCartItemId: 10, count: 1 }],
      cartItems: [line(10, 1)],
    });
    strapi.db.transaction = jest.fn(async () => {
      throw new Error("connection reset");
    });

    await expect(
      consumeCheckoutCartLinesSafely(strapi, 42, { gateway: "SamanKish" }),
    ).resolves.toBe(false);

    // Durable, operator-visible record of the pending work.
    expect(strapi.db.query).toHaveBeenCalledWith("api::order-log.order-log");
    expect(strapi.log.error).toHaveBeenCalled();
  });

  it("reports success on a normal run", async () => {
    const { strapi } = createWorld({
      orderItems: [{ sourceCartItemId: 10, count: 1 }],
      cartItems: [line(10, 1)],
    });

    await expect(consumeCheckoutCartLinesSafely(strapi, 42)).resolves.toBe(true);
  });
});
