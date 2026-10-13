import { BOOT_LOCK_KEY } from "../../bootstrap/bootLock";
import {
  captureOrderDeliverySnapshot,
  loadOrderSnapshotRecipientNames,
  effectiveOrderDeliveryAddresses,
  effectiveOrderDeliveryAddress,
  updateExistingOrderDeliverySnapshot,
} from "../orderDeliverySnapshot";

function fixtures(row: any = undefined) {
  const chain: any = {
    where: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    forShare: jest.fn().mockResolvedValue([]),
    first: jest.fn().mockResolvedValue(row),
    insert: jest.fn().mockReturnThis(),
    onConflict: jest.fn().mockReturnThis(),
    ignore: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(row ? 1 : 0),
  };
  const trx: any = jest.fn(() => chain);
  trx.raw = jest.fn();
  trx.fn = { now: () => "database-now" };
  const address = {
    id: 9,
    FullAddress: "خیابان اصلی",
    PostalCode: "0123456789",
    FullName: "گیرنده",
    Phone: "09120000000",
    shipping_city: { id: 3, Title: "تهران", shipping_province: { id: 2, Title: "تهران" } },
  };
  const strapi: any = {
    db: {
      connection: jest.fn(() => {
        throw new Error("transaction escaped");
      }),
      query: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(address) })),
    },
  };
  return { chain, trx, address, strapi };
}
describe("order delivery snapshot boundaries", () => {
  it("does not reacquire the boot session lock on a separate migration connection", () => {
    const { LOCK_KEY } = require("../../../database/order-search-storage");
    expect(LOCK_KEY).not.toBe(BOOT_LOCK_KEY);
  });
  it("projects only existing recipient names from one bounded batch, including empty snapshots", async () => {
    const chain: any = {
      whereIn: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue([
        { order_id: 10, recipient_name: " گیرنده سفارش " },
        { order_id: 11, recipient_name: null },
      ]),
    };
    const connection = jest.fn(() => chain);
    const names = await loadOrderSnapshotRecipientNames(
      { db: { connection } } as any,
      [10, 11, 10],
    );
    expect(connection).toHaveBeenCalledTimes(1);
    expect(chain.whereIn).toHaveBeenCalledWith("order_id", [10, 11]);
    expect(chain.select).toHaveBeenCalledWith("order_id", "recipient_name");
    expect([...names]).toEqual([
      [10, "گیرنده سفارش"],
      [11, null],
    ]);
  });

  it("resolves reserve roots in one batch while preserving legacy and hiding metadata", async () => {
    const connection = jest.fn(() => ({
      whereIn: jest
        .fn()
        .mockResolvedValue([
          {
            order_id: 10,
            full_address: "نشانی سفارش",
            recipient_name: "گیرنده",
            capture_source: "checkout",
          },
        ]),
    }));
    const legacy = { FullAddress: "نشانی قدیمی" };
    const addresses = await effectiveOrderDeliveryAddresses({ db: { connection } } as any, [
      { id: 10, delivery_address: { FullAddress: "پروفایل جدید" } },
      { id: 11, delivery_address: legacy },
    ]);
    expect(connection).toHaveBeenCalledTimes(1);
    expect(addresses.get(10).FullAddress).toBe("نشانی سفارش");
    expect(addresses.get(10)).not.toHaveProperty("capture_source");
    expect(addresses.get(11)).toBe(legacy);
  });

  it("captures address and city facts on the caller transaction and never replaces an existing snapshot", async () => {
    const { chain, trx, strapi } = fixtures();
    await captureOrderDeliverySnapshot(strapi, 10, 9, trx);
    expect(chain.forShare).toHaveBeenCalled();
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        order_id: 10,
        capture_source: "checkout",
        city_id: 3,
        full_address: "خیابان اصلی",
        postal_code: "0123456789",
      }),
    );
    expect(chain.onConflict).toHaveBeenCalledWith("order_id");
    expect(chain.ignore).toHaveBeenCalled();
    expect(strapi.db.connection).not.toHaveBeenCalled();
  });
  it("represents an absent address without inventing customer data", async () => {
    const { chain, trx, strapi } = fixtures();
    await captureOrderDeliverySnapshot(strapi, 10, undefined, trx);
    expect(strapi.db.query).not.toHaveBeenCalled();
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ order_id: 10, city_id: null, full_address: null }),
    );
  });
  it("corrections update only rows that already exist rather than backfilling legacy history", async () => {
    const { chain, trx, strapi, address } = fixtures();
    await updateExistingOrderDeliverySnapshot(strapi, 10, address, trx);
    expect(chain.where).toHaveBeenCalledWith({ order_id: 10 });
    expect(chain.update).toHaveBeenCalled();
    expect(chain.insert).not.toHaveBeenCalled();
  });
  it("returns safe snapshot fields ahead of mutable profile information", async () => {
    const { trx, strapi } = fixtures({
      address_id: 9,
      full_address: "قدیمی",
      postal_code: "0123456789",
      city_id: 3,
      city_title: "تهران",
      province_id: 2,
      province_title: "تهران",
      recipient_name: "گیرنده",
      recipient_phone: "09120000000",
      user_id: 999,
    });
    const result = await effectiveOrderDeliveryAddress(strapi, 10, { FullAddress: "جدید" }, trx);
    expect(result.FullAddress).toBe("قدیمی");
    expect(result).not.toHaveProperty("user_id");
  });
  it("leaves legacy linked addresses intact", async () => {
    const { trx, strapi, address } = fixtures();
    expect(await effectiveOrderDeliveryAddress(strapi, 10, address, trx)).toBe(address);
  });
});
