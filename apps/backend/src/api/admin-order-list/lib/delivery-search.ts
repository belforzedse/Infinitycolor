import latinCase from "../../../../database/order-search-latin-case.json";
import { escapeAdminLike, rejectAdminListRequest } from "../../../utils/admin-list-query";

export type DeliverySearch = {
  cityId?: number;
  productCode?: string;
  postalCode?: string;
  addressText?: string;
};
export const normalizeOrderDigits = (value: string) =>
  value.replace(/[۰-۹٠-٩]/g, (d) => String(d.charCodeAt(0) - (d >= "۰" ? 0x06f0 : 0x0660)));
export const normalizeOrderSku = (value: string) =>
  normalizeOrderDigits(value.normalize("NFC")).trim();
const latinLower = Array.from(latinCase.lower);
const latinFoldMap: Record<string, string> = Object.fromEntries([
  ...Array.from(latinCase.upper, (upper, index) => [upper, latinLower[index]]),
  ...latinCase.multiple,
]);
function foldLatinCase(value: string) {
  return Array.from(value, (letter) => latinFoldMap[letter] ?? letter).join("");
}

export const normalizeOrderAddress = (value: string) =>
  foldLatinCase(normalizeOrderDigits(value.normalize("NFKC")))
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\s\u200c]+/g, " ")
    .trim();
export const normalizeOrderPostal = (value: string) =>
  normalizeOrderDigits(value).replace(/[\s-]+/g, "");

export function parseDeliverySearch(
  ctx: any,
  body: Record<string, unknown>,
): DeliverySearch | null {
  const result: DeliverySearch = {};
  const invalid = {
    productCode: "کد محصول باید بین ۱ تا ۲۵۵ نویسه باشد",
    postalCode: "کد پستی باید ۱۰ رقم باشد",
    addressText: "برای جستجوی آدرس ۳ تا ۲۰۰ نویسه وارد کنید",
  };
  for (const key of ["productCode", "postalCode", "addressText"] as const) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string") {
      rejectAdminListRequest(ctx, invalid[key]);
      return null;
    }
    if (!raw.trim()) continue;
    if (raw.length > 1000) {
      rejectAdminListRequest(ctx, invalid[key]);
      return null;
    }
    const value =
      key === "productCode"
        ? normalizeOrderSku(raw)
        : key === "postalCode"
          ? normalizeOrderPostal(raw)
          : normalizeOrderAddress(raw);
    const valid =
      key === "postalCode"
        ? /^\d{10}$/.test(value)
        : key === "productCode"
          ? value.length >= 1 && value.length <= 255
          : value.length >= 3 && value.length <= 200;
    if (!valid) {
      rejectAdminListRequest(ctx, invalid[key]);
      return null;
    }
    result[key] = value;
  }
  if (body.cityId !== undefined && body.cityId !== null && body.cityId !== "") {
    const raw = body.cityId;
    const text =
      typeof raw === "number"
        ? String(raw)
        : typeof raw === "string"
          ? normalizeOrderDigits(raw).trim()
          : "";
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
      rejectAdminListRequest(ctx, "شهر انتخاب‌شده معتبر نیست");
      return null;
    }
    result.cityId = value;
  }
  return result;
}

export function deliverySearchCondition(
  knex: any,
  input: DeliverySearch,
): Record<string, unknown> | null {
  if (!Object.keys(input).length) return null;
  const ids = knex("orders as os").select("os.id");
  if (input.productCode) {
    ids.whereExists(
      knex("order_items_order_links as oil")
        .select(knex.raw("1"))
        .join("order_items as oi", "oi.id", "oil.order_item_id")
        .whereRaw("oil.order_id = os.id")
        .whereRaw("infinity_order_sku(oi.product_sku) = ?", [input.productCode]),
    );
  }
  if (input.cityId || input.postalCode || input.addressText) {
    const snapshot = knex("order_delivery_snapshots as ds")
      .select(knex.raw("1"))
      .whereRaw("ds.order_id = os.id");
    const legacy = knex("orders_delivery_address_links as dal")
      .select(knex.raw("1"))
      .join("local_user_addresses as a", "a.id", "dal.local_user_address_id")
      .whereRaw("dal.order_id = os.id");
    if (input.cityId) {
      snapshot.where("ds.city_id", input.cityId);
      legacy.whereExists(
        knex("local_user_addresses_shipping_city_links as acl")
          .select(knex.raw("1"))
          .whereRaw("acl.local_user_address_id = a.id")
          .where("acl.shipping_city_id", input.cityId),
      );
    }
    if (input.postalCode) {
      snapshot.whereRaw("infinity_order_postal(ds.postal_code) = ?", [input.postalCode]);
      legacy.whereRaw("infinity_order_postal(a.postal_code) = ?", [input.postalCode]);
    }
    if (input.addressText) {
      const pattern = `%${escapeAdminLike(input.addressText)}%`;
      snapshot.whereRaw("infinity_order_address(ds.full_address) LIKE ?", [pattern]);
      legacy.whereRaw("infinity_order_address(a.full_address) LIKE ?", [pattern]);
    }
    ids.where(function (this: any) {
      this.whereExists(snapshot).orWhere(function (this: any) {
        this.whereNotExists(
          knex("order_delivery_snapshots as present")
            .select(knex.raw("1"))
            .whereRaw("present.order_id = os.id"),
        ).whereExists(legacy);
      });
    });
  }
  return { id: { $in: ids } };
}
