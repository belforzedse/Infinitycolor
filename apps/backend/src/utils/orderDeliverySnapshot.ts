import type { Strapi } from "@strapi/strapi";
import { resolveRawExecutor } from "./transactionExecutor";
import path from "path";

const TABLE = "order_delivery_snapshots";

export async function ensureOrderSearchStorage(strapi: Strapi) {
  // JavaScript migrations/helpers remain in appDir; Strapi compiles only TS
  // into distDir. Resolve from the source app root in both runtime modes.
  const { ensureStorage } = require(
    path.join(strapi.dirs.app.root, "database", "order-search-storage.js"),
  );
  await ensureStorage(strapi.db.connection);
}

function rowForAddress(address: any) {
  const city = address?.shipping_city;
  const province = city?.shipping_province;
  return {
    address_id: Number(address?.id) || null,
    city_id: Number(city?.id) || null,
    city_title: city?.Title ?? null,
    province_id: Number(province?.id) || null,
    province_title: province?.Title ?? null,
    full_address: address?.FullAddress ?? null,
    description: address?.Description ?? null,
    postal_code: address?.PostalCode ?? null,
    recipient_name: address?.FullName ?? null,
    recipient_phone: address?.Phone ?? null,
  };
}

export async function captureOrderDeliverySnapshot(
  strapi: Strapi,
  orderId: number,
  addressId?: number,
  trx?: any,
  source: "checkout" | "manual" | "woocommerce" = "checkout",
) {
  const db = await resolveRawExecutor(strapi, trx);
  let address: any = null;
  if (addressId) {
    // Serialize the read with saved-address changes; raw SQL shares the creation
    // transaction rather than silently escaping to a pooled connection.
    await db("local_user_addresses").where({ id: addressId }).select("id").forShare();
    address = await strapi.db.query("api::local-user-address.local-user-address").findOne({
      where: { id: addressId },
      populate: { shipping_city: { populate: { shipping_province: true } } },
      ...(trx ? { transacting: trx } : {}),
    } as any);
  }
  await db(TABLE)
    .insert({ order_id: orderId, capture_source: source, ...rowForAddress(address) })
    .onConflict("order_id")
    .ignore();
}

export async function updateExistingOrderDeliverySnapshot(
  strapi: Strapi,
  orderId: number,
  address: any,
  trx?: any,
) {
  const db = await resolveRawExecutor(strapi, trx);
  // Never backfill legacy orders during a recipient correction.
  await db(TABLE)
    .where({ order_id: orderId })
    .update({ ...rowForAddress(address), updated_at: db.fn.now() });
}

export async function effectiveOrderDeliveryAddress(
  strapi: Strapi,
  orderId: number,
  legacy: any,
  trx?: any,
) {
  const db = await resolveRawExecutor(strapi, trx);
  const row = await db(TABLE).where({ order_id: orderId }).first();
  if (!row) return legacy ?? null;
  return snapshotAddress(row);
}

function snapshotAddress(row: any) {
  return {
    id: row.address_id,
    FullAddress: row.full_address,
    Description: row.description,
    PostalCode: row.postal_code,
    FullName: row.recipient_name,
    Phone: row.recipient_phone,
    shipping_city: row.city_id
      ? {
          id: row.city_id,
          Title: row.city_title,
          shipping_province: row.province_id
            ? { id: row.province_id, Title: row.province_title }
            : null,
        }
      : null,
  };
}

/** Existing list recipient field only; no address text is added to list responses. */
export async function loadOrderSnapshotRecipientNames(
  strapi: Strapi,
  orderIds: number[],
  trx?: any,
) {
  const ids = [...new Set(orderIds)].filter((id) => Number.isSafeInteger(id) && id > 0);
  const names = new Map<number, string | null>();
  if (!ids.length) return names;
  const db = await resolveRawExecutor(strapi, trx);
  const rows = await db(TABLE).whereIn("order_id", ids).select("order_id", "recipient_name");
  for (const row of rows)
    names.set(Number(row.order_id), String(row.recipient_name || "").trim() || null);
  return names;
}

/** Batch internal projection for reserve parcels; absent snapshots retain legacy addresses. */
export async function effectiveOrderDeliveryAddresses(
  strapi: Strapi,
  sources: Array<{ id: number; delivery_address: any }>,
  trx?: any,
) {
  const addresses = new Map<number, any>(
    sources.map((source) => [source.id, source.delivery_address ?? null]),
  );
  if (!addresses.size) return addresses;
  const db = await resolveRawExecutor(strapi, trx);
  const rows = await db(TABLE).whereIn("order_id", [...addresses.keys()]);
  for (const row of rows) addresses.set(Number(row.order_id), snapshotAddress(row));
  return addresses;
}
