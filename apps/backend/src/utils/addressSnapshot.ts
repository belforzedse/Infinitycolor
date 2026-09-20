import type { Strapi } from "@strapi/strapi";

export const ADDRESS_UID = "api::local-user-address.local-user-address";
const ORDER_UID = "api::order.order";
const RESERVE_GROUP_UID = "api::reserve-group.reserve-group";

export type AddressReferences = {
  orderIds: number[];
  reserveGroupIds: number[];
  total: number;
};

const relationId = (value: unknown): number | null => {
  const raw = value && typeof value === "object" ? (value as any).id : value;
  const numeric = Number(raw);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
};

const transacting = (trx?: unknown) => (trx ? { transacting: trx } : {});

/**
 * Rows whose destination is this address. `delivery_address` is a plain relation
 * with no inverse side on the address, so its link rows vanish with the address:
 * a hard delete blanks the destination on every order below, and an in-place edit
 * silently rewrites history for all of them. Only these two content types target
 * the address (verified across every schema.json).
 */
export async function findAddressReferences(
  strapi: Strapi,
  addressId: number,
  trx?: unknown,
): Promise<AddressReferences> {
  const where = { delivery_address: { id: addressId } };
  const [orders, reserveGroups] = await Promise.all([
    strapi.db.query(ORDER_UID).findMany({ where, select: ["id"], ...transacting(trx) } as any),
    strapi.db
      .query(RESERVE_GROUP_UID)
      .findMany({ where, select: ["id"], ...transacting(trx) } as any),
  ]);
  const orderIds = (orders || []).map((row: any) => Number(row.id));
  const reserveGroupIds = (reserveGroups || []).map((row: any) => Number(row.id));
  return { orderIds, reserveGroupIds, total: orderIds.length + reserveGroupIds.length };
}

/**
 * Detached copy of an address. `IsTemporary` is what keeps it out of
 * `GET /local-user-addresses/me`, so the shopper's address book can never reach
 * it to edit or delete it again -- the same device `adminUpdateAddress` uses when
 * an operator corrects an order's destination.
 */
export async function createAddressSnapshot(
  strapi: Strapi,
  address: any,
  trx?: unknown,
): Promise<any> {
  return strapi.db.query(ADDRESS_UID).create({
    data: {
      shipping_city: relationId(address?.shipping_city) ?? undefined,
      PostalCode: address?.PostalCode,
      Description: address?.Description ?? null,
      FullAddress: address?.FullAddress ?? null,
      // Copied as-is: rows created through `createAddress` carry neither, and
      // readers already fall back to the account's own name/phone at render time.
      FullName: address?.FullName ?? null,
      Phone: address?.Phone ?? null,
      IsTemporary: true,
      user: relationId(address?.user) ?? undefined,
    },
    ...transacting(trx),
  } as any);
}

/**
 * Move every referencing row onto the snapshot. The snapshot carries the values
 * those rows already had, so this is value-preserving: no carrier registration
 * becomes stale and no Anipo recipient revision needs bumping. Destination
 * *changes* stay the exclusive job of `adminUpdateAddress`, which does sync.
 */
export async function repointAddressReferences(
  strapi: Strapi,
  references: AddressReferences,
  snapshotId: number,
  trx?: unknown,
): Promise<void> {
  for (const id of references.orderIds) {
    await strapi.db.query(ORDER_UID).update({
      where: { id },
      data: { delivery_address: snapshotId },
      ...transacting(trx),
    } as any);
  }
  for (const id of references.reserveGroupIds) {
    await strapi.db.query(RESERVE_GROUP_UID).update({
      where: { id },
      data: { delivery_address: snapshotId },
      ...transacting(trx),
    } as any);
  }
}
