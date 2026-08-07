import {
  canonicalIranPhone,
  exactNonNegativeInteger,
  MigrationInputError,
  restoreMediaTimestamps,
  upsertOrder,
  upsertUser,
} from "../services/wordpress-migration";

describe("WordPress migration write service", () => {
  test("normalizes Iranian phones and exact big integers", () => {
    expect(canonicalIranPhone("۰۹۱۲ ۳۴۵ ۶۷۸۹")).toBe("+989123456789");
    expect(canonicalIranPhone("invalid")).toBeNull();
    expect(exactNonNegativeInteger("00120", "BAD")).toBe("120");
    expect(() => exactNonNegativeInteger("1.2", "BAD")).toThrow(MigrationInputError);
  });

  test("creates an OTP-first customer without a password or address", async () => {
    const trx = { raw: jest.fn().mockResolvedValue(undefined) };
    const userQuery = {
      findMany: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      create: jest.fn().mockResolvedValue({ id: 51 }),
    };
    const roleQuery = { findMany: jest.fn().mockResolvedValue([{ id: 3, type: "customer" }]) };
    const infoQuery = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 61 }),
    };
    const queries: Record<string, any> = {
      "plugin::users-permissions.user": userQuery,
      "plugin::users-permissions.role": roleQuery,
      "api::local-user-info.local-user-info": infoQuery,
    };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({ trx })),
        query: jest.fn((uid) => queries[uid]),
      },
    };

    const result = await upsertUser(strapiMock, {
      sourceId: "7",
      phone: "09123456789",
      email: "user@example.com",
      firstName: "نام",
      lastName: "خانوادگی",
      billing: { address_1: "must-not-be-used" },
      password: "must-not-be-used",
    });

    expect(result).toEqual({
      mode: "created",
      id: 51,
      matchReason: "preprovisioned",
      issues: [],
    });
    const created = userQuery.create.mock.calls[0][0].data;
    expect(created).toEqual(expect.objectContaining({
      phone: "+989123456789",
      external_source: "wordpress",
      external_id: "7",
      IsVerified: false,
      AccountOrigin: "WooRegistered",
      ProfileManagedByCustomer: false,
    }));
    expect(created).not.toHaveProperty("password");
    expect(JSON.stringify(created)).not.toContain("must-not-be-used");
  });

  test("rejects invalid order enums before starting a transaction", async () => {
    const strapiMock = { db: { transaction: jest.fn() } };
    await expect(upsertOrder(strapiMock, {
      sourceId: "1",
      status: "NotAStatus",
      contractStatus: "Finished",
      paymentGateway: "Unknown",
      date: "2026-01-01T00:00:00Z",
      totalToman: "0",
      items: [{ sourceId: "1" }],
    })).rejects.toMatchObject({ code: "ORDER_STATUS_INVALID" });
    expect(strapiMock.db.transaction).not.toHaveBeenCalled();
  });

  test("never reassigns a phone already owned by another WordPress source user", async () => {
    const trx = { raw: jest.fn().mockResolvedValue(undefined) };
    const userQuery = {
      findMany: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 52, external_source: "wordpress", external_id: "8" }]),
    };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({ trx })),
        query: jest.fn(() => userQuery),
      },
    };

    await expect(upsertUser(strapiMock, {
      sourceId: "7",
      phone: "09123456789",
    })).rejects.toMatchObject({ code: "USER_PHONE_SOURCE_CONFLICT", status: 409 });
    expect(trx.raw).toHaveBeenCalledTimes(3);
  });

  test("requires explicit contract type and a safe tax percentage", async () => {
    const strapiMock = { db: { transaction: jest.fn() } };
    const base = {
      sourceId: "1",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "SnappPay",
      date: "2026-01-01T00:00:00Z",
      totalToman: "0",
      items: [{ sourceId: "1" }],
    };
    await expect(upsertOrder(strapiMock, base)).rejects.toMatchObject({ code: "CONTRACT_TYPE_INVALID" });
    await expect(upsertOrder(strapiMock, { ...base, contractType: "Credit", taxPercent: 1.5 }))
      .rejects.toMatchObject({ code: "CONTRACT_TAX_PERCENT_INVALID" });
    expect(strapiMock.db.transaction).not.toHaveBeenCalled();
  });

  test("rejects the legacy Rial-named order payload before starting a transaction", async () => {
    const strapiMock = { db: { transaction: jest.fn() } };
    await expect(upsertOrder(strapiMock, {
      sourceId: "1",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "ZarinPal",
      contractType: "Cash",
      taxPercent: 0,
      date: "2026-01-01T00:00:00Z",
      totalRial: "10000",
      shippingRial: "500",
      items: [{ sourceId: "1", unitPriceRial: "4750" }],
    })).rejects.toMatchObject({ code: "ORDER_TOTAL_INVALID" });
    expect(strapiMock.db.transaction).not.toHaveBeenCalled();
  });

  test("writes Woo order money to destination Toman fields without scaling", async () => {
    const trx = { raw: jest.fn().mockResolvedValue(undefined) };
    const orderQuery = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 101 }),
    };
    const contractQuery = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 201 }),
    };
    const itemQuery = {
      findMany: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      create: jest.fn().mockResolvedValue({ id: 301 }),
      delete: jest.fn(),
    };
    const variationQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 401 }]),
    };
    const queries: Record<string, any> = {
      "api::order.order": orderQuery,
      "api::contract.contract": contractQuery,
      "api::order-item.order-item": itemQuery,
      "api::product-variation.product-variation": variationQuery,
    };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({ trx })),
        query: jest.fn((uid) => queries[uid]),
      },
    };

    await expect(upsertOrder(strapiMock, {
      sourceId: "44",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "ZarinPal",
      contractType: "Cash",
      taxPercent: 0,
      date: "2026-01-01T00:00:00Z",
      totalToman: "1000",
      shippingToman: "50",
      items: [{
        sourceId: "9",
        variationSourceId: "4",
        count: 2,
        unitPriceToman: "475",
        title: "کالا",
        sku: "S",
      }],
    })).resolves.toEqual(expect.objectContaining({ mode: "created", id: 101, contractId: 201 }));

    expect(orderQuery.create.mock.calls[0][0].data.ShippingCost).toBe(50);
    expect(contractQuery.create.mock.calls[0][0].data.Amount).toBe("1000");
    expect(itemQuery.create.mock.calls[0][0].data.PerAmount).toBe("475");
  });

  test("restores timestamps only for an existing media record on a trusted request", async () => {
    const previousToken = process.env.MIGRATION_CONTROL_TOKEN;
    const controlToken = "m".repeat(48);
    process.env.MIGRATION_CONTROL_TOKEN = controlToken;
    (global as any).strapi = {
      requestContext: { get: () => ({ request: { headers: {
        "x-infinity-migration-mode": "wordpress-v2",
        "x-infinity-migration-control": controlToken,
        "x-infinity-source-created-at": "2020-01-02T03:04:05.000Z",
        "x-infinity-source-updated-at": "2024-05-06T07:08:09.000Z",
      } } }) },
    };
    const fileQuery = {
      findOne: jest.fn().mockResolvedValue({ id: 77 }),
      update: jest.fn().mockResolvedValue({ id: 77 }),
    };
    const strapiMock = { db: { query: jest.fn(() => fileQuery) } };
    try {
      await expect(restoreMediaTimestamps(strapiMock, { id: "77" }))
        .resolves.toEqual({ id: 77, mode: "updated" });
      expect(fileQuery.update).toHaveBeenCalledWith({ where: { id: 77 }, data: {} });
    } finally {
      if (previousToken === undefined) delete process.env.MIGRATION_CONTROL_TOKEN;
      else process.env.MIGRATION_CONTROL_TOKEN = previousToken;
      delete (global as any).strapi;
    }
  });
});
