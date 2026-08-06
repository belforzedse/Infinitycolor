import { createHash } from "node:crypto";
import { getTrustedWordPressMigrationSourceTimestamps } from "../../../utils/migration-context";

const USER_UID = "plugin::users-permissions.user";
const USER_INFO_UID = "api::local-user-info.local-user-info";
const ROLE_UID = "plugin::users-permissions.role";
const WALLET_UID = "api::local-user-wallet.local-user-wallet";
const ORDER_UID = "api::order.order";
const ORDER_ITEM_UID = "api::order-item.order-item";
const CONTRACT_UID = "api::contract.contract";
const VARIATION_UID = "api::product-variation.product-variation";

const ORDER_STATUSES = new Set(["Paying", "Started", "Shipment", "Done", "Returned", "Cancelled"]);
const CONTRACT_STATUSES = new Set(["Not Ready", "Confirmed", "Finished", "Failed", "Cancelled"]);
const PAYMENT_GATEWAYS = new Set(["Unknown", "Wallet", "Mellat", "SnappPay", "SamanKish", "ZarinPal"]);
const CONTRACT_TYPES = new Set(["Cash", "Credit"]);

const SNAPSHOT_ENTITIES: Record<string, { uid: string; select: string[] }> = {
  users: { uid: USER_UID, select: ["id", "external_id", "external_source", "phone", "email", "createdAt", "updatedAt"] },
  wallets: { uid: WALLET_UID, select: ["id", "Balance", "createdAt", "updatedAt"] },
  orders: { uid: ORDER_UID, select: ["id", "external_id", "external_source", "createdAt", "updatedAt"] },
  variations: { uid: VARIATION_UID, select: ["id", "external_id", "external_source", "createdAt", "updatedAt"] },
  products: { uid: "api::product.product", select: ["id", "external_id", "external_source", "LastEditedByAdminAt", "createdAt", "updatedAt"] },
  blogPosts: { uid: "api::blog-post.blog-post", select: ["id", "Slug", "createdAt", "updatedAt"] },
  blogCategories: { uid: "api::blog-category.blog-category", select: ["id", "Slug", "createdAt", "updatedAt"] },
  blogTags: { uid: "api::blog-tag.blog-tag", select: ["id", "Slug", "createdAt", "updatedAt"] },
  blogAuthors: { uid: "api::blog-author.blog-author", select: ["id", "Name", "Email", "createdAt", "updatedAt"] },
};

export class MigrationInputError extends Error {
  status: number;
  code: string;

  constructor(code: string, status = 400) {
    super(code);
    this.name = "MigrationInputError";
    this.status = status;
    this.code = code;
  }
}

const requiredId = (value: unknown, code: string): string => {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id) || id === "0") throw new MigrationInputError(code);
  return id;
};

const optionalText = (value: unknown, max: number): string =>
  String(value ?? "").trim().slice(0, max);

export function canonicalIranPhone(value: unknown): string | null {
  let phone = String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[^\d+]/g, "");
  if (phone.startsWith("0098")) phone = `+98${phone.slice(4)}`;
  else if (phone.startsWith("98")) phone = `+${phone}`;
  else if (phone.startsWith("09")) phone = `+98${phone.slice(1)}`;
  else if (phone.startsWith("9")) phone = `+98${phone}`;
  return /^\+989\d{9}$/.test(phone) ? phone : null;
}

export function exactNonNegativeInteger(value: unknown, code: string): string {
  const amount = String(value ?? "").trim();
  if (!/^\d+$/.test(amount)) throw new MigrationInputError(code);
  return BigInt(amount).toString();
}

function optionalEmail(value: unknown): string | null {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 255) : null;
}

function advisoryKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest().readBigInt64BE(0).toString();
}

async function findMany(query: any, where: Record<string, unknown>, trx: any, limit = 2) {
  return query.findMany({ where, limit, transacting: trx } as any) as Promise<any[]>;
}

export async function getSnapshot(strapiInstance: any, input: any) {
  const entity = String(input?.entity || "");
  const spec = SNAPSHOT_ENTITIES[entity];
  if (!spec) throw new MigrationInputError("SNAPSHOT_ENTITY_INVALID");
  const page = Number(input?.page || 1);
  const pageSize = Number(input?.pageSize || 500);
  if (!Number.isSafeInteger(page) || page < 1) throw new MigrationInputError("SNAPSHOT_PAGE_INVALID");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new MigrationInputError("SNAPSHOT_PAGE_SIZE_INVALID");
  }
  const populate = entity === "wallets"
    ? { user: { select: ["id", "external_id", "external_source"] } }
    : undefined;
  const rows = await strapiInstance.db.query(spec.uid).findMany({
    select: spec.select,
    ...(populate ? { populate } : {}),
    orderBy: { id: "asc" },
    offset: (page - 1) * pageSize,
    limit: pageSize,
  } as any);
  return {
    entity,
    page,
    pageSize,
    hasMore: rows.length === pageSize,
    rows,
  };
}

export async function restoreMediaTimestamps(strapiInstance: any, body: any) {
  const id = Number(requiredId(body?.id, "MEDIA_ID_INVALID"));
  if (!Number.isSafeInteger(id)) throw new MigrationInputError("MEDIA_ID_INVALID");
  if (!getTrustedWordPressMigrationSourceTimestamps()) {
    throw new MigrationInputError("MEDIA_SOURCE_TIMESTAMPS_REQUIRED");
  }

  const fileQuery = strapiInstance.db.query("plugin::upload.file");
  const file = await fileQuery.findOne({ where: { id }, select: ["id"] });
  if (!file) throw new MigrationInputError("MEDIA_NOT_FOUND", 404);

  // Strapi's normal timestamp lifecycle will add updatedAt, and the trusted
  // migration timestamp lifecycle registered after it replaces both timestamps
  // with the validated source instants from the request headers.
  const saved = await fileQuery.update({ where: { id }, data: {} } as any);
  return { id: Number(saved?.id || id), mode: "updated" };
}

async function findUniqueUserForSource(query: any, sourceId: string, trx: any): Promise<any | null> {
  const matches = await findMany(
    query,
    { external_source: "wordpress", external_id: sourceId },
    trx,
  );
  if (matches.length > 1) throw new MigrationInputError("USER_SOURCE_ID_AMBIGUOUS", 409);
  return matches[0] || null;
}

export async function upsertUser(strapiInstance: any, body: any) {
  const sourceId = requiredId(body?.sourceId, "USER_SOURCE_ID_INVALID");
  const phone = canonicalIranPhone(body?.phone);
  if (!phone) throw new MigrationInputError("USER_PHONE_INVALID");
  const sourceEmail = optionalEmail(body?.email);
  const email = sourceEmail || `wp-${sourceId}@placeholder.local`;
  const firstName = optionalText(body?.firstName, 255);
  const lastName = optionalText(body?.lastName, 255);

  return strapiInstance.db.transaction(async ({ trx }: { trx: any }) => {
    const locks = [
      advisoryKey(`wordpress-user-source:${sourceId}`),
      advisoryKey(`wordpress-user-phone:${phone}`),
    ].sort();
    for (const lock of locks) {
      await trx.raw("SELECT pg_advisory_xact_lock(?)", [lock]);
    }
    const userQuery = strapiInstance.db.query(USER_UID);
    const sourceMatch = await findUniqueUserForSource(userQuery, sourceId, trx);
    const phoneMatches = await findMany(userQuery, { phone }, trx);
    if (phoneMatches.length > 1) throw new MigrationInputError("USER_PHONE_AMBIGUOUS", 409);
    const phoneMatch = phoneMatches[0] || null;
    if (sourceMatch && phoneMatch && Number(sourceMatch.id) !== Number(phoneMatch.id)) {
      throw new MigrationInputError("USER_SOURCE_PHONE_CONFLICT", 409);
    }
    if (
      !sourceMatch &&
      phoneMatch?.external_source === "wordpress" &&
      String(phoneMatch.external_id || "") !== sourceId
    ) {
      throw new MigrationInputError("USER_PHONE_SOURCE_CONFLICT", 409);
    }
    const existing = sourceMatch || phoneMatch;

    const emailMatches = await findMany(userQuery, { email: { $eqi: email } }, trx);
    if (emailMatches.some((candidate) => Number(candidate.id) !== Number(existing?.id))) {
      throw new MigrationInputError("USER_EMAIL_CONFLICT", 409);
    }

    const roles = await findMany(strapiInstance.db.query(ROLE_UID), { type: "customer" }, trx);
    if (roles.length !== 1) throw new MigrationInputError("CUSTOMER_ROLE_NOT_UNIQUE", 409);

    const data = {
      username: phone,
      email,
      phone,
      provider: "local",
      confirmed: true,
      blocked: false,
      IsActive: true,
      IsVerified: false,
      role: roles[0].id,
      external_source: "wordpress",
      external_id: sourceId,
    };
    const saved = existing
      ? await userQuery.update({ where: { id: existing.id }, data, transacting: trx } as any)
      : await userQuery.create({ data, transacting: trx } as any);

    const infoQuery = strapiInstance.db.query(USER_INFO_UID);
    const infos = await findMany(infoQuery, { user: saved.id }, trx);
    if (infos.length > 1) throw new MigrationInputError("USER_INFO_AMBIGUOUS", 409);
    const infoData = { FirstName: firstName, LastName: lastName, user: saved.id };
    if (infos[0]) {
      await infoQuery.update({ where: { id: infos[0].id }, data: infoData, transacting: trx } as any);
    } else {
      await infoQuery.create({ data: infoData, transacting: trx } as any);
    }

    return { mode: existing ? "updated" : "created", id: Number(saved.id) };
  });
}

export async function upsertWallet(strapiInstance: any, body: any) {
  const userSourceId = requiredId(body?.userSourceId, "WALLET_USER_SOURCE_ID_INVALID");
  const balance = exactNonNegativeInteger(body?.balanceRial, "WALLET_BALANCE_INVALID");

  return strapiInstance.db.transaction(async ({ trx }: { trx: any }) => {
    await trx.raw("SELECT pg_advisory_xact_lock(?)", [advisoryKey(`wordpress-wallet:${userSourceId}`)]);
    const user = await findUniqueUserForSource(strapiInstance.db.query(USER_UID), userSourceId, trx);
    if (!user) throw new MigrationInputError("WALLET_USER_NOT_FOUND", 409);
    const walletQuery = strapiInstance.db.query(WALLET_UID);
    const wallets = await findMany(walletQuery, { user: user.id }, trx);
    if (wallets.length > 1) throw new MigrationInputError("USER_WALLET_AMBIGUOUS", 409);
    const data = { Balance: balance, user: user.id };
    const saved = wallets[0]
      ? await walletQuery.update({ where: { id: wallets[0].id }, data, transacting: trx } as any)
      : await walletQuery.create({ data, transacting: trx } as any);
    return { mode: wallets[0] ? "updated" : "created", id: Number(saved.id) };
  });
}

function validatedDate(value: unknown): string {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) throw new MigrationInputError("ORDER_DATE_INVALID");
  return date.toISOString();
}

function positiveCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) throw new MigrationInputError("ORDER_ITEM_COUNT_INVALID");
  return count;
}

async function resolveOrderUser(strapiInstance: any, body: any, trx: any): Promise<any | null> {
  const userQuery = strapiInstance.db.query(USER_UID);
  if (body?.customerSourceId) {
    const user = await findUniqueUserForSource(
      userQuery,
      requiredId(body.customerSourceId, "ORDER_CUSTOMER_SOURCE_ID_INVALID"),
      trx,
    );
    if (!user) throw new MigrationInputError("ORDER_CUSTOMER_NOT_FOUND", 409);
    return user;
  }
  const guestPhone = canonicalIranPhone(body?.guestPhone);
  if (!guestPhone) return null;
  const matches = await findMany(userQuery, { phone: guestPhone }, trx);
  if (matches.length > 1) throw new MigrationInputError("ORDER_GUEST_PHONE_AMBIGUOUS", 409);
  return matches[0] || null;
}

export async function upsertOrder(strapiInstance: any, body: any) {
  const sourceId = requiredId(body?.sourceId, "ORDER_SOURCE_ID_INVALID");
  const status = String(body?.status || "");
  const contractStatus = String(body?.contractStatus || "");
  const paymentGateway = String(body?.paymentGateway || "Unknown");
  const contractType = String(body?.contractType || "");
  const taxPercent = Number(body?.taxPercent);
  if (!ORDER_STATUSES.has(status)) throw new MigrationInputError("ORDER_STATUS_INVALID");
  if (!CONTRACT_STATUSES.has(contractStatus)) throw new MigrationInputError("CONTRACT_STATUS_INVALID");
  if (!PAYMENT_GATEWAYS.has(paymentGateway)) throw new MigrationInputError("PAYMENT_GATEWAY_INVALID");
  if (!CONTRACT_TYPES.has(contractType)) throw new MigrationInputError("CONTRACT_TYPE_INVALID");
  if (!Number.isSafeInteger(taxPercent) || taxPercent < 0 || taxPercent > 100) {
    throw new MigrationInputError("CONTRACT_TAX_PERCENT_INVALID");
  }
  const date = validatedDate(body?.date);
  const totalToman = exactNonNegativeInteger(body?.totalToman, "ORDER_TOTAL_INVALID");
  const shippingToman = Number(exactNonNegativeInteger(body?.shippingToman ?? "0", "ORDER_SHIPPING_INVALID"));
  if (!Number.isSafeInteger(shippingToman)) throw new MigrationInputError("ORDER_SHIPPING_UNSAFE_INTEGER");
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) throw new MigrationInputError("ORDER_ITEMS_EMPTY");

  return strapiInstance.db.transaction(async ({ trx }: { trx: any }) => {
    await trx.raw("SELECT pg_advisory_xact_lock(?)", [advisoryKey(`woocommerce-order:${sourceId}`)]);
    const orderQuery = strapiInstance.db.query(ORDER_UID);
    const existingOrders = await findMany(
      orderQuery,
      { external_source: "woocommerce", external_id: sourceId },
      trx,
    );
    if (existingOrders.length > 1) throw new MigrationInputError("ORDER_SOURCE_ID_AMBIGUOUS", 409);
    const existing = existingOrders[0] || null;
    const user = await resolveOrderUser(strapiInstance, body, trx);
    const orderData = {
      Date: date,
      Status: status,
      ReservationStatus: "Released",
      Type: "Automatic",
      ShippingCost: shippingToman,
      ShippingMethodCode: optionalText(body?.shippingMethodCode, 255) || null,
      ShippingMethodTitle: optionalText(body?.shippingMethodTitle, 255) || null,
      PaymentGateway: paymentGateway,
      user: user?.id || null,
      delivery_address: null,
      Description: null,
      Note: null,
      external_source: "woocommerce",
      external_id: sourceId,
    };
    const order = existing
      ? await orderQuery.update({ where: { id: existing.id }, data: orderData, transacting: trx } as any)
      : await orderQuery.create({ data: orderData, transacting: trx } as any);

    const contractQuery = strapiInstance.db.query(CONTRACT_UID);
    const contracts = await findMany(
      contractQuery,
      { external_source: "woocommerce", external_id: `contract_${sourceId}` },
      trx,
    );
    if (contracts.length > 1) throw new MigrationInputError("ORDER_CONTRACT_AMBIGUOUS", 409);
    const contractData = {
      Type: contractType,
      Status: contractStatus,
      Amount: totalToman,
      TaxPercent: taxPercent,
      Date: date,
      local_user: user?.id || null,
      order: order.id,
      external_source: "woocommerce",
      external_id: `contract_${sourceId}`,
    };
    const contract = contracts[0]
      ? await contractQuery.update({ where: { id: contracts[0].id }, data: contractData, transacting: trx } as any)
      : await contractQuery.create({ data: contractData, transacting: trx } as any);

    const itemQuery = strapiInstance.db.query(ORDER_ITEM_UID);
    let itemsCreated = 0;
    let itemsUpdated = 0;
    const retainedExternalIds = new Set<string>();
    for (const sourceItem of items) {
      const sourceItemId = requiredId(sourceItem?.sourceId, "ORDER_ITEM_SOURCE_ID_INVALID");
      const externalId = `line_item_${sourceItemId}`;
      retainedExternalIds.add(externalId);
      const existingItems = await findMany(
        itemQuery,
        { external_source: "woocommerce", external_id: externalId, order: order.id },
        trx,
      );
      if (existingItems.length > 1) throw new MigrationInputError("ORDER_ITEM_SOURCE_ID_AMBIGUOUS", 409);
      const variationSourceId = requiredId(sourceItem?.variationSourceId, "ORDER_ITEM_VARIATION_ID_INVALID");
      const variationMatches = await findMany(
        strapiInstance.db.query(VARIATION_UID),
        { external_source: "woocommerce", external_id: variationSourceId },
        trx,
      );
      if (variationMatches.length !== 1) throw new MigrationInputError("ORDER_ITEM_VARIATION_NOT_UNIQUE", 409);
      const itemData = {
        Count: positiveCount(sourceItem?.count),
        PerAmount: exactNonNegativeInteger(sourceItem?.unitPriceToman, "ORDER_ITEM_PRICE_INVALID"),
        ProductTitle: optionalText(sourceItem?.title, 255) || "WooCommerce product",
        ProductSKU: optionalText(sourceItem?.sku, 255) || `WC-${variationSourceId}`,
        product_variation: variationMatches[0].id,
        order: order.id,
        external_source: "woocommerce",
        external_id: externalId,
      };
      if (existingItems[0]) {
        await itemQuery.update({ where: { id: existingItems[0].id }, data: itemData, transacting: trx } as any);
        itemsUpdated += 1;
      } else {
        await itemQuery.create({ data: itemData, transacting: trx } as any);
        itemsCreated += 1;
      }
    }

    const sourceOwnedItems = await itemQuery.findMany({
      where: { order: order.id, external_source: "woocommerce" },
      select: ["id", "external_id"],
      limit: 1000,
      transacting: trx,
    } as any);
    let itemsDeleted = 0;
    for (const sourceOwnedItem of sourceOwnedItems) {
      if (!retainedExternalIds.has(String(sourceOwnedItem.external_id || ""))) {
        await itemQuery.delete({ where: { id: sourceOwnedItem.id }, transacting: trx } as any);
        itemsDeleted += 1;
      }
    }

    return {
      mode: existing ? "updated" : "created",
      id: Number(order.id),
      contractId: Number(contract.id),
      itemsCreated,
      itemsUpdated,
      itemsDeleted,
      userLinked: Boolean(user),
    };
  });
}
