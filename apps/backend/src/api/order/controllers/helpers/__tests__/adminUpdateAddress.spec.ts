jest.mock("../../../../../utils/adminAuthorization", () => ({
  requireCapability: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../../../../utils/adminActivity", () => ({
  logAdminOrderAddressUpdate: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../../../../utils/getClientIp", () => ({
  getClientIp: jest.fn(() => "127.0.0.1"),
  getUserAgent: jest.fn(() => "jest"),
}));
jest.mock("../../../../reserve-group/lib/reserve-group", () => ({
  lockReserveGroup: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../../../../utils/transactionExecutor", () => ({
  runRawSql: jest.fn().mockResolvedValue({ rows: [{ id: 10 }] }),
}));
jest.mock("../../../../../queue/anipo-recipient", () => ({
  enqueueAnipoRecipientSync: jest.fn().mockResolvedValue(undefined),
}));

import { adminUpdateAddressHandler, parseOrderAddressInput } from "../adminUpdateAddress";
import { logAdminOrderAddressUpdate } from "../../../../../utils/adminActivity";
import { enqueueAnipoRecipientSync } from "../../../../../queue/anipo-recipient";

const city = { id: 7, Title: "گرگان", shipping_province: { id: 2, Title: "گلستان" } };
const oldAddress = {
  id: 40,
  shipping_city: { id: 6 },
  PostalCode: "1111111111",
  FullAddress: "نشانی قدیمی",
  FullName: "گیرنده قدیمی",
  Phone: "+989111111111",
  IsTemporary: false,
};
const input = {
  shippingCityId: 7,
  fullAddress: "نشانی جدید و کامل",
  postalCode: "1234567890",
  recipientName: "گیرنده جدید",
  recipientPhone: "09122222222",
};

function ctx(body = input) {
  return {
    params: { id: "10" },
    state: { user: { id: 99, role: { name: "Seller 2" } } },
    request: { body: { data: body } },
    badRequest: jest.fn((message, detail) => ({ message, detail })),
    notFound: jest.fn((message) => ({ message })),
    body: undefined as any,
  };
}

function makeStrapi(orderOverrides: Record<string, unknown> = {}) {
  const order = {
    id: 10,
    user: { id: 4 },
    delivery_address: oldAddress,
    reserve_shipment: null,
    AnipoSubmittedAt: null,
    AnipoRecipientRevision: 0,
    ...orderOverrides,
  };
  const orderQuery = {
    findOne: jest.fn().mockResolvedValue(order),
    findMany: jest.fn(),
    update: jest.fn().mockResolvedValue({ id: 10 }),
  };
  const addressQuery = { create: jest.fn().mockResolvedValue({ id: 50, ...input, FullAddress: input.fullAddress, PostalCode: input.postalCode, FullName: input.recipientName, Phone: "+989122222222" }) };
  const groupQuery = { findOne: jest.fn(), update: jest.fn() };
  const strapi = {
    db: {
      transaction: jest.fn((fn) => fn({ trx: "trx" })),
      query: jest.fn((uid: string) => {
        if (uid === "api::shipping-city.shipping-city") return { findOne: jest.fn().mockResolvedValue(city) };
        if (uid === "api::order.order") return orderQuery;
        if (uid === "api::local-user-address.local-user-address") return addressQuery;
        if (uid === "api::reserve-group.reserve-group") return groupQuery;
        throw new Error(uid);
      }),
    },
    log: { error: jest.fn() },
  } as any;
  return { strapi, orderQuery, addressQuery, groupQuery, order };
}

describe("parseOrderAddressInput", () => {
  it("normalizes Persian digits and Iranian mobile numbers", () => {
    expect(parseOrderAddressInput({ ...input, postalCode: "۱۲۳۴۵۶۷۸۹۰" })).toEqual({
      ...input,
      postalCode: "1234567890",
      recipientPhone: "+989122222222",
    });
  });

  it("accepts the all-zero placeholder checkout allows for an unknown postal code", () => {
    expect(parseOrderAddressInput({ ...input, postalCode: "۰۰۰۰۰۰۰۰۰۰" }).postalCode).toBe(
      "0000000000",
    );
  });

  it.each([
    [{ ...input, postalCode: "123" }, "postalCode"],
    [{ ...input, recipientPhone: "021123" }, "recipientPhone"],
    [{ ...input, shippingCityId: 0 }, "shippingCityId"],
  ])("rejects invalid values", (value, field) => {
    expect(() => parseOrderAddressInput(value)).toThrow();
    try { parseOrderAddressInput(value); } catch (error: any) { expect(error.field).toBe(field); }
  });
});

describe("adminUpdateAddressHandler", () => {
  beforeEach(() => jest.clearAllMocks());

  it("creates a temporary snapshot and only relinks the selected order", async () => {
    const { strapi, orderQuery, addressQuery } = makeStrapi();
    const context = ctx();
    await adminUpdateAddressHandler(strapi, context);

    expect(addressQuery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ IsTemporary: true, user: 4, shipping_city: 7 }),
      transacting: "trx",
    }));
    expect(orderQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 10 },
      data: expect.objectContaining({ delivery_address: 50 }),
    }));
    expect(logAdminOrderAddressUpdate).toHaveBeenCalledWith(
      strapi, 10, expect.arrayContaining(["fullAddress", "recipientPhone"]), 40, 50, 99,
      expect.any(Object), "127.0.0.1", "jest", "Seller 2", "trx",
    );
    expect(enqueueAnipoRecipientSync).not.toHaveBeenCalled();
    expect(context.body.data.affectedOrderIds).toEqual([10]);
  });

  it("does not write or audit a repeated no-op submission", async () => {
    const matchingAddress = {
      ...oldAddress,
      shipping_city: { id: 7 },
      FullAddress: input.fullAddress,
      PostalCode: input.postalCode,
      FullName: input.recipientName,
      Phone: "+989122222222",
    };
    const { strapi, orderQuery, addressQuery } = makeStrapi({ delivery_address: matchingAddress });
    const context = ctx();
    await adminUpdateAddressHandler(strapi, context);
    expect(addressQuery.create).not.toHaveBeenCalled();
    expect(orderQuery.update).not.toHaveBeenCalled();
    expect(logAdminOrderAddressUpdate).not.toHaveBeenCalled();
    expect(context.body.data.noChange).toBe(true);
  });

  it("relinks the reserve group and all member orders to one shared snapshot", async () => {
    const { strapi, orderQuery, groupQuery } = makeStrapi({ reserve_shipment: { id: 80 } });
    const members = [
      { id: 10, delivery_address: oldAddress, AnipoSubmittedAt: new Date(), AnipoBarcodeState: "Issued", AnipoRecipientRevision: 1 },
      { id: 11, delivery_address: { ...oldAddress, id: 41 }, AnipoSubmittedAt: null },
    ];
    orderQuery.findMany.mockResolvedValue(members);
    groupQuery.findOne.mockResolvedValue({ id: 80, delivery_address: oldAddress });
    groupQuery.update.mockResolvedValue({ id: 80 });
    const context = ctx();
    await adminUpdateAddressHandler(strapi, context);

    expect(orderQuery.update).toHaveBeenCalledTimes(2);
    expect(groupQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 80 },
      data: expect.objectContaining({ delivery_address: 50 }),
    }));
    expect(context.body.data.affectedOrderIds).toEqual([10, 11]);
    expect(enqueueAnipoRecipientSync).toHaveBeenCalledWith(10, 2);
  });

  it("does not queue provider work when the transactional audit fails", async () => {
    const { strapi } = makeStrapi({ AnipoSubmittedAt: new Date(), AnipoBarcodeState: "Issued" });
    (logAdminOrderAddressUpdate as jest.Mock).mockRejectedValueOnce(new Error("audit failed"));
    await expect(adminUpdateAddressHandler(strapi, ctx())).rejects.toThrow("audit failed");
    expect(enqueueAnipoRecipientSync).not.toHaveBeenCalled();
  });
});
