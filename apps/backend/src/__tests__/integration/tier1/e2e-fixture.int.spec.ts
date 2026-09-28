/**
 * The staging E2E fixture API's provisioning on a real PostgreSQL: what a slot
 * owns, what a second call resets, that the product is really sellable (and
 * stops being so when unpublished), and that it never adopts a real account.
 */
import {
  cleanupShopper,
  E2E_FIXTURE_PRICE_TOMAN,
  provisionShopper,
  readSlotStock,
  setSlotProductPublished,
} from "../../../api/e2e-fixture/services/e2e-fixture";
import { addCartItemOp } from "../../../api/cart/services/ops/addCartItem";
import { readWalletAvailability } from "../../../api/local-user-wallet/services/wallet-holds";
import { publicProductFilters } from "../../../utils/productVisibility";
import { E2E_FIXTURE_EMAIL_DOMAIN, E2E_FIXTURE_SOURCE, e2eFixturePhone } from "../../../utils/e2eFixtures";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

let strapi: any;
let f: Factories;

// High slots: nothing else in this database uses the reserved phone range.
const SLOT = 61;
const FOREIGN_SLOT = 62;

beforeAll(async () => {
  strapi = await setupStrapi();
  // An address needs a city, and a fresh test database has none.
  f = makeFactories(strapi);
  await f.createShippingCity({ title: "تهران" });
});

afterAll(async () => {
  await removeFixtureRows();
  await f.cleanup();
  await teardownStrapi();
});

async function removeFixtureRows() {
  const q = (uid: string) => strapi.db.query(uid);
  const users = await q("plugin::users-permissions.user").findMany({
    where: { email: { $endsWith: `@${E2E_FIXTURE_EMAIL_DOMAIN}` } },
    select: ["id"],
  });
  const userIds = users.map((user: any) => user.id);
  const products = await q("api::product.product").findMany({
    where: { external_source: E2E_FIXTURE_SOURCE },
    select: ["id"],
  });
  // deleteMany cannot filter on a relation, so rows are selected first.
  const byRelation = (uid: string, where: Record<string, unknown>) => async () => {
    const rows = await q(uid).findMany({ where, select: ["id"] });
    if (rows.length) await q(uid).deleteMany({ where: { id: { $in: rows.map((row: any) => row.id) } } });
  };
  const steps: Array<() => Promise<unknown>> = [
    byRelation("api::product-log.product-log", { product: { id: { $in: products.map((p: any) => p.id) } } }),
    byRelation("api::cart-item.cart-item", { cart: { user: { id: { $in: userIds } } } }),
    byRelation("api::cart.cart", { user: { id: { $in: userIds } } }),
    byRelation("api::local-user-address.local-user-address", { user: { id: { $in: userIds } } }),
    byRelation("api::local-user-info.local-user-info", { user: { id: { $in: userIds } } }),
    byRelation("api::local-user-wallet-transaction.local-user-wallet-transaction", {
      user_wallet: { user: { id: { $in: userIds } } },
    }),
    byRelation("api::local-user-wallet.local-user-wallet", { user: { id: { $in: userIds } } }),
    () => q("plugin::users-permissions.user").deleteMany({ where: { id: { $in: userIds } } }),
    ...[
      "api::product-variation.product-variation",
      "api::product-stock.product-stock",
      "api::product.product",
      "api::product-category.product-category",
      "api::product-variation-color.product-variation-color",
      "api::product-variation-size.product-variation-size",
    ].map((uid) => () => q(uid).deleteMany({ where: { external_source: E2E_FIXTURE_SOURCE } })),
    () => q("plugin::upload.file").deleteMany({ where: { name: "e2e-fixture-cover.png" } }),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch {
      /* best effort: disposable database */
    }
  }
}

async function isPublic(productId: number) {
  const rows = await strapi.entityService.findMany("api::product.product", {
    filters: { id: productId, ...publicProductFilters() },
    fields: ["id"],
  });
  return (rows as unknown[]).length === 1;
}

async function passwordWorks(userId: number, password: string) {
  const user = await strapi.db.query("plugin::users-permissions.user").findOne({
    where: { id: userId },
    select: ["password"],
  });
  return strapi.plugin("users-permissions").service("user").validatePassword(password, user.password);
}

async function stockOf(variationId: number) {
  const variation = await strapi.db.query("api::product-variation.product-variation").findOne({
    where: { id: variationId },
    populate: { product_stock: true },
  });
  return variation.product_stock;
}

it("provisions a slot the storefront can sell, and a second call resets it", async () => {
  const first = await provisionShopper(strapi, { slot: SLOT, walletToman: 250_000 });

  expect(first.phone).toBe(e2eFixturePhone(SLOT));
  expect(await passwordWorks(first.userId, first.password)).toBe(true);
  expect(first.product.slug).toBe(`e2e-fixture-product-s${SLOT}`);
  expect(await isPublic(first.product.id)).toBe(true);
  expect(first.variations.inStock.priceToman).toBe(E2E_FIXTURE_PRICE_TOMAN);
  expect(first.address.city).toBe("تهران");
  expect((await readWalletAvailability(strapi, first.userId)).balanceIrr).toBe(2_500_000);
  expect(await readSlotStock(strapi, SLOT)).toEqual({
    [first.variations.inStock.sku]: { count: 1_000, reserved: 0 },
    [first.variations.outOfStock.sku]: { count: 0, reserved: 0 },
  });

  const cover = await strapi.entityService.findOne("api::product.product", first.product.id, {
    populate: { CoverImage: true },
  });
  expect(cover.CoverImage?.name).toBe("e2e-fixture-cover.png");

  // Leave behind what a run leaves: a cart line and an unfinished checkout
  // holding one unit of the slot's stock.
  const cart = await f.createCart({ userId: first.userId });
  expect((await addCartItemOp(strapi, cart.id, first.variations.inStock.id, 2)).success).toBe(true);
  const contract = await f.createContract({ userId: first.userId });
  const order = await f.createOrder({
    userId: first.userId,
    contractId: contract.id,
    status: "Paying",
    reservationStatus: "Reserved",
    reservedUntil: new Date(Date.now() + 15 * 60_000),
  });
  await f.createOrderItem({ orderId: order.id, variationId: first.variations.inStock.id, count: 1 });
  const stock = await stockOf(first.variations.inStock.id);
  await strapi.db.query("api::product-stock.product-stock").update({
    where: { id: stock.id },
    data: { reservedCount: 1 },
  });

  const second = await provisionShopper(strapi, { slot: SLOT, walletToman: 0 });

  expect(second.userId).toBe(first.userId);
  expect(second.product.id).toBe(first.product.id);
  expect(second.password).not.toBe(first.password);
  expect(await passwordWorks(second.userId, first.password)).toBe(false);
  expect(await passwordWorks(second.userId, second.password)).toBe(true);
  expect(await f.getCartItems(cart.id)).toHaveLength(0);
  expect((await f.getOrder(order.id)).Status).toBe("Cancelled");
  expect(await stockOf(first.variations.inStock.id)).toMatchObject({ Count: 1_000, reservedCount: 0 });
  expect((await readWalletAvailability(strapi, second.userId)).balanceIrr).toBe(0);
  expect(second.warnings).toContain("cancelled 1 unfinished checkout(s) left by an earlier run");

  // Every catalog row it made is tagged as a fixture.
  const untagged = await Promise.all([
    strapi.db.query("api::product.product").count({
      where: { Slug: { $startsWith: "e2e-fixture" }, external_source: { $ne: E2E_FIXTURE_SOURCE } },
    }),
    strapi.db.query("api::product-category.product-category").count({
      where: { Slug: { $startsWith: "e2e-fixture" }, external_source: { $ne: E2E_FIXTURE_SOURCE } },
    }),
    strapi.db.query("api::product-variation.product-variation").count({
      where: { SKU: { $startsWith: "E2E-FIXTURE-" }, external_source: { $ne: E2E_FIXTURE_SOURCE } },
    }),
  ]);
  expect(untagged).toEqual([0, 0, 0]);
});

it("takes the product out of the store and puts it back through the publication command", async () => {
  const shopper = await provisionShopper(strapi, { slot: SLOT, walletToman: 0 });
  const cart = await f.createCart({ userId: shopper.userId });

  const unpublished = await setSlotProductPublished(strapi, SLOT, false);
  expect(unpublished.published).toBe(false);
  expect(await isPublic(shopper.product.id)).toBe(false);
  expect(await addCartItemOp(strapi, cart.id, shopper.variations.inStock.id, 1)).toMatchObject({
    success: false,
    message: "Product is currently unavailable",
  });

  // Cleanup republishes, so a run that fails midway cannot strand the slot.
  await cleanupShopper(strapi, SLOT);
  expect(await isPublic(shopper.product.id)).toBe(true);
  expect((await addCartItemOp(strapi, cart.id, shopper.variations.inStock.id, 1)).success).toBe(true);
});

it("never adopts an account it did not create", async () => {
  await f.createUser({ phone: e2eFixturePhone(FOREIGN_SLOT) });

  await expect(provisionShopper(strapi, { slot: FOREIGN_SLOT, walletToman: 0 })).rejects.toMatchObject({
    code: "E2E_FIXTURE_PHONE_TAKEN",
    status: 409,
  });
});
