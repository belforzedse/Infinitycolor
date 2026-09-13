import { createHash } from "node:crypto";
import { getTrustedWordPressMigrationSourceTimestamps } from "../../../utils/migration-context";
import {
  canonicalIranPhone,
  MigrationInputError,
  reconcileCustomerIdentity,
  resolveRegisteredCustomerForOrder,
  resolveUserForLegacySource,
  USER_UID,
} from "./customer-identity";
import {
  getCategoryEditorialSnapshot,
} from "./category-editorial-migration";

export { canonicalIranPhone, MigrationInputError } from "./customer-identity";

const WALLET_UID = "api::local-user-wallet.local-user-wallet";
const ORDER_UID = "api::order.order";
const ORDER_ITEM_UID = "api::order-item.order-item";
const CONTRACT_UID = "api::contract.contract";
const VARIATION_UID = "api::product-variation.product-variation";
const ADDRESS_UID = "api::local-user-address.local-user-address";
const PROVINCE_UID = "api::shipping-province.shipping-province";
const CITY_UID = "api::shipping-city.shipping-city";

const ORDER_STATUSES = new Set(["Paying", "Started", "Shipment", "Done", "Returned", "Cancelled"]);
const CONTRACT_STATUSES = new Set(["Not Ready", "Confirmed", "Finished", "Failed", "Cancelled"]);
const PAYMENT_GATEWAYS = new Set(["Unknown", "Wallet", "Mellat", "SnappPay", "SamanKish", "ZarinPal"]);
const CONTRACT_TYPES = new Set(["Cash", "Credit"]);

const SNAPSHOT_ENTITIES: Record<string, { uid: string; select: string[] }> = {
  users: { uid: USER_UID, select: ["id", "external_id", "external_source", "phone", "email", "AccountOrigin", "ClaimedAt", "ProfileCompletedAt", "ProfileManagedByCustomer", "SourceCreatedAt", "SourceUpdatedAt", "createdAt", "updatedAt"] },
  wallets: { uid: WALLET_UID, select: ["id", "Balance", "createdAt", "updatedAt"] },
  orders: { uid: ORDER_UID, select: ["id", "external_id", "external_source", "createdAt", "updatedAt"] },
  variations: { uid: VARIATION_UID, select: ["id", "external_id", "external_source", "createdAt", "updatedAt"] },
  products: { uid: "api::product.product", select: ["id", "external_id", "external_source", "LastEditedByAdminAt", "createdAt", "updatedAt"] },
  blogPosts: { uid: "api::blog-post.blog-post", select: ["id", "Slug", "createdAt", "updatedAt"] },
  blogCategories: { uid: "api::blog-category.blog-category", select: ["id", "Slug", "createdAt", "updatedAt"] },
  blogTags: { uid: "api::blog-tag.blog-tag", select: ["id", "Slug", "createdAt", "updatedAt"] },
  blogAuthors: { uid: "api::blog-author.blog-author", select: ["id", "Name", "Email", "createdAt", "updatedAt"] },
};

const requiredId = (value: unknown, code: string): string => {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id) || id === "0") throw new MigrationInputError(code);
  return id;
};

const optionalText = (value: unknown, max: number): string =>
  String(value ?? "").trim().slice(0, max);

export function exactNonNegativeInteger(value: unknown, code: string): string {
  const amount = String(value ?? "").trim();
  if (!/^\d+$/.test(amount)) throw new MigrationInputError(code);
  return BigInt(amount).toString();
}

function advisoryKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest().readBigInt64BE(0).toString();
}

async function findMany(query: any, where: Record<string, unknown>, trx: any, limit = 2) {
  return query.findMany({ where, limit, transacting: trx } as any) as Promise<any[]>;
}

export async function getSnapshot(strapiInstance: any, input: any) {
  const entity = String(input?.entity || "");
  if (entity === "categoryEditorial") {
    return getCategoryEditorialSnapshot(strapiInstance, input);
  }
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

export async function upsertUser(strapiInstance: any, body: any) {
  const sourceId = requiredId(body?.sourceId, "USER_SOURCE_ID_INVALID");
  return strapiInstance.db.transaction(async ({ trx }: { trx: any }) => {
    const result = await reconcileCustomerIdentity(strapiInstance, {
      kind: "registered",
      sourceCustomerId: sourceId,
      phone: body?.phone,
      email: body?.email,
      firstName: body?.firstName,
      lastName: body?.lastName,
      sourceCreatedAt: body?.sourceCreatedAt,
      sourceUpdatedAt: body?.sourceUpdatedAt,
      allowPhoneMerge: body?.allowPhoneMerge === true,
    }, trx);
    return {
      mode: result.mode,
      id: Number(result.user.id),
      matchReason: result.matchReason,
      issues: result.issues,
    };
  });
}

export async function upsertWallet(strapiInstance: any, body: any) {
  const userSourceId = requiredId(body?.userSourceId, "WALLET_USER_SOURCE_ID_INVALID");
  const balance = exactNonNegativeInteger(body?.balanceRial, "WALLET_BALANCE_INVALID");

  return strapiInstance.db.transaction(async ({ trx }: { trx: any }) => {
    await trx.raw("SELECT pg_advisory_xact_lock(?)", [advisoryKey(`wordpress-wallet:${userSourceId}`)]);
    const user = await resolveUserForLegacySource(strapiInstance, userSourceId, trx);
    if (!user) throw new MigrationInputError("WALLET_USER_NOT_FOUND", 409);
    const walletQuery = strapiInstance.db.query(WALLET_UID);
    const wallets = await findMany(walletQuery, { user: user.id }, trx);
    if (wallets.length > 1) throw new MigrationInputError("USER_WALLET_AMBIGUOUS", 409);
    // Balance is replaced, not incremented, so a legacy figure must never land on
    // an account that has since transacted — that would silently destroy money.
    const current = exactNonNegativeInteger(wallets[0]?.Balance ?? "0", "WALLET_BALANCE_INVALID");
    if (current !== "0" && current !== balance) {
      throw new MigrationInputError("WALLET_BALANCE_WOULD_CLOBBER", 409);
    }
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

function normalizePersianTitle(value: unknown): string {
  return String(value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u200c\u200d\u200e\u200f\sـ()\-]/g, "")
    .toLowerCase();
}

function cityTitleCandidates(value: unknown): string[] {
  const raw = optionalText(value, 255);
  if (!raw) return [];
  const candidates = [raw];
  for (const separator of [" ـ ", " - ", "–", "—", "،", ","]) {
    if (raw.includes(separator)) candidates.push(raw.split(separator)[0].trim());
  }
  candidates.push(raw.replace(/کاوس/g, "کاووس"));
  candidates.push(raw.replace(/شهرجدید/g, "شهر جدید "));
  candidates.push(raw.replace(/^بندر\s*/g, ""));
  candidates.push(raw.replace(/^شهر\s*/g, ""));
  return [...new Set(candidates.map(normalizePersianTitle).filter(Boolean))];
}

function orderPostalCode(value: unknown): string {
  const digits = String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/\D/g, "");
  return /^\d{10}$/.test(digits) ? digits : "0000000000";
}

async function resolveWooDeliveryAddress(
  strapiInstance: any,
  sourceId: string,
  sourceAddress: any,
  existingAddress: any,
  user: any,
  trx: any,
): Promise<{ id: number | null; mode: string; reason: string }> {
  if (existingAddress?.id) {
    return { id: Number(existingAddress.id), mode: "preserved", reason: "EXISTING_ADDRESS" };
  }
  if (!sourceAddress) {
    return { id: null, mode: "skipped", reason: "SOURCE_ADDRESS_EMPTY" };
  }

  const stateCode = optionalText(sourceAddress?.stateCode, 32).toUpperCase();
  const cityTitle = optionalText(sourceAddress?.cityTitle, 255);
  const fullAddress = optionalText(sourceAddress?.fullAddress, 4000);
  if (!stateCode) return { id: null, mode: "skipped", reason: "PROVINCE_CODE_EMPTY" };
  if (!cityTitle) return { id: null, mode: "skipped", reason: "CITY_TITLE_EMPTY" };
  if (!fullAddress) return { id: null, mode: "skipped", reason: "ADDRESS_LINE_EMPTY" };

  const provinces = await findMany(
    strapiInstance.db.query(PROVINCE_UID),
    { Code: stateCode },
    trx,
  );
  if (provinces.length > 1) {
    throw new MigrationInputError("ORDER_ADDRESS_PROVINCE_AMBIGUOUS", 409);
  }
  const province = provinces[0] || null;
  if (!province) {
    return { id: null, mode: "skipped", reason: "PROVINCE_CODE_UNKNOWN" };
  }

  const cities = await strapiInstance.db.query(CITY_UID).findMany({
    where: { shipping_province: province.id },
    select: ["id", "Title"],
    limit: 1000,
    transacting: trx,
  } as any);
  const candidates = new Set(cityTitleCandidates(cityTitle));
  const matches = cities.filter((city: any) => candidates.has(normalizePersianTitle(city?.Title)));
  if (matches.length > 1) {
    throw new MigrationInputError("ORDER_ADDRESS_CITY_AMBIGUOUS", 409);
  }
  const city = matches[0] || null;
  if (!city) return { id: null, mode: "skipped", reason: "CITY_TITLE_UNMATCHED" };

  const recipientPhone = canonicalIranPhone(sourceAddress?.recipientPhone);
  const saved = await strapiInstance.db.query(ADDRESS_UID).create({
    data: {
      PostalCode: orderPostalCode(sourceAddress?.postalCode),
      FullAddress: fullAddress,
      FullName: optionalText(sourceAddress?.recipientName, 255) || null,
      Phone: recipientPhone || null,
      Description: `woo-order:${sourceId}`,
      IsTemporary: true,
      shipping_city: city.id,
      user: user?.id || null,
    },
    transacting: trx,
  } as any);
  return { id: Number(saved.id), mode: "created", reason: "SOURCE_ADDRESS_ATTACHED" };
}

/** Soft-fail identity codes: keep the order; prefer guest-phone fallback when possible. */
const ORDER_IDENTITY_SOFT_FAIL = new Set([
  "ORDER_CUSTOMER_NOT_FOUND",
  "ORDER_CUSTOMER_MAPPING_CONFLICT",
  "ORDER_USER_IDENTITY_CONFLICT",
  "USER_PHONE_SOURCE_CONFLICT",
  "USER_SOURCE_PHONE_CONFLICT",
  "USER_IDENTITY_CONFLICT",
  "USER_PHONE_AMBIGUOUS",
  "USER_PHONE_CONFLICT",
  "USER_CLAIMED_PHONE_CONFLICT",
  "USER_PHONE_INVALID",
  "IDENTITY_MAPPING_USER_NOT_FOUND",
]);

function isIdentitySoftFail(error: unknown): error is MigrationInputError {
  return error instanceof MigrationInputError && ORDER_IDENTITY_SOFT_FAIL.has(error.code);
}

async function resolveGuestOrderUser(
  strapiInstance: any,
  body: any,
  trx: any,
): Promise<{ user: any; matchReason: string; issues: string[] }> {
  const guest = body?.guestIdentity || body?.orderIdentity || { phone: body?.guestPhone };
  return reconcileCustomerIdentity(strapiInstance, {
    kind: "guest",
    sourceOrderId: body?.sourceId,
    phone: guest?.phone,
    email: guest?.email,
    firstName: guest?.firstName,
    lastName: guest?.lastName,
    sourceCreatedAt: body?.sourceCreatedAt,
    sourceUpdatedAt: body?.sourceUpdatedAt,
  }, trx);
}

/**
 * Prefer the registered Woo customer. If that identity collides or was never
 * provisioned, fall back to billing-phone guest reconcile so the order still
 * gets an owner without merging conflicting wordpress external_ids.
 */
async function resolveOrderUser(strapiInstance: any, body: any, trx: any): Promise<any> {
  if (body?.customerSourceId) {
    const sourceId = requiredId(body.customerSourceId, "ORDER_CUSTOMER_SOURCE_ID_INVALID");
    try {
      const user = await resolveRegisteredCustomerForOrder(
        strapiInstance,
        sourceId,
        trx,
        body?.orderIdentity,
      );
      return { user, matchReason: "source-customer-id", issues: [] };
    } catch (error) {
      if (!isIdentitySoftFail(error)) throw error;
      const registeredIssue = error.code;
      try {
        const guest = await resolveGuestOrderUser(strapiInstance, body, trx);
        if (!guest.user) {
          return {
            user: null,
            matchReason: "unresolved",
            issues: [registeredIssue, "ORDER_REGISTERED_IDENTITY_GUEST_FALLBACK_UNRESOLVED"],
          };
        }
        return {
          user: guest.user,
          matchReason: `guest-fallback:${guest.matchReason}`,
          issues: [
            registeredIssue,
            "ORDER_REGISTERED_IDENTITY_GUEST_FALLBACK",
            ...(guest.issues || []),
          ],
        };
      } catch (guestError) {
        if (!isIdentitySoftFail(guestError)) throw guestError;
        return {
          user: null,
          matchReason: "unresolved",
          issues: [registeredIssue, guestError.code],
        };
      }
    }
  }
  return resolveGuestOrderUser(strapiInstance, body, trx);
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
    const existingOrders = await orderQuery.findMany({
      where: { external_source: "woocommerce", external_id: sourceId },
      populate: {
        user: { select: ["id"] },
        delivery_address: { select: ["id"] },
      },
      limit: 2,
      transacting: trx,
    } as any);
    if (existingOrders.length > 1) throw new MigrationInputError("ORDER_SOURCE_ID_AMBIGUOUS", 409);
    const existing = existingOrders[0] || null;

    let identity: { user: any; matchReason: string | null; issues: string[] } = {
      user: null,
      matchReason: null,
      issues: [],
    };
    try {
      identity = await resolveOrderUser(strapiInstance, body, trx);
    } catch (error) {
      if (!isIdentitySoftFail(error)) throw error;
      identity = {
        user: null,
        matchReason: "unresolved",
        issues: [error.code],
      };
    }
    const resolvedUser = identity.user || null;
    const existingUser = existing?.user || null;
    const identityConflict = Boolean(
      existingUser && resolvedUser && Number(existingUser.id) !== Number(resolvedUser.id),
    );
    if (identityConflict) {
      identity.issues = [...(identity.issues || []), "ORDER_USER_IDENTITY_CONFLICT"];
    }
    // Keep an existing owner on conflict; otherwise use resolved or existing.
    const linkedUser = identityConflict ? existingUser : (resolvedUser || existingUser);

    const address = await resolveWooDeliveryAddress(
      strapiInstance,
      sourceId,
      body?.deliveryAddress,
      existing?.delivery_address,
      linkedUser,
      trx,
    );
    const orderData = {
      Date: date,
      Status: status,
      ReservationStatus: "Released",
      Type: "Automatic",
      ShippingCost: shippingToman,
      ShippingMethodCode: optionalText(body?.shippingMethodCode, 255) || null,
      ShippingMethodTitle: optionalText(body?.shippingMethodTitle, 255) || null,
      PaymentGateway: paymentGateway,
      user: linkedUser?.id || null,
      Description: null,
      Note: null,
      external_source: "woocommerce",
      external_id: sourceId,
      ...(address.id ? { delivery_address: address.id } : {}),
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
      local_user: linkedUser?.id || null,
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
    let itemsUnresolved = 0;
    let itemsOrphaned = 0;
    const itemIssues: string[] = [];
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
      // An orphan line is a historical sale whose WooCommerce product was
      // deleted or archived after purchase. The importer marks it explicitly;
      // it is stored as a snapshot with no catalog relation and never matched
      // by guesswork. Only the explicit marker takes this path — a nonzero but
      // unknown reference still goes through the lookup below.
      const isOrphan = sourceItem?.catalogReference === "orphan";
      let variationId: number | null = null;
      let skuFallback: string;
      if (isOrphan) {
        if (sourceItem?.variationSourceId !== null && sourceItem?.variationSourceId !== undefined) {
          throw new MigrationInputError("ORDER_ITEM_ORPHAN_HAS_CATALOG_REFERENCE");
        }
        itemsOrphaned += 1;
        itemIssues.push(`ORDER_ITEM_CATALOG_REFERENCE_MISSING:${sourceItemId}`);
        skuFallback = `WC-LINE-${sourceItemId}`;
      } else {
        const variationSourceId = requiredId(sourceItem?.variationSourceId, "ORDER_ITEM_VARIATION_ID_INVALID");
        const variationMatches = await findMany(
          strapiInstance.db.query(VARIATION_UID),
          { external_source: "woocommerce", external_id: variationSourceId },
          trx,
        );
        if (variationMatches.length === 1) {
          variationId = Number(variationMatches[0].id);
        } else {
          itemsUnresolved += 1;
          itemIssues.push(`ORDER_ITEM_VARIATION_UNRESOLVED:${variationSourceId}`);
        }
        skuFallback = `WC-${variationSourceId}`;
      }
      const itemData = {
        Count: positiveCount(sourceItem?.count),
        PerAmount: exactNonNegativeInteger(sourceItem?.unitPriceToman, "ORDER_ITEM_PRICE_INVALID"),
        ProductTitle: optionalText(sourceItem?.title, 255) || "WooCommerce product",
        ProductSKU: optionalText(sourceItem?.sku, 255) || skuFallback,
        product_variation: variationId,
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
      itemsUnresolved,
      itemsOrphaned,
      userLinked: Boolean(linkedUser),
      identityMatchReason: identity.matchReason,
      identityIssues: identity.issues || [],
      itemIssues,
      addressLinked: Boolean(address.id),
      addressMode: address.mode,
      addressReason: address.reason,
    };
  });
}
