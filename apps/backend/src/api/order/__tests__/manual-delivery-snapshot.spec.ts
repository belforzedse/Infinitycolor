const mockCoreCreate = jest.fn();
const mockTransaction = { raw: jest.fn() };
const mockAddressCreate = jest.fn();
const mockCityFind = jest.fn();
const mockStrapi = {
  db: {
    transaction: jest.fn(async (fn: any) => fn({ trx: mockTransaction })),
    query: jest.fn((uid: string) =>
      uid === "api::shipping-city.shipping-city"
        ? { findOne: mockCityFind }
        : { create: mockAddressCreate },
    ),
  },
};
jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreService: jest.fn(() => ({})),
    createCoreController: (_uid: string, builder: any) =>
      Object.setPrototypeOf(builder({ strapi: mockStrapi }), { create: mockCoreCreate }),
  },
}));
jest.mock("../../../utils/adminAuthorization", () => ({
  requireCapability: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../../utils/adminActivity", () => ({
  logAdminOrderCreate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../utils/orderDeliverySnapshot", () => ({
  captureOrderDeliverySnapshot: jest.fn().mockResolvedValue(undefined),
}));
import { requireCapability } from "../../../utils/adminAuthorization";
import { captureOrderDeliverySnapshot } from "../../../utils/orderDeliverySnapshot";
import controller from "../controllers/order";
const delivery = {
  shippingCityId: 7,
  fullAddress: "خیابان اصلی پلاک ۱۲",
  postalCode: "۰۱۲۳۴۵۶۷۸۹",
  recipientName: "گیرنده",
  recipientPhone: "09120000000",
};
const context = (address: any = delivery) => ({
  state: { user: { id: 4 } },
  request: { body: { data: { Type: "Manual", deliveryAddress: address } } },
  badRequest: jest.fn(),
  set: jest.fn(),
});
describe("manual order delivery creation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCityFind.mockResolvedValue({ id: 7, shipping_province: { id: 2 } });
    mockAddressCreate.mockResolvedValue({ id: 9 });
    mockCoreCreate.mockResolvedValue({ data: { id: 10 } });
    (requireCapability as jest.Mock).mockResolvedValue(true);
  });
  it("persists validated recipient/city fields and snapshots them in the creation transaction", async () => {
    const ctx = context();
    await controller.create(ctx as any);
    expect(mockAddressCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          FullAddress: delivery.fullAddress,
          PostalCode: "0123456789",
          Phone: "+989120000000",
          shipping_city: 7,
          IsTemporary: true,
        }),
        transacting: mockTransaction,
      }),
    );
    expect(ctx.request.body.data).toEqual({ Type: "Manual", delivery_address: 9 });
    expect(captureOrderDeliverySnapshot).toHaveBeenCalledWith(mockStrapi, 10, 9, mockTransaction, "manual");
  });
  it("rejects unknown cities and malformed delivery input before creating an order", async () => {
    mockCityFind.mockResolvedValue(null);
    const city = context();
    await controller.create(city as any);
    expect(city.badRequest).toHaveBeenCalled();
    const postal = context({ ...delivery, postalCode: "12" });
    await controller.create(postal as any);
    expect(postal.badRequest).toHaveBeenCalled();
    expect(mockCoreCreate).not.toHaveBeenCalled();
    expect(mockAddressCreate).not.toHaveBeenCalled();
  });
  it("keeps creation permission authoritative", async () => {
    (requireCapability as jest.Mock).mockResolvedValue(false);
    await controller.create(context() as any);
    expect(mockStrapi.db.transaction).not.toHaveBeenCalled();
    expect(captureOrderDeliverySnapshot).not.toHaveBeenCalled();
  });
});
