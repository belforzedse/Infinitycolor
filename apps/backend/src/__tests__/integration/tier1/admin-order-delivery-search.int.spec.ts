import latinCase from "../../../../database/order-search-latin-case.json";
import controller from "../../../api/admin-order-list/controllers/admin-order-list";
import {
  normalizeOrderAddress,
  normalizeOrderSku,
} from "../../../api/admin-order-list/lib/delivery-search";
import {
  captureOrderDeliverySnapshot,
  effectiveOrderDeliveryAddress,
  ensureOrderSearchStorage,
} from "../../../utils/orderDeliverySnapshot";
import { makeFactories, type Factories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
let strapi: any;
let f: Factories;
let orderIds: number[];
beforeAll(async () => {
  strapi = await setupStrapi();
});
afterAll(async () => {
  await teardownStrapi();
});
beforeEach(() => {
  f = makeFactories(strapi);
  orderIds = [];
});
afterEach(async () => {
  if (orderIds.length)
    await strapi.db.connection("order_delivery_snapshots").whereIn("order_id", orderIds).delete();
  await f.cleanup();
});
const ctx = (body: Record<string, unknown>) => ({
  request: { body },
  state: { auth: {}, user: { id: 1 } },
  body: null as any,
  badRequest: jest.fn((message: string) => {
    throw new Error(message);
  }),
  set: jest.fn(),
});
async function seed(snapshot = true, overrides: Record<string, unknown> = {}) {
  const user = await f.createUser();
  const city = await f.createShippingCity({ title: "تهران" });
  const address = await f.createAddress({
    userId: user.id,
    cityId: city.id,
    postalCode: "0123456789",
    fullName: "گیرنده آزمایشی",
  });
  await strapi.db.query("api::local-user-address.local-user-address").update({
    where: { id: address.id },
    data: {
      FullAddress: "خيابان كاشاني\u200c پلاک ۱۲ ABC",
      ...overrides,
    },
  });
  const order = await f.createOrder({
    userId: user.id,
    deliveryAddressId: address.id,
    status: "Started",
  });
  orderIds.push(order.id);
  if (snapshot)
    await strapi.db.transaction(async ({ trx }: any) =>
      captureOrderDeliverySnapshot(strapi, order.id, address.id, trx),
    );
  const product = await f.createProduct();
  const variation = await f.createVariation({ productId: product.id });
  for (let i = 0; i < 2; i++) {
    const line = await f.createOrderItem({ orderId: order.id, variationId: variation.id });
    await strapi.db
      .query("api::order-item.order-item")
      .update({ where: { id: line.id }, data: { ProductSKU: "Ab-۰۰۱  ٢" } });
  }
  return { order, address, city, product, variation };
}
describe("order delivery filters on real PostgreSQL", () => {
  it("combines city, historical SKU, exact postal and normalized partial address with correct row/count pagination", async () => {
    const one = await seed();
    const two = await seed();
    await seed(true, { PostalCode: "9999999999" });
    const body = {
      tab: "all",
      page: 1,
      pageSize: 1,
      cityId: one.city.id,
      productCode: " Ab-001  ۲ ",
      postalCode: "۰۱۲۳۴-۵۶۷۸۹",
      addressText: "خیابان کاشانی پلاک 12 abc",
    };
    const first = ctx(body);
    await controller.query(first);
    expect(first.body.data.map((row: any) => row.id)).toEqual([one.order.id]);
    expect(first.body.meta.pagination.total).toBe(1);
    const both = ctx({ ...body, cityId: undefined });
    await controller.query(both);
    expect(both.body.data).toHaveLength(1);
    expect(both.body.meta.pagination).toMatchObject({ total: 2, pageCount: 2 });
    const next = ctx({ ...body, cityId: undefined, page: 2 });
    await controller.query(next);
    expect(new Set([both.body.data[0].id, next.body.data[0].id])).toEqual(
      new Set([one.order.id, two.order.id]),
    );
    const count = ctx({ ...body, cityId: undefined });
    await controller.counts(count);
    expect(count.body.data.counts.all).toBe(2);
    expect(count.body.data.counts.inprogress).toBe(2);
  });
  it("keeps new order facts after profile/identifier edits and preserves linked legacy address behavior", async () => {
    const saved = await seed();
    const legacy = await seed(false);
    for (const row of [saved, legacy]) {
      await strapi.db.query("api::local-user-address.local-user-address").update({
        where: { id: row.address.id },
        data: { FullAddress: "نشانی جدید", PostalCode: "1111111111" },
      });
      await strapi.db
        .query("api::product-variation.product-variation")
        .update({ where: { id: row.variation.id }, data: { SKU: "Changed" } });
    }
    const original = ctx({ postalCode: "0123456789", productCode: "Ab-001  2" });
    await controller.query(original);
    expect(original.body.data.map((row: any) => row.id)).toEqual([saved.order.id]);
    const changed = ctx({ postalCode: "1111111111" });
    await controller.query(changed);
    expect(changed.body.data.map((row: any) => row.id)).toEqual([legacy.order.id]);
    const detail = await effectiveOrderDeliveryAddress(strapi, saved.order.id, {
      FullAddress: "نشانی جدید",
    });
    expect(detail.FullAddress).toBe("خيابان كاشاني\u200c پلاک ۱۲ ABC");
    const wrongCase = ctx({ productCode: "ab-001  2" });
    await controller.query(wrongCase);
    expect(wrongCase.body.data).toEqual([]);
  });
  it("treats wildcard characters literally and rejects malformed inputs before querying", async () => {
    const row = await seed(true, { FullAddress: "آدرس 50%_ واقعی" });
    const match = ctx({ addressText: "50%_" });
    await controller.query(match);
    expect(match.body.data.map((entry: any) => entry.id)).toEqual([row.order.id]);
    const missing = ctx({ addressText: "51%_" });
    await controller.query(missing);
    expect(missing.body.data).toEqual([]);
    await expect(controller.query(ctx({ postalCode: "123" }))).rejects.toThrow(
      "کد پستی باید ۱۰ رقم باشد",
    );
    await expect(controller.query(ctx({ cityId: "1 OR 1=1" }))).rejects.toThrow(
      "شهر انتخاب‌شده معتبر نیست",
    );
  });
  it("rolls snapshot capture back with its creation transaction and registers the table for schema retention", async () => {
    const row = await seed(false);
    await expect(
      strapi.db.transaction(async ({ trx }: any) => {
        await captureOrderDeliverySnapshot(strapi, row.order.id, row.address.id, trx);
        throw new Error("rollback fixture");
      }),
    ).rejects.toThrow("rollback fixture");
    expect(
      await strapi.db
        .connection("order_delivery_snapshots")
        .where({ order_id: row.order.id })
        .first(),
    ).toBeUndefined();
    const store = await strapi.db
      .connection("strapi_core_store_settings")
      .where({ key: "core_persisted_tables" })
      .first();
    const persisted = typeof store.value === "string" ? JSON.parse(store.value) : store.value;
    expect(
      persisted.map((entry: any) => (typeof entry === "string" ? entry : entry.name)),
    ).toContain("order_delivery_snapshots");
    await ensureOrderSearchStorage(strapi);
    const indexes = await strapi.db
      .connection("pg_indexes")
      .whereIn("indexname", [
        "idx_order_snapshot_address",
        "idx_order_item_snapshot_sku",
        "idx_order_legacy_postal",
      ]);
    expect(indexes).toHaveLength(3);
  });
  it("SQL and request normalization agree on Persian and compatibility inputs", async () => {
    const text = "  خيابان\u200cكاشاني  ＡＢＣ ۱۲ ";
    const sku = "  A\u0301-۰۰۱  ٢ ";
    const result = await strapi.db.connection.raw(
      "SELECT infinity_order_address(?) AS address, infinity_order_sku(?) AS sku",
      [text, sku],
    );
    expect(result.rows[0]).toEqual({
      address: normalizeOrderAddress(text),
      sku: normalizeOrderSku(sku),
    });
    const latin = await strapi.db.connection.raw("SELECT infinity_order_address(?) AS address", [
      "CAFÉ Étage",
    ]);
    expect(latin.rows[0].address).toBe(normalizeOrderAddress("CAFÉ Étage"));
    expect(latin.rows[0].address).toBe("café étage");
    const extended = await strapi.db.connection.raw(
      "SELECT infinity_order_address(?) AS address, infinity_order_sku(?) AS sku",
      ["Ā Œ İ", "Ā Œ İ CAFÉ"],
    );
    expect(extended.rows[0]).toEqual({
      address: normalizeOrderAddress("Ā Œ İ"),
      sku: "Ā Œ İ CAFÉ",
    });
    expect(extended.rows[0].address).toBe("ā œ i\u0307");
    const allLatin = latinCase.upper + latinCase.multiple.map(([upper]) => upper).join("");
    const all = await strapi.db.connection.raw("SELECT infinity_order_address(?) AS address", [
      allLatin,
    ]);
    expect(all.rows[0].address).toBe(normalizeOrderAddress(allLatin));
  });
  it("evaluates and rebuilds populated expression indexes with PostgreSQL 17's restricted search path", async () => {
    await seed();
    const functions = () => strapi.db.connection.raw(
      "SELECT p.oid, p.proname, p.proowner, p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY(?::text[]) ORDER BY p.proname",
      [["infinity_order_digits", "infinity_order_postal", "infinity_order_sku", "infinity_order_address"]],
    );
    const beforeFunctions = (await functions()).rows;
    const beforeRows = await strapi.db.connection("order_delivery_snapshots").orderBy("order_id");
    await ensureOrderSearchStorage(strapi);
    expect((await functions()).rows).toEqual(beforeFunctions);
    expect(beforeFunctions).toHaveLength(4);
    expect(await strapi.db.connection("order_delivery_snapshots").orderBy("order_id")).toEqual(beforeRows);
    await strapi.db.connection.transaction(async (trx: any) => {
      await trx.raw("SET LOCAL search_path TO pg_catalog, pg_temp");
      const normalized = await trx.raw(
        "SELECT public.infinity_order_postal(?::text) AS postal, public.infinity_order_sku(?::text) AS sku, public.infinity_order_address(?::text) AS address",
        ["۰۱۲۳۴-۵۶۷۸۹", " Ab-۰۰۱  ٢ ", "خيابان كاشاني ۱۲ ABC"],
      );
      expect(normalized.rows[0]).toEqual({
        postal: "0123456789",
        sku: normalizeOrderSku(" Ab-۰۰۱  ٢ "),
        address: normalizeOrderAddress("خيابان كاشاني ۱۲ ABC"),
      });
      for (const index of [
        "idx_order_snapshot_postal",
        "idx_order_snapshot_address",
        "idx_order_legacy_postal",
        "idx_order_legacy_address",
        "idx_order_item_snapshot_sku",
      ]) {
        await trx.raw("REINDEX INDEX ??", [`public.${index}`]);
      }
    });
    const result = await strapi.db.connection.raw(
      "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ANY(?::text[])",
      [["idx_order_snapshot_postal", "idx_order_snapshot_address", "idx_order_legacy_postal", "idx_order_legacy_address", "idx_order_item_snapshot_sku"]],
    );
    expect(result.rows).toHaveLength(5);
    expect(result.rows.every((row: any) => row.indisvalid)).toBe(true);
  });
});
