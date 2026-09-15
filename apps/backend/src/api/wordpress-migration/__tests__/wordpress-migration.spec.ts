import {
  canonicalIranPhone,
  exactNonNegativeInteger,
  MigrationInputError,
  restoreMediaTimestamps,
  upsertOrder,
  upsertUser,
  upsertWallet,
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

  test("allowPhoneMerge adopts the phone owner without stealing its external_id", async () => {
    const trx = { raw: jest.fn().mockResolvedValue(undefined) };
    const owner = { id: 52, external_source: "wordpress", external_id: "8", phone: "+989123456789" };
    const userQuery = {
      findMany: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([owner]),
      update: jest.fn().mockResolvedValue({ ...owner }),
    };
    const infoQuery = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 61 }),
    };
    const queries: Record<string, any> = {
      "plugin::users-permissions.user": userQuery,
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
      allowPhoneMerge: true,
    });

    expect(result).toMatchObject({ id: 52, matchReason: "phone-merge" });
    const updated = userQuery.update.mock.calls[0][0].data;
    expect(updated).not.toHaveProperty("external_id");
    expect(updated).not.toHaveProperty("external_source");
  });

  test("refuses to merge onto an account a real person already claimed", async () => {
    const trx = { raw: jest.fn().mockResolvedValue(undefined) };
    const userQuery = {
      findMany: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{
          id: 52,
          external_source: "wordpress",
          external_id: "8",
          ClaimedAt: "2026-08-18T07:01:03.404Z",
        }]),
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
      allowPhoneMerge: true,
    })).rejects.toMatchObject({ code: "USER_PHONE_MERGE_CLAIMED", status: 409 });
  });

  test("refuses a wallet write that would overwrite a balance the account already holds", async () => {
    const trx = { raw: jest.fn().mockResolvedValue(undefined) };
    const userQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 52, external_source: "wordpress", external_id: "7" }]),
    };
    const walletQuery = { findMany: jest.fn().mockResolvedValue([{ id: 9, Balance: "5730000" }]) };
    const queries: Record<string, any> = {
      "plugin::users-permissions.user": userQuery,
      "api::local-user-wallet.local-user-wallet": walletQuery,
    };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({ trx })),
        query: jest.fn((uid) => queries[uid]),
      },
    };

    await expect(upsertWallet(strapiMock, {
      userSourceId: "7",
      balanceRial: "5180000",
    })).rejects.toMatchObject({ code: "WALLET_BALANCE_WOULD_CLOBBER", status: 409 });
  });

  test("a merged holder's wallet resolves through the identity mapping, not external_id", async () => {
    const trx = {
      raw: jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ user_id: 52 }] }),
    };
    const userQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 52, external_source: "wordpress", external_id: "8" }]),
    };
    const walletQuery = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 9 }),
    };
    const queries: Record<string, any> = {
      "plugin::users-permissions.user": userQuery,
      "api::local-user-wallet.local-user-wallet": walletQuery,
    };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({ trx })),
        query: jest.fn((uid) => queries[uid]),
      },
    };

    const result = await upsertWallet(strapiMock, {
      userSourceId: "7",
      balanceRial: "3000000",
    });

    expect(result).toEqual({ mode: "created", id: 9 });
    expect(walletQuery.create.mock.calls[0][0].data).toMatchObject({ Balance: "3000000", user: 52 });
    expect(userQuery.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 52 } }));
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
    const provinceQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 501, Code: "ABZ", Title: "البرز" }]),
    };
    const cityQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 502, Title: "کرج" }]),
    };
    const addressQuery = {
      create: jest.fn().mockResolvedValue({ id: 503 }),
    };
    const queries: Record<string, any> = {
      "api::order.order": orderQuery,
      "api::contract.contract": contractQuery,
      "api::order-item.order-item": itemQuery,
      "api::product-variation.product-variation": variationQuery,
      "api::shipping-province.shipping-province": provinceQuery,
      "api::shipping-city.shipping-city": cityQuery,
      "api::local-user-address.local-user-address": addressQuery,
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
      deliveryAddress: {
        stateCode: "ABZ",
        cityTitle: " كرج ",
        fullAddress: "خیابان شهید بهشتی، پلاک ۱۲",
        postalCode: "۳۱۵۳۶۱۲۳۴۵",
        recipientName: "زهرا محمدی",
        recipientPhone: "+989123456789",
      },
      items: [{
        sourceId: "9",
        variationSourceId: "4",
        count: 2,
        unitPriceToman: "475",
        title: "کالا",
        sku: "S",
      }],
    })).resolves.toEqual(expect.objectContaining({
      mode: "created",
      id: 101,
      contractId: 201,
      addressLinked: true,
      addressMode: "created",
      addressReason: "SOURCE_ADDRESS_ATTACHED",
    }));

    expect(orderQuery.create.mock.calls[0][0].data.ShippingCost).toBe(50);
    expect(orderQuery.create.mock.calls[0][0].data.delivery_address).toBe(503);
    expect(contractQuery.create.mock.calls[0][0].data.Amount).toBe("1000");
    expect(itemQuery.create.mock.calls[0][0].data.PerAmount).toBe("475");
    expect(addressQuery.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      PostalCode: "3153612345",
      FullAddress: "خیابان شهید بهشتی، پلاک ۱۲",
      FullName: "زهرا محمدی",
      Phone: "+989123456789",
      Description: "woo-order:44",
      IsTemporary: true,
      shipping_city: 502,
    }));
  });

  test("preserves an existing order address instead of replacing it from Woo", async () => {
    const trx = { raw: jest.fn().mockResolvedValue(undefined) };
    const orderQuery = {
      findMany: jest.fn().mockResolvedValue([{
        id: 101,
        user: null,
        delivery_address: { id: 777 },
      }]),
      update: jest.fn().mockResolvedValue({ id: 101 }),
    };
    const contractQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 201 }]),
      update: jest.fn().mockResolvedValue({ id: 201 }),
    };
    const itemQuery = {
      findMany: jest.fn()
        .mockResolvedValueOnce([{ id: 301 }])
        .mockResolvedValueOnce([{ id: 301, external_id: "line_item_9" }]),
      update: jest.fn().mockResolvedValue({ id: 301 }),
      delete: jest.fn(),
    };
    const queries: Record<string, any> = {
      "api::order.order": orderQuery,
      "api::contract.contract": contractQuery,
      "api::order-item.order-item": itemQuery,
      "api::product-variation.product-variation": {
        findMany: jest.fn().mockResolvedValue([{ id: 401 }]),
      },
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
      deliveryAddress: {
        stateCode: "THR",
        cityTitle: "تهران",
        fullAddress: "نشانی تازه از منبع",
      },
      items: [{
        sourceId: "9",
        variationSourceId: "4",
        count: 2,
        unitPriceToman: "475",
        title: "کالا",
        sku: "S",
      }],
    })).resolves.toEqual(expect.objectContaining({
      addressLinked: true,
      addressMode: "preserved",
      addressReason: "EXISTING_ADDRESS",
    }));

    expect(orderQuery.update.mock.calls[0][0].data.delivery_address).toBe(777);
    expect(strapiMock.db.query).not.toHaveBeenCalledWith("api::shipping-province.shipping-province");
    expect(strapiMock.db.query).not.toHaveBeenCalledWith("api::local-user-address.local-user-address");
  });

  test("keeps an order when one line variation is missing and records the unresolved issue", async () => {
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
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      create: jest.fn().mockResolvedValue({ id: 301 }),
      delete: jest.fn(),
    };
    const variationQuery = {
      findMany: jest.fn()
        .mockResolvedValueOnce([{ id: 401 }])
        .mockResolvedValueOnce([]),
    };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({ trx })),
        query: jest.fn((uid: string) => {
          const queries: Record<string, any> = {
            "api::order.order": orderQuery,
            "api::contract.contract": contractQuery,
            "api::order-item.order-item": itemQuery,
            "api::product-variation.product-variation": variationQuery,
            "api::shipping-province.shipping-province": { findMany: jest.fn().mockResolvedValue([]) },
            "api::shipping-city.shipping-city": { findMany: jest.fn().mockResolvedValue([]) },
            "api::local-user-address.local-user-address": { create: jest.fn() },
          };
          return queries[uid];
        }),
      },
    };

    const result = await upsertOrder(strapiMock, {
      sourceId: "88",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "ZarinPal",
      contractType: "Cash",
      taxPercent: 0,
      date: "2026-01-01T00:00:00Z",
      totalToman: "2000",
      shippingToman: "0",
      items: [
        {
          sourceId: "1",
          variationSourceId: "4",
          count: 1,
          unitPriceToman: "1000",
          title: "linked",
          sku: "A",
        },
        {
          sourceId: "2",
          variationSourceId: "999",
          count: 1,
          unitPriceToman: "1000",
          title: "missing",
          sku: "B",
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      mode: "created",
      itemsCreated: 2,
      itemsUnresolved: 1,
      itemIssues: ["ORDER_ITEM_VARIATION_UNRESOLVED:999"],
    }));
    expect(itemQuery.create.mock.calls[0][0].data.product_variation).toBe(401);
    expect(itemQuery.create.mock.calls[1][0].data.product_variation).toBeNull();
  });

  test("writes one settlement leg per payment, in Rial, and removes legs WooCommerce no longer reports", async () => {
    const trx = { raw: jest.fn().mockResolvedValue(undefined) };
    const orderQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 101, user: null, delivery_address: null }]),
      update: jest.fn().mockResolvedValue({ id: 101 }),
    };
    const contractQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 201 }]),
      update: jest.fn().mockResolvedValue({ id: 201 }),
    };
    const itemQuery = {
      findMany: jest.fn().mockResolvedValueOnce([{ id: 301 }]).mockResolvedValueOnce([{ id: 301, external_id: "line_item_1" }]),
      update: jest.fn().mockResolvedValue({ id: 301 }),
      delete: jest.fn(),
    };
    const txQuery = {
      // The backfill script's gateway leg exists; a stale return leg must go.
      findMany: jest.fn().mockResolvedValue([
        { id: 501, external_id: "transaction_1222924" },
        { id: 502, external_id: "transaction_1222924_return" },
      ]),
      create: jest.fn().mockResolvedValue({ id: 503 }),
      update: jest.fn().mockResolvedValue({ id: 501 }),
      delete: jest.fn().mockResolvedValue({ id: 502 }),
    };
    const variationQuery = { findMany: jest.fn().mockResolvedValue([{ id: 401 }]) };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({ trx })),
        query: jest.fn((uid: string) => ({
          "api::order.order": orderQuery,
          "api::contract.contract": contractQuery,
          "api::order-item.order-item": itemQuery,
          "api::contract-transaction.contract-transaction": txQuery,
          "api::product-variation.product-variation": variationQuery,
          "api::shipping-province.shipping-province": { findMany: jest.fn().mockResolvedValue([]) },
          "api::shipping-city.shipping-city": { findMany: jest.fn().mockResolvedValue([]) },
          "api::local-user-address.local-user-address": { create: jest.fn() },
        } as Record<string, any>)[uid]),
      },
    };

    const result = await upsertOrder(strapiMock, {
      sourceId: "1222924",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "SnappPay",
      contractType: "Credit",
      taxPercent: 0,
      date: "2026-07-01T08:00:00Z",
      totalToman: "813000",
      salesValueToman: "12809000",
      appliedDiscountToman: "0",
      paidAt: "2026-07-01T20:45:00Z",
      settlements: [
        { leg: "gateway", channel: "SnappPay", amountToman: "813000", date: "2026-07-01T20:45:00Z" },
        { leg: "wallet", channel: "Wallet", amountToman: "11996000", date: "2026-07-01T20:45:00Z" },
      ],
      items: [{ sourceId: "1", variationSourceId: "4", count: 1, unitPriceToman: "12694000", title: "کالا", sku: "A" }],
    });

    expect(result).toEqual(expect.objectContaining({
      mode: "updated",
      settlementsCreated: 1,
      settlementsUpdated: 1,
      settlementsDeleted: 1,
    }));
    // The contract carries the full sales value; the order the discount.
    expect(contractQuery.update.mock.calls[0][0].data.Amount).toBe("12809000");
    expect(orderQuery.update.mock.calls[0][0].data.AppliedDiscountAmount).toBe(0);
    expect(orderQuery.update.mock.calls[0][0].data.PaymentGateway).toBe("SnappPay");
    // Gateway leg updated in place under the backfill's id, in Rial, on the paid date.
    expect(txQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 501 },
      data: expect.objectContaining({
        Type: "Gateway",
        Amount: "8130000",
        DiscountAmount: "0",
        Status: "Success",
        SettlementGateway: "SnappPay",
        Date: "2026-07-01T20:45:00.000Z",
        SettledAt: "2026-07-01T20:45:00.000Z",
        TrackId: "woo_1222924",
        contract: 201,
        external_source: "woocommerce",
        external_id: "transaction_1222924",
      }),
    }));
    expect(txQuery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        Type: "Gateway",
        Amount: "119960000",
        SettlementGateway: "Wallet",
        external_id: "transaction_1222924_wallet",
      }),
    }));
    expect(txQuery.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 502 } }));
  });

  test("rejects malformed settlement legs and unknown channels before writing", async () => {
    const strapiMock = { db: { transaction: jest.fn() } };
    const base = {
      sourceId: "9",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "Manual",
      contractType: "Cash",
      taxPercent: 0,
      date: "2026-01-01T00:00:00Z",
      totalToman: "1000",
      items: [{ sourceId: "1", variationSourceId: "4", count: 1, unitPriceToman: "1000" }],
    };
    await expect(upsertOrder(strapiMock, { ...base, settlements: [{ leg: "gateway", channel: "Payzito", amountToman: "1000", date: "2026-01-01T00:00:00Z" }] }))
      .rejects.toMatchObject({ code: "ORDER_SETTLEMENT_CHANNEL_INVALID" });
    await expect(upsertOrder(strapiMock, { ...base, settlements: [{ leg: "cash", channel: "Manual", amountToman: "1000", date: "2026-01-01T00:00:00Z" }] }))
      .rejects.toMatchObject({ code: "ORDER_SETTLEMENT_LEG_INVALID" });
    await expect(upsertOrder(strapiMock, { ...base, settlements: [{ leg: "gateway", channel: "Manual", amountToman: "0", date: "2026-01-01T00:00:00Z" }] }))
      .rejects.toMatchObject({ code: "ORDER_SETTLEMENT_AMOUNT_INVALID" });
    await expect(upsertOrder(strapiMock, { ...base, paymentGateway: "Payzito" }))
      .rejects.toMatchObject({ code: "PAYMENT_GATEWAY_INVALID" });
    expect(strapiMock.db.transaction).not.toHaveBeenCalled();
  });

  test("stores a line whose WooCommerce product was deleted as a snapshot with no catalog relation", async () => {
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
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      create: jest.fn().mockResolvedValue({ id: 301 }),
      delete: jest.fn(),
    };
    const variationQuery = { findMany: jest.fn().mockResolvedValue([{ id: 401 }]) };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({ trx })),
        query: jest.fn((uid: string) => {
          const queries: Record<string, any> = {
            "api::order.order": orderQuery,
            "api::contract.contract": contractQuery,
            "api::order-item.order-item": itemQuery,
            "api::product-variation.product-variation": variationQuery,
            "api::shipping-province.shipping-province": { findMany: jest.fn().mockResolvedValue([]) },
            "api::shipping-city.shipping-city": { findMany: jest.fn().mockResolvedValue([]) },
            "api::local-user-address.local-user-address": { create: jest.fn() },
          };
          return queries[uid];
        }),
      },
    };

    const result = await upsertOrder(strapiMock, {
      sourceId: "1269185",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "ZarinPal",
      contractType: "Cash",
      taxPercent: 0,
      date: "2026-01-01T00:00:00Z",
      totalToman: "2000",
      shippingToman: "0",
      items: [
        {
          sourceId: "1",
          catalogReference: "catalog",
          variationSourceId: "4",
          count: 1,
          unitPriceToman: "1000",
          title: "still sold",
          sku: "A",
        },
        {
          sourceId: "2",
          catalogReference: "orphan",
          variationSourceId: null,
          count: 1,
          unitPriceToman: "1000",
          title: "کالای حذف\u200cشده",
          sku: "WC-LINE-2",
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({
      mode: "created",
      itemsCreated: 2,
      itemsOrphaned: 1,
      itemsUnresolved: 0,
      itemIssues: ["ORDER_ITEM_CATALOG_REFERENCE_MISSING:2"],
    }));
    // The orphan line is a snapshot: full sale detail, no invented relation.
    const orphanData = itemQuery.create.mock.calls[1][0].data;
    expect(orphanData.product_variation).toBeNull();
    expect(orphanData.ProductTitle).toBe("کالای حذف\u200cشده");
    expect(orphanData.ProductSKU).toBe("WC-LINE-2");
    expect(orphanData.PerAmount).toBe("1000");
    expect(orphanData.Count).toBe(1);
    // No catalog lookup is attempted for it — one call, for the catalog line.
    expect(variationQuery.findMany).toHaveBeenCalledTimes(1);
    // An imported order never moves stock.
    expect(strapiMock.db.query).not.toHaveBeenCalledWith("api::product-stock.product-stock");
  });

  test("re-importing an order with an orphan line rewrites the same line and creates no duplicate", async () => {
    const trx = { raw: jest.fn().mockResolvedValue(undefined) };
    const orderQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 101 }]),
      update: jest.fn().mockResolvedValue({ id: 101 }),
    };
    const contractQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 201 }]),
      update: jest.fn().mockResolvedValue({ id: 201 }),
    };
    const itemQuery = {
      findMany: jest.fn()
        // The existing orphan line, then the stale-item sweep.
        .mockResolvedValueOnce([{ id: 301, external_id: "line_item_2" }])
        .mockResolvedValueOnce([{ id: 301, external_id: "line_item_2" }]),
      update: jest.fn().mockResolvedValue({ id: 301 }),
      create: jest.fn(),
      delete: jest.fn(),
    };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({ trx })),
        query: jest.fn((uid: string) => {
          const queries: Record<string, any> = {
            "api::order.order": orderQuery,
            "api::contract.contract": contractQuery,
            "api::order-item.order-item": itemQuery,
            "api::product-variation.product-variation": { findMany: jest.fn().mockResolvedValue([]) },
            "api::shipping-province.shipping-province": { findMany: jest.fn().mockResolvedValue([]) },
            "api::shipping-city.shipping-city": { findMany: jest.fn().mockResolvedValue([]) },
            "api::local-user-address.local-user-address": { create: jest.fn() },
          };
          return queries[uid];
        }),
      },
    };

    const payload = {
      sourceId: "1269185",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "ZarinPal",
      contractType: "Cash",
      taxPercent: 0,
      date: "2026-01-01T00:00:00Z",
      totalToman: "1000",
      shippingToman: "0",
      items: [{
        sourceId: "2",
        catalogReference: "orphan",
        variationSourceId: null,
        count: 1,
        unitPriceToman: "1000",
        title: "کالای حذف\u200cشده",
        sku: "WC-LINE-2",
      }],
    };

    const result = await upsertOrder(strapiMock, payload);
    expect(result).toEqual(expect.objectContaining({
      mode: "updated",
      itemsCreated: 0,
      itemsUpdated: 1,
      itemsDeleted: 0,
      itemsOrphaned: 1,
    }));
    expect(itemQuery.create).not.toHaveBeenCalled();
    expect(itemQuery.delete).not.toHaveBeenCalled();
    expect(itemQuery.update.mock.calls[0][0].data.product_variation).toBeNull();
    expect(itemQuery.update.mock.calls[0][0].data.PerAmount).toBe("1000");
  });

  test("rejects an orphan marker that still carries a catalog reference", async () => {
    const trx = { raw: jest.fn().mockResolvedValue(undefined) };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({ trx })),
        query: jest.fn((uid: string) => {
          const queries: Record<string, any> = {
            "api::order.order": { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 101 }) },
            "api::contract.contract": { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 201 }) },
            "api::order-item.order-item": { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), delete: jest.fn() },
            "api::product-variation.product-variation": { findMany: jest.fn().mockResolvedValue([]) },
            "api::shipping-province.shipping-province": { findMany: jest.fn().mockResolvedValue([]) },
            "api::shipping-city.shipping-city": { findMany: jest.fn().mockResolvedValue([]) },
            "api::local-user-address.local-user-address": { create: jest.fn() },
          };
          return queries[uid];
        }),
      },
    };

    await expect(upsertOrder(strapiMock, {
      sourceId: "1269185",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "ZarinPal",
      contractType: "Cash",
      taxPercent: 0,
      date: "2026-01-01T00:00:00Z",
      totalToman: "1000",
      shippingToman: "0",
      items: [{
        sourceId: "2",
        catalogReference: "orphan",
        variationSourceId: "4",
        count: 1,
        unitPriceToman: "1000",
        title: "inconsistent",
        sku: "X",
      }],
    })).rejects.toThrow("ORDER_ITEM_ORPHAN_HAS_CATALOG_REFERENCE");
  });

  test("keeps an unowned order when registered identity fails and billing phone is unusable", async () => {
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
    const mappingRaw = jest.fn().mockResolvedValue({ rows: [] });
    const userQuery = {
      findMany: jest.fn().mockResolvedValue([]),
    };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({
          trx: { raw: mappingRaw },
        })),
        query: jest.fn((uid: string) => {
          const queries: Record<string, any> = {
            "api::order.order": orderQuery,
            "api::contract.contract": contractQuery,
            "api::order-item.order-item": itemQuery,
            "api::product-variation.product-variation": {
              findMany: jest.fn().mockResolvedValue([{ id: 401 }]),
            },
            "plugin::users-permissions.user": userQuery,
            "api::shipping-province.shipping-province": { findMany: jest.fn().mockResolvedValue([]) },
            "api::shipping-city.shipping-city": { findMany: jest.fn().mockResolvedValue([]) },
            "api::local-user-address.local-user-address": { create: jest.fn() },
          };
          return queries[uid];
        }),
      },
    };

    const result = await upsertOrder(strapiMock, {
      sourceId: "77",
      customerSourceId: "182105",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "Wallet",
      contractType: "Cash",
      taxPercent: 0,
      date: "2026-01-01T00:00:00Z",
      totalToman: "1000",
      shippingToman: "0",
      // No usable billing phone → guest fallback unresolved.
      orderIdentity: { phone: "", firstName: "A", lastName: "B" },
      items: [{
        sourceId: "1",
        variationSourceId: "4",
        count: 1,
        unitPriceToman: "1000",
        title: "x",
        sku: "S",
      }],
    });

    expect(result).toEqual(expect.objectContaining({
      mode: "created",
      userLinked: false,
      identityIssues: expect.arrayContaining([
        "ORDER_CUSTOMER_NOT_FOUND",
        "ORDER_REGISTERED_IDENTITY_GUEST_FALLBACK_UNRESOLVED",
      ]),
    }));
    expect(orderQuery.create.mock.calls[0][0].data.user).toBeNull();
  });

  test("falls back to billing-phone guest owner when registered customer is missing", async () => {
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
    const mappingRaw = jest.fn(async (sql: string) => {
      if (String(sql).includes("pg_advisory_xact_lock")) return undefined;
      if (String(sql).includes("INSERT INTO customer_identity_mappings")) {
        return { rows: [{ user_id: 9001 }] };
      }
      return { rows: [] };
    });
    const createdUser = {
      id: 9001,
      phone: "+989121234567",
      external_source: "woocommerce-guest",
      ProfileManagedByCustomer: false,
    };
    const userQuery = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(createdUser),
    };
    const roleQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 3, type: "customer" }]),
    };
    const infoQuery = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 1 }),
    };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({
          trx: { raw: mappingRaw },
        })),
        query: jest.fn((uid: string) => {
          const queries: Record<string, any> = {
            "api::order.order": orderQuery,
            "api::contract.contract": contractQuery,
            "api::order-item.order-item": itemQuery,
            "api::product-variation.product-variation": {
              findMany: jest.fn().mockResolvedValue([{ id: 401 }]),
            },
            "plugin::users-permissions.user": userQuery,
            "plugin::users-permissions.role": roleQuery,
            "api::local-user-info.local-user-info": infoQuery,
            "api::shipping-province.shipping-province": { findMany: jest.fn().mockResolvedValue([]) },
            "api::shipping-city.shipping-city": { findMany: jest.fn().mockResolvedValue([]) },
            "api::local-user-address.local-user-address": { create: jest.fn() },
          };
          return queries[uid];
        }),
      },
    };

    const result = await upsertOrder(strapiMock, {
      sourceId: "78",
      customerSourceId: "182105",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "Wallet",
      contractType: "Cash",
      taxPercent: 0,
      date: "2026-01-01T00:00:00Z",
      totalToman: "1000",
      shippingToman: "0",
      orderIdentity: {
        phone: "+989121234567",
        email: "a@example.com",
        firstName: "A",
        lastName: "B",
      },
      items: [{
        sourceId: "1",
        variationSourceId: "4",
        count: 1,
        unitPriceToman: "1000",
        title: "x",
        sku: "S",
      }],
    });

    expect(result).toEqual(expect.objectContaining({
      mode: "created",
      userLinked: true,
      identityIssues: expect.arrayContaining([
        "ORDER_CUSTOMER_NOT_FOUND",
        "ORDER_REGISTERED_IDENTITY_GUEST_FALLBACK",
      ]),
    }));
    expect(orderQuery.create.mock.calls[0][0].data.user).toBe(9001);
    expect(userQuery.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        external_source: "woocommerce-guest",
        phone: "+989121234567",
        AccountOrigin: "WooGuest",
      }),
    }));
  });

  test("guest-fallback matches existing phone owner without claiming wordpress external_id", async () => {
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
    const phoneOwner = {
      id: 5500,
      phone: "+989121234567",
      email: "owner@example.com",
      external_source: "wordpress",
      external_id: "999",
      AccountOrigin: "WooRegistered",
      ClaimedAt: null,
      IsVerified: false,
      ProfileManagedByCustomer: false,
    };
    const mappingRaw = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // registered mapping
      .mockResolvedValueOnce({ rows: [] }) // guest mapping
      .mockResolvedValue({ rows: [{ user_id: 5500 }] });
    const userQuery = {
      findMany: jest.fn()
        .mockResolvedValueOnce([]) // legacy registered source
        .mockResolvedValueOnce([phoneOwner]) // guest phone lookup
        .mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(phoneOwner),
      create: jest.fn(),
    };
    const infoQuery = {
      findMany: jest.fn().mockResolvedValue([{ id: 9, FirstName: "Old", LastName: "Name" }]),
      update: jest.fn(),
      create: jest.fn(),
    };
    const strapiMock = {
      db: {
        transaction: jest.fn(async (callback) => callback({
          trx: { raw: mappingRaw },
        })),
        query: jest.fn((uid: string) => {
          const queries: Record<string, any> = {
            "api::order.order": orderQuery,
            "api::contract.contract": contractQuery,
            "api::order-item.order-item": itemQuery,
            "api::product-variation.product-variation": {
              findMany: jest.fn().mockResolvedValue([{ id: 401 }]),
            },
            "plugin::users-permissions.user": userQuery,
            "api::local-user-info.local-user-info": infoQuery,
            "api::shipping-province.shipping-province": { findMany: jest.fn().mockResolvedValue([]) },
            "api::shipping-city.shipping-city": { findMany: jest.fn().mockResolvedValue([]) },
            "api::local-user-address.local-user-address": { create: jest.fn() },
          };
          return queries[uid];
        }),
      },
    };

    const result = await upsertOrder(strapiMock, {
      sourceId: "79",
      customerSourceId: "182105",
      status: "Done",
      contractStatus: "Finished",
      paymentGateway: "Wallet",
      contractType: "Cash",
      taxPercent: 0,
      date: "2026-01-01T00:00:00Z",
      totalToman: "1000",
      shippingToman: "0",
      orderIdentity: { phone: "09121234567", firstName: "A", lastName: "B" },
      items: [{
        sourceId: "1",
        variationSourceId: "4",
        count: 1,
        unitPriceToman: "1000",
        title: "x",
        sku: "S",
      }],
    });

    expect(result).toEqual(expect.objectContaining({
      mode: "created",
      userLinked: true,
      identityIssues: expect.arrayContaining([
        "ORDER_CUSTOMER_NOT_FOUND",
        "ORDER_REGISTERED_IDENTITY_GUEST_FALLBACK",
      ]),
    }));
    expect(orderQuery.create.mock.calls[0][0].data.user).toBe(5500);
    expect(userQuery.create).not.toHaveBeenCalled();
    // Must not rewrite the conflicting wordpress external_id onto another account.
    expect(userQuery.update).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ external_id: "182105" }),
    }));
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
