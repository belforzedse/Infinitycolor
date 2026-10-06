import { randomUUID } from "node:crypto";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";
import { submitAnipoBarcode } from "../../../api/order/services/anipoBarcodeWorkflow";
import {
  submitReserveParcel,
  refreshReserveParcel,
  reconcileReserveParcelCancellation,
  loadParcelSummaries,
} from "../../../api/order/services/anipoReserveParcel";

let strapi: any;
let factories: Factories;
let groups: number[] = [];
let serviceSpy: jest.SpyInstance;
const provider = {
  createOrUpdateOrder: jest.fn(),
  getOrder: jest.fn(),
  updateOrderStatus: jest.fn(),
};

beforeAll(async () => {
  strapi = await setupStrapi();
  factories = makeFactories(strapi);
  const original = strapi.service.bind(strapi);
  serviceSpy = jest
    .spyOn(strapi, "service")
    .mockImplementation((uid: any) => (uid === "api::shipping.anipo" ? provider : original(uid)));
});
beforeEach(() => {
  jest.clearAllMocks();
  provider.createOrUpdateOrder.mockResolvedValue({ ok: true, data: { issued: false } });
  provider.getOrder.mockResolvedValue({
    ok: true,
    data: { issued: true, barcode: "123456789012345678901234" },
  });
  provider.updateOrderStatus.mockResolvedValue({ ok: true });
});
afterEach(async () => {
  for (const id of groups)
    await strapi.db.query("api::reserve-group.reserve-group").delete({ where: { id } });
  groups = [];
  await factories.cleanup();
});
afterAll(async () => {
  serviceSpy?.mockRestore();
  await teardownStrapi();
});

async function parcel() {
  const user = await factories.createUser({ phone: "09123456789" });
  const address = await factories.createAddress({
    userId: user.id,
    fullName: "JEST_TEST__parcel recipient",
    phone: "09123456789",
    postalCode: "1234567890",
  });
  const group = await strapi.db.query("api::reserve-group.reserve-group").create({
    data: {
      groupKey: `JEST_TEST__${randomUUID()}`,
      State: "ReadyToFulfill",
      ShippingMethodCode: "post",
      ShippingCostPaid: 50,
      owner: user.id,
      delivery_address: address.id,
    },
  });
  groups.push(group.id);
  const rows = [];
  for (const [amount, count, weight] of [
    [250, 2, 125],
    [300, 3, 100],
  ]) {
    const contract = await factories.createContract({ amount });
    const order = await factories.createOrder({
      status: "Started",
      userId: user.id,
      contractId: contract.id,
      deliveryAddressId: address.id,
    });
    const product = await factories.createProduct();
    await strapi.db
      .query("api::product.product")
      .update({ where: { id: product.id }, data: { Weight: weight } });
    const variation = await factories.createVariation({ productId: product.id });
    await factories.createOrderItem({ orderId: order.id, variationId: variation.id, count });
    await strapi.db.query("api::order.order").update({
      where: { id: order.id },
      data: {
        reserve_shipment: group.id,
        ShippingMethodCode: "post",
        ShippingCost: rows.length ? 0 : 50,
      },
    });
    rows.push(order);
  }
  await strapi.db
    .query("api::reserve-group.reserve-group")
    .update({ where: { id: group.id }, data: { rootOrder: rows[0].id } });
  return { group, rows };
}

it("uses real PostgreSQL claims to register one complete parcel under concurrent requests", async () => {
  const f = await parcel();
  let release!: (value: unknown) => void;
  provider.createOrUpdateOrder.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = submitAnipoBarcode(strapi, f.rows[0].id);
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const probe = () =>
      release
        ? resolve()
        : Date.now() - started > 10_000
          ? reject(new Error("Provider call never started"))
          : setTimeout(probe, 10);
    probe();
  });
  await expect(submitAnipoBarcode(strapi, f.rows[1].id)).rejects.toMatchObject({
    code: "ANIPO_PARCEL_BUSY",
  });
  release({ ok: true, data: { issued: false } });
  await first;
  expect(provider.createOrUpdateOrder).toHaveBeenCalledTimes(1);
  expect(provider.createOrUpdateOrder).toHaveBeenCalledWith(
    expect.objectContaining({
      order_code: String(f.rows[0].id),
      weight_g: 550,
      order_total: 5500,
      package_count: 1,
    }),
  );
  const saved = await strapi.db
    .query("api::reserve-group.reserve-group")
    .findOne({ where: { id: f.group.id } });
  expect(saved.AnipoOrderCode).toBe(String(f.rows[0].id));
  expect(saved.AnipoLeaseToken).toBeNull();
  const summary = (await loadParcelSummaries(strapi, [f.group.id])).get(f.group.id);
  expect(summary).toMatchObject({
    orderCount: 2,
    eligibleOrderCount: 2,
    state: "Pending",
    weight: 550,
  });
});

it("retains the shared reference after root cancellation and stamps only eligible members", async () => {
  const f = await parcel();
  await submitReserveParcel(strapi, f.group.id);
  await strapi.db
    .query("api::order.order")
    .update({ where: { id: f.rows[0].id }, data: { Status: "Cancelled", ShippingBarcode: null } });
  await reconcileReserveParcelCancellation(strapi, f.group.id);
  expect(provider.updateOrderStatus).not.toHaveBeenCalled();
  await refreshReserveParcel(strapi, f.group.id);
  expect(provider.getOrder).toHaveBeenCalledWith(String(f.rows[0].id));
  const [cancelled, eligible] = await Promise.all(
    f.rows.map((order) => strapi.db.query("api::order.order").findOne({ where: { id: order.id } })),
  );
  expect(cancelled.ShippingBarcode).toBeNull();
  expect(eligible.ShippingBarcode).toBe("123456789012345678901234");
});

it("rejects a stale lease holder and allows recovery after an expired claim", async () => {
  const f = await parcel();
  await strapi.db
    .connection("reserve_groups")
    .where({ id: f.group.id })
    .update({
      anipo_lease_token: "expired-owner",
      anipo_lease_expires_at: new Date(Date.now() - 60_000),
    });
  await submitReserveParcel(strapi, f.group.id);
  const stale = await strapi.db
    .connection("reserve_groups")
    .where({ id: f.group.id, anipo_lease_token: "expired-owner" })
    .update({ anipo_order_code: "999" })
    .returning("id");
  expect(stale).toEqual([]);
  const saved = await strapi.db
    .query("api::reserve-group.reserve-group")
    .findOne({ where: { id: f.group.id } });
  expect(saved.AnipoOrderCode).toBe(String(f.rows[0].id));
});
