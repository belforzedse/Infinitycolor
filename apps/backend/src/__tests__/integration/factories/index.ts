/**
 * Deterministic, self-cleaning factories for the backend integration layer.
 *
 * Every factory writes through the REAL Strapi query engine (no mocks) and
 * records what it created in a per-instance registry. Call `cleanup()` in
 * `afterEach`/`afterAll` to delete ONLY the rows this test created, in reverse
 * dependency order. Test-owned string fields carry the `JEST_TEST__` prefix.
 */

export const TEST_PREFIX = "JEST_TEST__";

let seq = 0;
const uniq = () => `${TEST_PREFIX}${Date.now()}_${seq++}_${Math.floor(Math.random() * 1e6)}`;

type Ref = { uid: string; id: number };

export type Factories = ReturnType<typeof makeFactories>;

export function makeFactories(strapi: any) {
  // Deletion order: children first, then parents.
  const created: Ref[] = [];
  const createdOrderIds: number[] = [];
  const createdWalletIds: number[] = [];
  const track = (uid: string, id: number) => {
    created.push({ uid, id });
    return id;
  };

  const q = (uid: string) => strapi.db.query(uid);

  async function createStock(opts: { count?: number; reserved?: number } = {}) {
    const row = await q("api::product-stock.product-stock").create({
      data: {
        Count: opts.count ?? 10,
        reservedCount: opts.reserved ?? 0,
        external_source: TEST_PREFIX,
      },
    });
    track("api::product-stock.product-stock", row.id);
    return row;
  }

  async function createVariation(
    opts: {
      price?: number;
      discountPrice?: number | null;
      isPublished?: boolean;
      stockCount?: number;
      stockReserved?: number;
      stockId?: number;
    } = {},
  ) {
    const stockId = opts.stockId ?? (await createStock({ count: opts.stockCount, reserved: opts.stockReserved })).id;
    const row = await q("api::product-variation.product-variation").create({
      data: {
        SKU: uniq(),
        Price: opts.price ?? 100000,
        ...(opts.discountPrice != null ? { DiscountPrice: opts.discountPrice } : {}),
        IsPublished: opts.isPublished ?? true,
        product_stock: stockId,
        external_id: uniq(),
        external_source: TEST_PREFIX,
      },
    });
    track("api::product-variation.product-variation", row.id);
    return { ...row, stockId };
  }

  async function createUser(opts: { phone?: string } = {}) {
    const phone = opts.phone ?? `0912${Math.floor(1000000 + Math.random() * 8999999)}`;
    const row = await q("plugin::users-permissions.user").create({
      data: {
        username: uniq(),
        email: `${uniq()}@test.invalid`,
        phone,
        confirmed: true,
        blocked: false,
        provider: "local",
      },
    });
    track("plugin::users-permissions.user", row.id);
    return row;
  }

  async function createUserInfo(opts: { userId: number; firstName?: string; lastName?: string }) {
    const row = await q("api::local-user-info.local-user-info").create({
      data: {
        user: opts.userId,
        FirstName: opts.firstName ?? `${TEST_PREFIX}first`,
        LastName: opts.lastName ?? `${TEST_PREFIX}last`,
      },
    });
    track("api::local-user-info.local-user-info", row.id);
    return row;
  }

  async function createContract(
    opts: { amount?: number; status?: string; type?: string; userId?: number } = {},
  ) {
    const row = await q("api::contract.contract").create({
      data: {
        Type: opts.type ?? "Cash",
        Status: opts.status ?? "Not Ready",
        Amount: opts.amount ?? 100000,
        Date: new Date().toISOString(),
        ...(opts.userId ? { local_user: opts.userId } : {}),
        external_source: TEST_PREFIX,
      },
    });
    track("api::contract.contract", row.id);
    return row;
  }

  async function createContractTransaction(opts: {
    contractId?: number;
    amount: number;
    status?: "Pending" | "Success" | "Failed";
    type?: string;
    step?: number;
    trackId?: string;
    gatewayAuthority?: string;
    gatewayStatus?: string;
    gatewayResponse?: Record<string, unknown>;
    externalId?: string;
    externalSource?: string;
    gatewayRefId?: string;
    paymentGatewayId?: number;
  }) {
    const row = await q("api::contract-transaction.contract-transaction").create({
      data: {
        Type: opts.type ?? "Gateway",
        Amount: opts.amount,
        Step: opts.step ?? 1,
        Status: opts.status ?? "Pending",
        ...(opts.contractId ? { contract: opts.contractId } : {}),
        ...(opts.trackId ? { TrackId: opts.trackId } : {}),
        ...(opts.gatewayAuthority ? { GatewayAuthority: opts.gatewayAuthority } : {}),
        ...(opts.gatewayStatus ? { GatewayStatus: opts.gatewayStatus } : {}),
        ...(opts.gatewayResponse ? { GatewayResponse: opts.gatewayResponse } : {}),
        ...(opts.externalId ? { external_id: opts.externalId } : {}),
        external_source: opts.externalSource ?? TEST_PREFIX,
        ...(opts.gatewayRefId ? { GatewayRefId: opts.gatewayRefId } : {}),
        ...(opts.paymentGatewayId ? { payment_gateway: opts.paymentGatewayId } : {}),
        Date: new Date().toISOString(),
      },
    });
    track("api::contract-transaction.contract-transaction", row.id);
    return row;
  }

  async function createPaymentGateway(
    opts: { title?: string; description?: string; isActive?: boolean } = {},
  ) {
    const row = await q("api::payment-gateway.payment-gateway").create({
      data: {
        Title: opts.title ?? `${TEST_PREFIX}payment-gateway`,
        Description: opts.description ?? "Integration test payment gateway",
        IsActive: opts.isActive ?? true,
      },
    });
    track("api::payment-gateway.payment-gateway", row.id);
    return row;
  }

  async function createOrder(
    opts: {
      status?: string;
      reservationStatus?: string;
      reservedUntil?: Date | string | null;
      userId?: number;
      contractId?: number;
      paymentGateway?: string;
      discountCode?: string;
      deliveryAddressId?: number;
    } = {},
  ) {
    const row = await q("api::order.order").create({
      data: {
        Status: opts.status ?? "Paying",
        ReservationStatus: opts.reservationStatus ?? "Released",
        ...(opts.reservedUntil !== undefined
          ? { ReservedUntil: opts.reservedUntil instanceof Date ? opts.reservedUntil.toISOString() : opts.reservedUntil }
          : {}),
        ...(opts.userId ? { user: opts.userId } : {}),
        ...(opts.contractId ? { contract: opts.contractId } : {}),
        ...(opts.paymentGateway ? { PaymentGateway: opts.paymentGateway } : {}),
        ...(opts.discountCode ? { DiscountCode: opts.discountCode } : {}),
        ...(opts.deliveryAddressId ? { delivery_address: opts.deliveryAddressId } : {}),
        Type: "Automatic",
        Date: new Date().toISOString(),
        external_source: TEST_PREFIX,
      },
    });
    track("api::order.order", row.id);
    createdOrderIds.push(row.id);
    return row;
  }

  async function createShippingProvince(opts: { title?: string } = {}) {
    const row = await q("api::shipping-province.shipping-province").create({
      data: { Title: opts.title ?? uniq(), Code: uniq() },
    });
    track("api::shipping-province.shipping-province", row.id);
    return row;
  }

  async function createShippingCity(opts: { title?: string; provinceId?: number } = {}) {
    const provinceId = opts.provinceId ?? (await createShippingProvince()).id;
    const row = await q("api::shipping-city.shipping-city").create({
      data: { Title: opts.title ?? uniq(), Code: uniq(), shipping_province: provinceId },
    });
    track("api::shipping-city.shipping-city", row.id);
    return { ...row, provinceId };
  }

  async function createAddress(opts: { userId: number; cityId?: number; postalCode?: string }) {
    const cityId = opts.cityId ?? (await createShippingCity()).id;
    const row = await q("api::local-user-address.local-user-address").create({
      data: {
        user: opts.userId,
        shipping_city: cityId,
        PostalCode: opts.postalCode ?? uniq(),
        FullAddress: `${TEST_PREFIX}address`,
      },
    });
    track("api::local-user-address.local-user-address", row.id);
    return { ...row, cityId };
  }

  async function createOrderItem(opts: {
    orderId: number;
    variationId: number;
    count?: number;
    perAmount?: number;
  }) {
    const row = await q("api::order-item.order-item").create({
      data: {
        order: opts.orderId,
        product_variation: opts.variationId,
        Count: opts.count ?? 1,
        PerAmount: opts.perAmount ?? 100000,
        ProductTitle: `${TEST_PREFIX}product`,
        ProductSKU: uniq(),
        external_source: TEST_PREFIX,
      },
    });
    track("api::order-item.order-item", row.id);
    return row;
  }

  async function createCart(opts: { userId?: number; status?: string } = {}) {
    const row = await q("api::cart.cart").create({
      data: {
        ...(opts.userId ? { user: opts.userId } : {}),
        Status: opts.status ?? "Pending",
      },
    });
    track("api::cart.cart", row.id);
    return row;
  }

  async function createCartItem(opts: {
    cartId: number;
    variationId: number;
    count?: number;
    price?: number;
  }) {
    const count = opts.count ?? 1;
    const price = opts.price ?? 100000;
    const row = await q("api::cart-item.cart-item").create({
      data: {
        cart: opts.cartId,
        product_variation: opts.variationId,
        Count: count,
        Sum: count * price,
      },
    });
    track("api::cart-item.cart-item", row.id);
    return row;
  }

  /**
   * High-level helper: an order in a "Reserved" state with N items, each backed
   * by its own variation + product-stock whose reservedCount already reflects
   * the reserved quantity. Mirrors the post-`finalizeToOrder` shape that the
   * reserve→consume/release lifecycle operates on.
   */
  async function createReservedOrder(opts: {
    items: Array<{ count: number; stockCount: number; stockReserved?: number; perAmount?: number }>;
    reservedUntil?: Date;
    userId?: number;
    contractId?: number;
  }) {
    const order = await createOrder({
      status: "Paying",
      reservationStatus: "Reserved",
      reservedUntil: opts.reservedUntil ?? new Date(Date.now() + 15 * 60 * 1000),
      userId: opts.userId,
      contractId: opts.contractId,
    });

    const items: Array<{ orderItemId: number; variationId: number; stockId: number; count: number }> = [];
    for (const it of opts.items) {
      const variation = await createVariation({
        stockCount: it.stockCount,
        stockReserved: it.stockReserved ?? it.count,
      });
      const orderItem = await createOrderItem({
        orderId: order.id,
        variationId: variation.id,
        count: it.count,
        perAmount: it.perAmount,
      });
      items.push({ orderItemId: orderItem.id, variationId: variation.id, stockId: variation.stockId, count: it.count });
    }

    return { order, items };
  }

  /**
   * Mirrors the shape created after checkout gateway initiation: a Paying order
   * with reserved stock, a Toman contract, and a pending gateway transaction
   * whose Amount is stored in IRR.
   */
  async function createPayableOrder(opts: {
    amountToman?: number;
    authority?: string;
    gateway?: "ZarinPal" | "SamanKish" | "Mellat" | "SnappPay";
    transactionStatus?: "Pending" | "Success" | "Failed";
    userId?: number;
    items?: Array<{ count: number; stockCount: number; stockReserved?: number; perAmount?: number }>;
    reservedUntil?: Date;
    reservationStatus?: string;
    orderStatus?: string;
  } = {}) {
    const amountToman = opts.amountToman ?? 100000;
    const gateway = opts.gateway ?? "ZarinPal";
    const authority = opts.authority ?? uniq();
    const userId = opts.userId ?? (await createUser()).id;
    const gatewayEntity = await createPaymentGateway({
      title: `${TEST_PREFIX}${gateway}`,
      description: `${TEST_PREFIX}${gateway} integration gateway`,
    });
    const contract = await createContract({
      amount: amountToman,
      status: "Not Ready",
      type: "Cash",
      userId,
    });
    const { order, items } = await createReservedOrder({
      userId,
      contractId: contract.id,
      items: opts.items ?? [{ count: 2, stockCount: 10, stockReserved: 2, perAmount: amountToman / 2 }],
      reservedUntil: opts.reservedUntil,
    });

    if ((opts.orderStatus && opts.orderStatus !== "Paying") || opts.reservationStatus) {
      await q("api::order.order").update({
        where: { id: order.id },
        data: {
          ...(opts.orderStatus ? { Status: opts.orderStatus } : {}),
          ...(opts.reservationStatus ? { ReservationStatus: opts.reservationStatus } : {}),
        },
      });
    }

    await q("api::order.order").update({
      where: { id: order.id },
      data: {
        PaymentGateway: gateway,
        external_source: gateway,
        external_id: authority,
      },
    });
    await q("api::contract.contract").update({
      where: { id: contract.id },
      data: {
        external_source: gateway,
        external_id: authority,
      },
    });

    const transaction = await createContractTransaction({
      contractId: contract.id,
      amount: amountToman * 10,
      status: opts.transactionStatus ?? "Pending",
      trackId: authority,
      gatewayAuthority: authority,
      gatewayStatus: "REQUESTED",
      gatewayResponse: { integrationTest: true },
      externalId: authority,
      externalSource: gateway,
      paymentGatewayId: gatewayEntity.id,
    });

    return {
      amountToman,
      authority,
      userId,
      gatewayEntity,
      contract,
      order: await getOrder(order.id),
      transaction,
      items,
    };
  }

  async function createWallet(opts: { userId: number; balanceIrr: number }) {
    const row = await q("api::local-user-wallet.local-user-wallet").create({
      data: {
        user: opts.userId,
        Balance: opts.balanceIrr,
        LastTransactionDate: new Date().toISOString(),
        Description: TEST_PREFIX,
      },
    });
    track("api::local-user-wallet.local-user-wallet", row.id);
    createdWalletIds.push(row.id);
    return row;
  }

  async function createPaymentAttempt(opts: {
    userId: number;
    orderId: number;
    contractId: number;
    amountIrr: number;
    attemptId?: string;
    status?: string;
    gateway?: string;
  }) {
    const attemptId = opts.attemptId ?? uniq();
    const row = await q("api::payment-attempt.payment-attempt").create({
      data: {
        attemptId,
        quoteHash: `sha256:${uniq()}`,
        quoteSnapshot: {
          financialSummary: {
            subtotal: Math.round(opts.amountIrr / 10),
            discount: 0,
            tax: 0,
            shipping: 0,
            total: Math.round(opts.amountIrr / 10),
          },
        },
        Status: opts.status ?? "Created",
        Gateway: opts.gateway ?? "wallet",
        Amount: opts.amountIrr,
        user: opts.userId,
        order: opts.orderId,
        contract: opts.contractId,
      },
    });
    track("api::payment-attempt.payment-attempt", row.id);
    return row;
  }

  async function createDiscount(
    opts: {
      code?: string;
      type?: "Discount" | "Cash";
      amount?: number;
      limitUsage?: number;
      usedTimes?: number;
      limitAmount?: number;
      minCartTotal?: number;
      maxCartTotal?: number;
      isActive?: boolean;
      startDate?: Date;
      endDate?: Date;
      productIds?: number[];
      deliveryMethodIds?: number[];
    } = {},
  ) {
    const now = Date.now();
    const row = await q("api::discount.discount").create({
      data: {
        Code: opts.code ?? uniq(),
        Type: opts.type ?? "Discount",
        Amount: opts.amount ?? 10,
        ...(opts.limitAmount !== undefined ? { LimitAmount: opts.limitAmount } : {}),
        ...(opts.limitUsage !== undefined ? { LimitUsage: opts.limitUsage } : {}),
        UsedTimes: opts.usedTimes ?? 0,
        StartDate: (opts.startDate ?? new Date(now - 24 * 60 * 60 * 1000)).toISOString(),
        EndDate: (opts.endDate ?? new Date(now + 24 * 60 * 60 * 1000)).toISOString(),
        IsActive: opts.isActive ?? true,
        ...(opts.minCartTotal !== undefined ? { MinCartTotal: opts.minCartTotal } : {}),
        ...(opts.maxCartTotal !== undefined ? { MaxCartTotal: opts.maxCartTotal } : {}),
        ...(opts.productIds?.length ? { products: opts.productIds } : {}),
        ...(opts.deliveryMethodIds?.length ? { delivery_methods: opts.deliveryMethodIds } : {}),
      },
    });
    track("api::discount.discount", row.id);
    return row;
  }

  async function getDiscount(discountId: number) {
    return q("api::discount.discount").findOne({ where: { id: discountId } });
  }

  async function getCartItem(cartItemId: number) {
    return q("api::cart-item.cart-item").findOne({ where: { id: cartItemId } });
  }

  async function getCartItems(cartId: number) {
    return q("api::cart-item.cart-item").findMany({ where: { cart: { id: cartId } } });
  }

  async function getStock(stockId: number) {
    return q("api::product-stock.product-stock").findOne({ where: { id: stockId } });
  }

  async function getOrder(orderId: number) {
    return q("api::order.order").findOne({ where: { id: orderId } });
  }

  async function getContract(contractId: number) {
    return q("api::contract.contract").findOne({ where: { id: contractId } });
  }

  async function getContractTransaction(transactionId: number) {
    return q("api::contract-transaction.contract-transaction").findOne({ where: { id: transactionId } });
  }

  async function getContractTransactions(contractId: number) {
    return q("api::contract-transaction.contract-transaction").findMany({
      where: { contract: { id: contractId } },
      orderBy: { Date: "asc" },
    });
  }

  async function getOrderLogs(orderId: number) {
    return q("api::order-log.order-log").findMany({
      where: { order: { id: orderId } },
      orderBy: { createdAt: "asc" },
    });
  }

  async function cleanup() {
    if (createdWalletIds.length > 0) {
      try {
        await q("api::local-user-wallet-transaction.local-user-wallet-transaction").deleteMany({
          where: { user_wallet: { id: { $in: createdWalletIds } } },
        });
      } catch {
        /* best effort: disposable DB */
      }
    }
    if (createdOrderIds.length > 0) {
      try {
        await q("api::order-log.order-log").deleteMany({
          where: { order: { id: { $in: createdOrderIds } } },
        });
      } catch {
        /* best effort: disposable DB */
      }
    }

    for (let i = created.length - 1; i >= 0; i--) {
      const { uid, id } = created[i];
      try {
        await q(uid).delete({ where: { id } });
      } catch {
        /* best effort: disposable DB */
      }
    }
    created.length = 0;
    createdOrderIds.length = 0;
    createdWalletIds.length = 0;
  }

  return {
    createStock,
    createVariation,
    createUser,
    createUserInfo,
    createContract,
    createContractTransaction,
    createPaymentGateway,
    createOrder,
    createOrderItem,
    createCart,
    createCartItem,
    createShippingProvince,
    createShippingCity,
    createAddress,
    createReservedOrder,
    createPayableOrder,
    createWallet,
    createPaymentAttempt,
    createDiscount,
    getStock,
    getOrder,
    getContract,
    getContractTransaction,
    getContractTransactions,
    getOrderLogs,
    getDiscount,
    getCartItem,
    getCartItems,
    cleanup,
  };
}
