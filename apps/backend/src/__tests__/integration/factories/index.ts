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
    externalId?: string;
    gatewayRefId?: string;
  }) {
    const row = await q("api::contract-transaction.contract-transaction").create({
      data: {
        Type: opts.type ?? "Gateway",
        Amount: opts.amount,
        Step: opts.step ?? 1,
        Status: opts.status ?? "Pending",
        ...(opts.contractId ? { contract: opts.contractId } : {}),
        ...(opts.externalId ? { external_id: opts.externalId } : {}),
        ...(opts.gatewayRefId ? { GatewayRefId: opts.gatewayRefId } : {}),
        external_source: TEST_PREFIX,
        Date: new Date().toISOString(),
      },
    });
    track("api::contract-transaction.contract-transaction", row.id);
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
        Type: "Automatic",
        Date: new Date().toISOString(),
        external_source: TEST_PREFIX,
      },
    });
    track("api::order.order", row.id);
    return row;
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

  async function getStock(stockId: number) {
    return q("api::product-stock.product-stock").findOne({ where: { id: stockId } });
  }

  async function getOrder(orderId: number) {
    return q("api::order.order").findOne({ where: { id: orderId } });
  }

  async function cleanup() {
    for (let i = created.length - 1; i >= 0; i--) {
      const { uid, id } = created[i];
      try {
        await q(uid).delete({ where: { id } });
      } catch {
        /* best effort: disposable DB */
      }
    }
    created.length = 0;
  }

  return {
    createStock,
    createVariation,
    createUser,
    createContract,
    createContractTransaction,
    createOrder,
    createOrderItem,
    createReservedOrder,
    getStock,
    getOrder,
    cleanup,
  };
}
