/**
 * Deterministic test data for the staging E2E suite (apps/e2e/tests/staging).
 *
 * Each Playwright worker owns a slot (0–63). A slot is one shopper account and
 * one product of its own, so parallel workers never share a cart, a wallet or a
 * stock row. Provisioning is idempotent: the first call creates the rows, later
 * calls reset them (fresh password, empty cart, no open checkout, known wallet
 * credit, stock topped up).
 *
 * It only ever writes rows it owns: catalog rows tagged
 * `external_source = "e2e-fixture"` and accounts in the reserved phone range
 * whose email is on the fixture domain. It never changes global settings,
 * payment gateways or shipping methods, and never adopts an existing account.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Strapi } from "@strapi/strapi";
import {
  E2E_FIXTURE_EMAIL_DOMAIN,
  E2E_FIXTURE_SOURCE,
  e2eFixturePhone,
} from "../../../utils/e2eFixtures";
import { customerPhoneStorageVariants } from "../../../utils/customerPhoneIdentity";
import { ROLE_NAMES, fetchRoleByName } from "../../../utils/roles";
import { isProductPubliclyVisible } from "../../../utils/productVisibility";
import { updatePasswordAndLegacyHash } from "../../auth/services/credential-flow";
import { cancelOrderAndRelease } from "../../cart/controllers/handlers/gateway-helpers";
import { releaseOrderReservation } from "../../../utils/stockReservations";
import { applyAdminWalletAdjustment } from "../../local-user-wallet/services/local-user-wallet";
import { readWalletAvailability } from "../../local-user-wallet/services/wallet-holds";
import { getAvailableCheckoutGateways } from "../../payment-gateway/services/checkout-gateway-availability";
import {
  PRODUCT_UID,
  executePublicationCommand,
  runPublicationEffects,
} from "../../product/services/product-publication";

const CATEGORY_UID = "api::product-category.product-category";
const VARIATION_UID = "api::product-variation.product-variation";
const STOCK_UID = "api::product-stock.product-stock";
const COLOR_UID = "api::product-variation-color.product-variation-color";
const SIZE_UID = "api::product-variation-size.product-variation-size";
const USER_UID = "plugin::users-permissions.user";
const USER_INFO_UID = "api::local-user-info.local-user-info";
const ADDRESS_UID = "api::local-user-address.local-user-address";
const CART_UID = "api::cart.cart";
const CART_ITEM_UID = "api::cart-item.cart-item";
const ORDER_UID = "api::order.order";
const CITY_UID = "api::shipping-city.shipping-city";
const FILE_UID = "plugin::upload.file";

/** Toman. Well above any shipping fee so a line total is never mistaken for one. */
export const E2E_FIXTURE_PRICE_TOMAN = 185_000;
const IN_STOCK_TARGET = 1_000;
const COVER_FILE_NAME = "e2e-fixture-cover.png";
// An 8×8 blue PNG: the storefront lists only products with a cover (requireCoverImage).
const COVER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mOQ9buBFTEMLQkAXtlQwUhymhkAAAAASUVORK5CYII=",
  "base64",
);

const AUDIT_PRINCIPAL = {
  type: "service_account" as const,
  id: "e2e-fixtures",
  label: "E2E Fixtures",
};

export class E2EFixtureError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code,
  ) {
    super(message);
    this.name = "E2EFixtureError";
  }
}

type Catalog = {
  categoryId: number;
  categorySlug: string;
  coverId: number;
  colors: { inStock: { id: number; title: string }; outOfStock: { id: number; title: string } };
  sizes: { inStock: { id: number; title: string }; outOfStock: { id: number; title: string } };
};

export type FixtureVariation = {
  id: number;
  sku: string;
  priceToman: number;
  color: string;
  size: string;
};

export type ShopperFixture = {
  slot: number;
  userId: number;
  phone: string;
  password: string;
  firstName: string;
  lastName: string;
  product: { id: number; slug: string; title: string; categorySlug: string };
  variations: { inStock: FixtureVariation; outOfStock: FixtureVariation };
  address: { id: number; fullAddress: string; city: string; postalCode: string };
  walletToman: number;
  checks: { gateways: string[] };
  warnings: string[];
};

const pad = (slot: number) => String(slot).padStart(2, "0");
const externalId = (key: string) => `${E2E_FIXTURE_SOURCE}:${key}`;
const slotSku = (slot: number, kind: "IN" | "OUT") => `E2E-FIXTURE-S${pad(slot)}-${kind}`;

const q = (strapi: Strapi, uid: string) => strapi.db.query(uid as any);

/**
 * Find a tagged row, or create it. Two workers provisioning for the first time
 * can race on the shared catalog rows; a create that loses to a unique index is
 * answered by reading the winner's row.
 */
async function findOrCreate<T extends { id: number }>(
  find: () => Promise<T | null | undefined>,
  create: () => Promise<T>,
): Promise<T> {
  const existing = await find();
  if (existing) return existing;
  try {
    return await create();
  } catch (error) {
    const winner = await find();
    if (winner) return winner;
    throw error;
  }
}

function tagged(strapi: Strapi, uid: string, key: string) {
  return q(strapi, uid).findOne({
    where: { external_source: E2E_FIXTURE_SOURCE, external_id: externalId(key) },
  }) as Promise<any>;
}

async function ensureCover(strapi: Strapi): Promise<number> {
  return (
    await findOrCreate(
      () => q(strapi, FILE_UID).findOne({ where: { name: COVER_FILE_NAME } }) as Promise<any>,
      async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "e2e-fixture-"));
        const filePath = path.join(dir, COVER_FILE_NAME);
        try {
          await writeFile(filePath, COVER_PNG);
          const [file] = await strapi.plugin("upload").service("upload").upload({
            data: { fileInfo: { name: COVER_FILE_NAME, alternativeText: "E2E fixture" } },
            files: { path: filePath, name: COVER_FILE_NAME, type: "image/png", size: COVER_PNG.length },
          });
          return file;
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    )
  ).id;
}

async function ensureCatalog(strapi: Strapi): Promise<Catalog> {
  const category = await findOrCreate(
    () => tagged(strapi, CATEGORY_UID, "category"),
    () =>
      strapi.entityService.create(CATEGORY_UID as any, {
        data: {
          Title: "E2E Fixture Category",
          Slug: "e2e-fixture",
          external_source: E2E_FIXTURE_SOURCE,
          external_id: externalId("category"),
        },
      } as any) as Promise<any>,
  );
  const color = (key: string, title: string, colorCode: string) =>
    findOrCreate(
      () => tagged(strapi, COLOR_UID, key),
      () =>
        q(strapi, COLOR_UID).create({
          data: { Title: title, ColorCode: colorCode, external_source: E2E_FIXTURE_SOURCE, external_id: externalId(key) },
        }) as Promise<any>,
    );
  // Size titles are unique across the catalog, so these carry an E2E prefix.
  const size = (key: string, title: string) =>
    findOrCreate(
      () => tagged(strapi, SIZE_UID, key),
      () =>
        q(strapi, SIZE_UID).create({
          data: { Title: title, external_source: E2E_FIXTURE_SOURCE, external_id: externalId(key) },
        }) as Promise<any>,
    );
  const [blue, black, medium, large, coverId] = await Promise.all([
    color("color:blue", "E2E Blue", "#1d4ed8"),
    color("color:black", "E2E Black", "#111111"),
    size("size:m", "E2E-M"),
    size("size:l", "E2E-L"),
    ensureCover(strapi),
  ]);
  return {
    categoryId: category.id,
    categorySlug: category.Slug,
    coverId,
    colors: {
      inStock: { id: blue.id, title: blue.Title },
      outOfStock: { id: black.id, title: black.Title },
    },
    sizes: {
      inStock: { id: medium.id, title: medium.Title },
      outOfStock: { id: large.id, title: large.Title },
    },
  };
}

async function ensureVariation(
  strapi: Strapi,
  productId: number,
  slot: number,
  kind: "IN" | "OUT",
  colorId: number,
  sizeId: number,
  stockCount: (current: { Count: number; reservedCount: number } | null) => number,
): Promise<{ id: number; sku: string; price: number }> {
  const sku = slotSku(slot, kind);
  let variation: any = await q(strapi, VARIATION_UID).findOne({
    where: { SKU: sku },
    populate: { product_stock: true, product: true },
  });
  if (variation && variation.external_source !== E2E_FIXTURE_SOURCE) {
    throw new E2EFixtureError("E2E_FIXTURE_SKU_TAKEN", 409, `SKU ${sku} belongs to a non-fixture variation`);
  }
  if (!variation) {
    const stock: any = await q(strapi, STOCK_UID).create({
      data: { Count: stockCount(null), reservedCount: 0, external_source: E2E_FIXTURE_SOURCE, external_id: externalId(`stock:${sku}`) },
    });
    variation = await strapi.entityService.create(VARIATION_UID as any, {
      data: {
        SKU: sku,
        Price: E2E_FIXTURE_PRICE_TOMAN,
        IsPublished: true,
        product: productId,
        product_stock: stock.id,
        product_variation_color: colorId,
        product_variation_size: sizeId,
        external_source: E2E_FIXTURE_SOURCE,
        external_id: externalId(`variation:${sku}`),
      },
    } as any);
    return { id: variation.id, sku, price: E2E_FIXTURE_PRICE_TOMAN };
  }

  const updates: Record<string, unknown> = {};
  if (!variation.IsPublished) updates.IsPublished = true;
  if (Number(variation.Price) !== E2E_FIXTURE_PRICE_TOMAN) updates.Price = E2E_FIXTURE_PRICE_TOMAN;
  if (variation.DiscountPrice != null) updates.DiscountPrice = null;
  if (Object.keys(updates).length) {
    await q(strapi, VARIATION_UID).update({ where: { id: variation.id }, data: updates });
  }
  const stock = variation.product_stock;
  if (stock) {
    const target = stockCount({ Count: Number(stock.Count || 0), reservedCount: Number(stock.reservedCount || 0) });
    if (Number(stock.Count) !== target) {
      await q(strapi, STOCK_UID).update({ where: { id: stock.id }, data: { Count: target } });
    }
  }
  return { id: variation.id, sku, price: E2E_FIXTURE_PRICE_TOMAN };
}

async function ensureSlotProduct(strapi: Strapi, slot: number, catalog: Catalog, warnings: string[]) {
  const key = `product:s${pad(slot)}`;
  const title = `E2E Fixture Product S${pad(slot)}`;
  const slug = `e2e-fixture-product-s${pad(slot)}`;
  const product: any = await findOrCreate(
    () => tagged(strapi, PRODUCT_UID, key),
    () =>
      strapi.entityService.create(PRODUCT_UID as any, {
        data: {
          Title: title,
          Slug: slug,
          Description: "Automated test product. Not for sale.",
          Status: "InActive",
          CoverImage: catalog.coverId,
          product_main_category: catalog.categoryId,
          external_source: E2E_FIXTURE_SOURCE,
          external_id: externalId(key),
        },
      } as any) as Promise<any>,
  );
  if (product.removedAt || product.purgedAt) {
    throw new E2EFixtureError(
      "E2E_FIXTURE_PRODUCT_TRASHED",
      409,
      `${title} (id ${product.id}) is in Trash here; restore it from the admin Products Trash tab`,
    );
  }

  const inStock = await ensureVariation(
    strapi, product.id, slot, "IN", catalog.colors.inStock.id, catalog.sizes.inStock.id,
    (current) => {
      if (current?.reservedCount) {
        warnings.push(`${slotSku(slot, "IN")} still had ${current.reservedCount} reserved after cleanup`);
      }
      return IN_STOCK_TARGET + (current?.reservedCount ?? 0);
    },
  );
  const outOfStock = await ensureVariation(
    strapi, product.id, slot, "OUT", catalog.colors.outOfStock.id, catalog.sizes.outOfStock.id,
    (current) => current?.reservedCount ?? 0,
  );

  await setProductPublished(strapi, product.id, true, warnings);
  return {
    product: { id: product.id, slug: product.Slug, title: product.Title, categorySlug: catalog.categorySlug },
    variations: {
      inStock: {
        id: inStock.id, sku: inStock.sku, priceToman: inStock.price,
        color: catalog.colors.inStock.title, size: catalog.sizes.inStock.title,
      },
      outOfStock: {
        id: outOfStock.id, sku: outOfStock.sku, priceToman: outOfStock.price,
        color: catalog.colors.outOfStock.title, size: catalog.sizes.outOfStock.title,
      },
    },
  };
}

/**
 * Through the publication command, like the admin does, so the variations
 * cascade, the publication revision moves and the storefront caches are purged.
 */
async function setProductPublished(strapi: Strapi, productId: number, published: boolean, warnings: string[]) {
  const row: any = await q(strapi, PRODUCT_UID).findOne({ where: { id: productId } });
  if (published === isProductPubliclyVisible(row)) return;
  const result = await executePublicationCommand(
    strapi,
    productId,
    { action: published ? "publish-now" : "unpublish" },
    { origin: "e2e-fixture" },
  );
  if (!result.needsPublicationEffects) return;
  try {
    await runPublicationEffects(strapi, productId, result.publicationRevision);
  } catch (error) {
    // The reconciler retries recorded failures; a storefront that could not be
    // revalidated right now is worth reporting, not failing the fixture over.
    warnings.push(`publication effects pending for product ${productId}: ${(error as Error).message}`);
  }
}

async function ensureShopper(strapi: Strapi, slot: number) {
  const phone = e2eFixturePhone(slot);
  const email = `s${pad(slot)}@${E2E_FIXTURE_EMAIL_DOMAIN}`;
  const firstName = "E2E";
  const lastName = `Shopper S${pad(slot)}`;
  const matches: any[] = await q(strapi, USER_UID).findMany({
    where: { phone: { $in: customerPhoneStorageVariants(phone) } },
    populate: { user_info: true },
    limit: 2,
  });
  const foreign = matches.find((user) => !String(user.email || "").endsWith(`@${E2E_FIXTURE_EMAIL_DOMAIN}`));
  if (foreign || matches.length > 1) {
    throw new E2EFixtureError(
      "E2E_FIXTURE_PHONE_TAKEN",
      409,
      `phone ${phone} belongs to an account the fixture API did not create`,
    );
  }

  const now = new Date().toISOString();
  let user = matches[0];
  if (!user) {
    const role = await fetchRoleByName(strapi, ROLE_NAMES.CUSTOMER);
    user = await q(strapi, USER_UID).create({
      data: {
        username: phone,
        email,
        phone,
        provider: "local",
        role: role?.id,
        confirmed: true,
        blocked: false,
        IsActive: true,
        IsVerified: true,
        AccountOrigin: "Native",
        ClaimedAt: now,
        ProfileCompletedAt: now,
        ProfileManagedByCustomer: true,
      },
    });
  } else if (user.blocked || !user.confirmed) {
    await q(strapi, USER_UID).update({ where: { id: user.id }, data: { blocked: false, confirmed: true } });
  }

  // Domain APIs refuse a customer without a name (docs/auth/architecture.md).
  const info = user.user_info ?? (await q(strapi, USER_INFO_UID).findOne({ where: { user: user.id } }));
  if (!info) {
    await q(strapi, USER_INFO_UID).create({ data: { user: user.id, FirstName: firstName, LastName: lastName } });
  } else if (info.FirstName !== firstName || info.LastName !== lastName) {
    await q(strapi, USER_INFO_UID).update({ where: { id: info.id }, data: { FirstName: firstName, LastName: lastName } });
  }

  // A new password on every call: nothing reusable is stored outside the run.
  const password = randomBytes(18).toString("base64url");
  await updatePasswordAndLegacyHash(user.id, password);
  return { userId: Number(user.id), phone, password, firstName, lastName };
}

/** Cancel the shopper's unfinished checkouts and empty the cart. */
async function resetShopperState(strapi: Strapi, userId: number) {
  const open: any[] = await q(strapi, ORDER_UID).findMany({
    where: { user: { id: userId }, Status: "Paying" },
    populate: { contract: true },
  });
  for (const order of open) {
    if (order.contract?.id) {
      await cancelOrderAndRelease(strapi, order.id, order.contract.id, userId, "e2e fixture reset", {
        cancellationReasonCode: "customer_request",
      });
    } else {
      await releaseOrderReservation(strapi, order.id, "Released", undefined, { userId });
      await q(strapi, ORDER_UID).update({ where: { id: order.id }, data: { Status: "Cancelled" } });
    }
  }

  // deleteMany cannot filter on a relation (Strapi emits invalid SQL), so the
  // lines are selected first and deleted by id.
  const carts: any[] = await q(strapi, CART_UID).findMany({ where: { user: { id: userId } }, select: ["id"] });
  const lines: any[] = carts.length
    ? await q(strapi, CART_ITEM_UID).findMany({
        where: { cart: { id: { $in: carts.map((cart) => cart.id) } } },
        select: ["id"],
      })
    : [];
  if (lines.length) {
    await q(strapi, CART_ITEM_UID).deleteMany({ where: { id: { $in: lines.map((line) => line.id) } } });
  }
  return open.length;
}

async function pickShippingCity(strapi: Strapi) {
  const cities: any[] = await q(strapi, CITY_UID).findMany({
    orderBy: { id: "asc" },
    limit: 200,
    populate: { shipping_province: true },
  });
  const withProvince = cities.filter((city) => city.shipping_province);
  const city = withProvince.find((candidate) => String(candidate.Title).includes("تهران")) ?? withProvince[0];
  if (!city) throw new E2EFixtureError("E2E_FIXTURE_NO_SHIPPING_CITY", 409, "no shipping city is configured here");
  return city;
}

async function ensureAddress(strapi: Strapi, slot: number, userId: number, phone: string, fullName: string) {
  const fullAddress = `E2E fixture address, slot ${pad(slot)}, plaque 1`;
  const postalCode = "1234567890";
  const city = await pickShippingCity(strapi);
  const existing: any = await q(strapi, ADDRESS_UID).findOne({
    where: { user: { id: userId }, FullAddress: fullAddress },
    populate: { shipping_city: true },
  });
  const data = {
    user: userId,
    shipping_city: city.id,
    PostalCode: postalCode,
    FullAddress: fullAddress,
    FullName: fullName,
    Phone: `0${phone.slice(3)}`,
    IsTemporary: false,
  };
  const address: any = existing
    ? await q(strapi, ADDRESS_UID).update({ where: { id: existing.id }, data })
    : await q(strapi, ADDRESS_UID).create({ data });
  return { id: Number(address.id), fullAddress, city: String(city.Title), postalCode };
}

async function setWallet(strapi: Strapi, userId: number, walletToman: number) {
  const current = await readWalletAvailability(strapi, userId);
  const targetIrr = walletToman * 10;
  if (current.balanceIrr === targetIrr) return;
  const audit = { initiator: AUDIT_PRINCIPAL, actor: AUDIT_PRINCIPAL, origin: "maintenance" as const };
  const reason = "E2E fixture reset";
  if (targetIrr > 0) {
    await applyAdminWalletAdjustment(strapi, { userId, mode: "set", amountIrr: targetIrr, reason, audit });
  } else {
    await applyAdminWalletAdjustment(strapi, { userId, mode: "debit", amountIrr: current.balanceIrr, reason, audit });
  }
}

export async function provisionShopper(
  strapi: Strapi,
  input: { slot: number; walletToman: number },
): Promise<ShopperFixture> {
  const warnings: string[] = [];
  const shopper = await ensureShopper(strapi, input.slot);
  const cancelled = await resetShopperState(strapi, shopper.userId);
  if (cancelled) warnings.push(`cancelled ${cancelled} unfinished checkout(s) left by an earlier run`);
  const catalog = await ensureCatalog(strapi);
  const { product, variations } = await ensureSlotProduct(strapi, input.slot, catalog, warnings);
  const address = await ensureAddress(
    strapi, input.slot, shopper.userId, shopper.phone, `${shopper.firstName} ${shopper.lastName}`,
  );
  await setWallet(strapi, shopper.userId, input.walletToman);
  const gateways = (await getAvailableCheckoutGateways(strapi)).map((gateway) => gateway.code);
  return {
    slot: input.slot,
    ...shopper,
    product,
    variations,
    address,
    walletToman: input.walletToman,
    checks: { gateways },
    warnings,
  };
}

async function slotProduct(strapi: Strapi, slot: number): Promise<any> {
  const product = await tagged(strapi, PRODUCT_UID, `product:s${pad(slot)}`);
  if (!product) throw new E2EFixtureError("E2E_FIXTURE_SLOT_UNPROVISIONED", 404, `slot ${slot} has no product yet`);
  return product;
}

export async function readSlotStock(strapi: Strapi, slot: number) {
  await slotProduct(strapi, slot);
  const rows: any[] = await q(strapi, VARIATION_UID).findMany({
    where: { SKU: { $in: [slotSku(slot, "IN"), slotSku(slot, "OUT")] }, external_source: E2E_FIXTURE_SOURCE },
    populate: { product_stock: true },
  });
  return Object.fromEntries(
    rows.map((row) => [
      row.SKU,
      { count: Number(row.product_stock?.Count ?? 0), reserved: Number(row.product_stock?.reservedCount ?? 0) },
    ]),
  );
}

export async function cleanupShopper(strapi: Strapi, slot: number) {
  const users: any[] = await q(strapi, USER_UID).findMany({
    where: { phone: { $in: customerPhoneStorageVariants(e2eFixturePhone(slot)) } },
    limit: 2,
  });
  const user = users.find((candidate) => String(candidate.email || "").endsWith(`@${E2E_FIXTURE_EMAIL_DOMAIN}`));
  if (!user) return { cancelledCheckouts: 0 };
  const cancelledCheckouts = await resetShopperState(strapi, Number(user.id));
  const product = await tagged(strapi, PRODUCT_UID, `product:s${pad(slot)}`);
  const warnings: string[] = [];
  if (product && !product.removedAt) await setProductPublished(strapi, product.id, true, warnings);
  return { cancelledCheckouts, warnings };
}

export async function setSlotProductPublished(strapi: Strapi, slot: number, published: boolean) {
  const product = await slotProduct(strapi, slot);
  const warnings: string[] = [];
  await setProductPublished(strapi, product.id, published, warnings);
  const row: any = await q(strapi, PRODUCT_UID).findOne({ where: { id: product.id } });
  return { productId: product.id, published: isProductPubliclyVisible(row), warnings };
}
