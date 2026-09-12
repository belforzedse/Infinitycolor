jest.mock("../../../../queue/anipo-recipient", () => ({
  enqueueAnipoRecipientSync: jest.fn().mockResolvedValue(undefined),
}));

import { processAnipoRecipientSync } from "../anipoRecipientSync";

const order = {
  id: 10,
  Status: "Shipment",
  ShippingBarcode: "BARCODE-KEPT",
  ShippingWeight: 250,
  ShippingBoxSizeId: 3,
  AnipoBarcodeState: "Issued",
  AnipoSubmittedAt: new Date(),
  AnipoRecipientRevision: 2,
  AnipoRecipientSyncAttempts: 0,
  delivery_address: {
    FullName: "گیرنده سفارش",
    Phone: "+989122222222",
    FullAddress: "نشانی جدید و کامل",
    PostalCode: "1234567890",
    shipping_city: { Title: "گرگان", shipping_province: { Title: "گلستان" } },
  },
  user: { phone: "+989111111111", user_info: { FirstName: "نام", LastName: "مشتری" } },
  contract: { Amount: 1000 },
  order_items: [],
};

function makeStrapi(value = order, provider = { ok: true }) {
  const query = {
    findOne: jest.fn().mockResolvedValue(value),
    update: jest.fn().mockResolvedValue({ id: value.id }),
  };
  const createOrUpdateOrder = jest.fn().mockResolvedValue(provider);
  return {
    strapi: {
      db: { query: jest.fn(() => query) },
      service: jest.fn(() => ({ createOrUpdateOrder })),
    } as any,
    query,
    createOrUpdateOrder,
  };
}

describe("Anipo recipient synchronization", () => {
  it("marks the exact revision synced only after provider acceptance and preserves barcode", async () => {
    const { strapi, query, createOrUpdateOrder } = makeStrapi();
    await expect(processAnipoRecipientSync(strapi, 10, 2)).resolves.toEqual({ status: "synced" });
    expect(createOrUpdateOrder).toHaveBeenCalledWith(expect.objectContaining({
      receiver_name: "گیرنده سفارش",
      receiver_mobile: "09122222222",
      receiver_address: "نشانی جدید و کامل",
    }));
    const update = query.update.mock.calls[query.update.mock.calls.length - 1][0];
    expect(update.where).toEqual({ id: 10, AnipoRecipientRevision: 2 });
    expect(update.data.AnipoRecipientSyncState).toBe("Synced");
    expect(update.data).not.toHaveProperty("ShippingBarcode");
  });

  it("records retryable failure without discarding the local revision", async () => {
    const { strapi, query } = makeStrapi(order, { ok: false, error: "temporary" });
    await expect(processAnipoRecipientSync(strapi, 10, 2)).rejects.toThrow("temporary");
    expect(query.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 10, AnipoRecipientRevision: 2 },
      data: expect.objectContaining({ AnipoRecipientSyncState: "Pending", AnipoRecipientSyncAttempts: 1 }),
    }));
  });

  it("does not call Anipo for a stale queued revision", async () => {
    const { strapi, createOrUpdateOrder } = makeStrapi({ ...order, AnipoRecipientRevision: 3 });
    await expect(processAnipoRecipientSync(strapi, 10, 2)).resolves.toEqual({ status: "stale" });
    expect(createOrUpdateOrder).not.toHaveBeenCalled();
  });
});
