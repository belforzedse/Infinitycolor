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

// Match pasted codes without changing the immutable order-item snapshot or its
// case-sensitive SKU normalization. Keep SQL and JavaScript whitespace aligned.
const CODE_SPACES = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u200c";

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
    const code = normalizeOrderSku(input.productCode).replace(/[\s\u200c]+/g, "");
    const title = normalizeOrderAddress(input.productCode);
    const matchIdentity = (query: any, skuColumn: string, titleColumn: string) => {
      query.whereRaw("infinity_order_sku(??) = ?", [skuColumn, input.productCode]);
      if (code) {
        query.orWhereRaw("translate(infinity_order_sku(??), ?, '') = ?", [skuColumn, CODE_SPACES, code]);
      }
      if (title) {
        query.orWhereRaw("infinity_order_address(??) LIKE ?", [titleColumn, `%${escapeAdminLike(title)}%`]);
      }
    };
    ids.whereExists(
      knex("order_items_order_links as oil")
        .select(knex.raw("1"))
        .join("order_items as oi", "oi.id", "oil.order_item_id")
        .whereRaw("oil.order_id = os.id")
        .andWhere(function (this: any) {
          matchIdentity(this, "oi.product_sku", "oi.product_title");
          // Historical names/codes survive catalog edits and deleted links;
          // linked items are also discoverable under their current identity.
          this.orWhereExists(
            knex("order_items_product_variation_links as ivl")
              .select(knex.raw("1"))
              .join("product_variations as pv", "pv.id", "ivl.product_variation_id")
              .leftJoin("product_variations_product_links as vpl", "vpl.product_variation_id", "pv.id")
              .leftJoin("products as p", "p.id", "vpl.product_id")
              .whereRaw("ivl.order_item_id = oi.id")
              .andWhere(function (this: any) {
                matchIdentity(this, "pv.sku", "p.title");
              }),
          );
        }),
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
