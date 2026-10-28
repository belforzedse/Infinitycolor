jest.mock("../../../utils/orderDeliverySnapshot", () => ({
  effectiveOrderDeliveryAddress: jest.fn(async (_strapi, _id, address) => address),
  captureOrderDeliverySnapshot: jest.fn(async () => undefined),
  updateExistingOrderDeliverySnapshot: jest.fn(async () => undefined),
}));

jest.mock("../../../utils/adminAuthorization", () => ({
  requireCapability: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../../utils/adminActivity", () => ({
  logAdminOrderAddressUpdate: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../../utils/getClientIp", () => ({
  getClientIp: jest.fn(() => "127.0.0.1"),
  getUserAgent: jest.fn(() => "jest"),
}));
jest.mock("../../reserve-group/lib/reserve-group", () => ({
  lockReserveGroup: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../../utils/transactionExecutor", () => ({
  runRawSql: jest.fn().mockResolvedValue({ rows: [{ id: 10 }] }),
}));
jest.mock("../../../queue/anipo-recipient", () => ({
  enqueueAnipoRecipientSync: jest.fn().mockResolvedValue(undefined),
}));

import { adminUpdateAddressHandler } from "../controllers/helpers/adminUpdateAddress";
import { processAnipoRecipientSync } from "../services/anipoRecipientSync";
import { enqueueAnipoRecipientSync } from "../../../queue/anipo-recipient";

describe("order address to mocked Anipo flow", () => {
  it("keeps the local snapshot and barcode while the accepted correction reaches Anipo", async () => {
    const city = {
      id: 7,
      Title: "گرگان",
      shipping_province: { id: 2, Title: "گلستان" },
    };
    let address: any = {
      id: 40,
      shipping_city: city,
      PostalCode: "1111111111",
      FullAddress: "نشانی قدیمی",
      FullName: "گیرنده قدیمی",
      Phone: "+989111111111",
      IsTemporary: false,
    };
    let order: any = {
      id: 10,
      Status: "Shipment",
      user: { id: 4, phone: "+989111111111", user_info: { FirstName: "نام", LastName: "مشتری" } },
      delivery_address: address,
      reserve_shipment: null,
      contract: { Amount: 1000 },
      order_items: [],
      ShippingWeight: 250,
      ShippingBoxSizeId: 3,
      ShippingBarcode: "ISSUED-BARCODE",
      AnipoBarcodeState: "Issued",
      AnipoSubmittedAt: new Date(),
      AnipoRecipientRevision: 0,
      AnipoRecipientSyncedRevision: 0,
      AnipoRecipientSyncAttempts: 0,
      AnipoRecipientSyncLastAttemptAt: null,
    };
    const orderQuery = {
      findOne: jest.fn(async () => order),
      update: jest.fn(async ({ data }: any) => {
        order = {
          ...order,
          ...data,
          delivery_address:
            data.delivery_address === undefined ? order.delivery_address : address,
        };
        return order;
      }),
    };
    const createOrUpdateOrder = jest.fn().mockResolvedValue({ ok: true });
    const strapi = {
      db: {
        transaction: jest.fn((fn) => fn({ trx: "trx" })),
        query: jest.fn((uid: string) => {
          if (uid === "api::shipping-city.shipping-city") return { findOne: jest.fn().mockResolvedValue(city) };
          if (uid === "api::order.order") return orderQuery;
          if (uid === "api::local-user-address.local-user-address") {
            return {
              create: jest.fn(async ({ data }: any) => {
                address = { id: 50, ...data, shipping_city: city };
                return address;
              }),
            };
          }
          throw new Error(uid);
        }),
      },
      service: jest.fn(() => ({ createOrUpdateOrder })),
      log: { error: jest.fn() },
    } as any;
    const ctx: any = {
      params: { id: "10" },
      state: { user: { id: 99, role: { name: "Seller 2" } } },
      request: {
        body: {
          data: {
            shippingCityId: 7,
            fullAddress: "نشانی جدید و کامل",
            postalCode: "1234567890",
            recipientName: "گیرنده جدید",
            recipientPhone: "09122222222",
          },
        },
      },
      badRequest: jest.fn(),
      notFound: jest.fn(),
    };

    await adminUpdateAddressHandler(strapi, ctx);
    expect(order.delivery_address.id).toBe(50);
    expect(order.delivery_address.IsTemporary).toBe(true);
    expect(order.ShippingBarcode).toBe("ISSUED-BARCODE");
    expect(order.AnipoRecipientSyncState).toBe("Pending");
    expect(enqueueAnipoRecipientSync).toHaveBeenCalledWith(10, 1);

    await expect(processAnipoRecipientSync(strapi, 10, 1)).resolves.toEqual({ status: "synced" });
    expect(createOrUpdateOrder).toHaveBeenCalledWith(expect.objectContaining({
      order_code: "10",
      receiver_name: "گیرنده جدید",
      receiver_mobile: "09122222222",
      receiver_address: "نشانی جدید و کامل",
      receiver_postal_code: "1234567890",
    }));
    expect(order.AnipoRecipientSyncState).toBe("Synced");
    expect(order.AnipoRecipientSyncedRevision).toBe(1);
    expect(order.ShippingBarcode).toBe("ISSUED-BARCODE");
  });
});
