/**
 * Remaining checkout-candidate verification against a real Strapi + Postgres.
 * Provider HTTP is mocked; claim/persist/callback SQL is not.
 */
import axios from "axios";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createCheckoutQuote } from "../../../api/cart/services/lib/checkout-quote";
import { checkCartStockOp } from "../../../api/cart/services/ops/checkCartStock";
import { verifyPaymentHandler } from "../../../api/order/controllers/helpers/payment";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

type RawSqlFn = (
  strapi: unknown,
  sql: string,
  bindings?: unknown[],
  trx?: unknown,
) => Promise<unknown>;

function distTransactionExecutor(): { runRawSql: RawSqlFn } {
  const distDir =
    process.env.INTEGRATION_DIST_DIR || path.resolve(__dirname, "../../../../dist");
  return require(path.join(distDir, "src/utils/transactionExecutor")) as {
    runRawSql: RawSqlFn;
  };
}

let strapi: any;
let f: Factories;

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
});

beforeEach(() => {
  f = makeFactories(strapi);
});

afterEach(async () => {
  await f.cleanup();
});

async function seedCart(opts: { stockCount: number; quantity: number; price?: number }) {
  const price = opts.price ?? 100000;
  const user = await f.createUser({ phone: "09121234567" });
  const product = await f.createProduct({ status: "Active" });
  const variation = await f.createVariation({
    productId: product.id,
    stockCount: opts.stockCount,
    price,
  });
  const cart = await f.createCart({ userId: user.id });
  const cartItem = await f.createCartItem({
    cartId: cart.id,
    variationId: variation.id,
    count: opts.quantity,
    price,
  });
  return { user, product, variation, cart, cartItem, price };
}

async function rememberFinalize(result: {
  order?: { id?: number };
  contract?: { id?: number };
  paymentAttempt?: { id?: number };
}) {
  if (result.order?.id) {
    f.remember("api::order.order", result.order.id);
    const items = await strapi.db.query("api::order-item.order-item").findMany({
      where: { order: { id: result.order.id } },
    });
    for (const item of items) {
      f.remember("api::order-item.order-item", item.id);
    }
  }
  if (result.contract?.id) f.remember("api::contract.contract", result.contract.id);
  if (result.paymentAttempt?.id) {
    f.remember("api::payment-attempt.payment-attempt", result.paymentAttempt.id);
  }
}

function stockReserved(stock: { reservedCount?: unknown; reserved_count?: unknown }): number {
  return Number(stock.reservedCount ?? stock.reserved_count);
}

async function waitUntil(label: string, predicate: () => Promise<boolean>, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${label}`);
}

type SnappayHttpControl = {
  tokenCalls: () => number;
  releaseToken: () => void;
};

function installSnappayHttp(opts: { pauseToken?: boolean } = {}): SnappayHttpControl {
  let tokenCalls = 0;
  let releaseToken = () => undefined;
  const barrier = opts.pauseToken
    ? new Promise<void>((resolve) => {
        releaseToken = resolve;
      })
    : Promise.resolve();
  const http = {
    post: jest.fn(async (url: string) => {
      if (String(url).includes("oauth/token")) {
        return { status: 200, data: { access_token: "oauth-test", expires_in: 3600 } };
      }
      if (String(url).includes("/token")) {
        tokenCalls += 1;
        await barrier;
        return {
          status: 200,
          data: {
            successful: true,
            response: {
              paymentToken: "provider-token-1",
              paymentPageUrl: "https://pay.snapp.test/start?paymentToken=provider-token-1",
            },
          },
        };
      }
      throw new Error(`unexpected SnappPay POST ${url}`);
    }),
    get: jest.fn(async (url: string) => {
      if (String(url).includes("eligible")) {
        return {
          status: 200,
          data: { successful: true, response: { eligible: true } },
        };
      }
      if (String(url).includes("/status")) {
        return {
          status: 200,
          data: { successful: true, response: { status: "PENDING" } },
        };
      }
      throw new Error(`unexpected SnappPay GET ${url}`);
    }),
  };
  (axios as unknown as { create: jest.Mock }).create = jest.fn(() => http);
  return {
    tokenCalls: () => tokenCalls,
    releaseToken,
  };
}

async function ensureSnappayGateway() {
  return f.createPaymentGateway({ title: "SnappPay" });
}

async function placeGatewayOrder(
  userId: number,
  gateway: "snappay" | "mellat",
  extra: { discountCode?: string; attemptId?: string } = {},
) {
  const quote = await createCheckoutQuote(strapi, userId, {
    shippingCost: 0,
    gateway,
    discountCode: extra.discountCode,
  });
  const attemptId = extra.attemptId || randomUUID();
  const result = await strapi.service("api::cart.cart").finalizeCartToOrder(userId, {
    gateway,
    attemptId,
    quoteHash: quote.quoteHash,
    shippingCost: 0,
    discountCode: extra.discountCode,
    mobile: "09121234567",
  });
  await rememberFinalize(result);
  return { quote, attemptId, result };
}

async function snapshotPurchase(orderId: number) {
  const order = await strapi.db.query("api::order.order").findOne({ where: { id: orderId } });
  const attempts = await strapi.db.query("api::payment-attempt.payment-attempt").findMany({
    where: { order: { id: orderId } },
  });
  return {
    status: String(order?.Status || ""),
    reservation: String(order?.ReservationStatus || ""),
    attemptIds: attempts.map((row: { attemptId?: unknown }) => String(row.attemptId || "")),
    attemptStatuses: attempts.map((row: { Status?: unknown }) => String(row.Status || "")),
    amounts: attempts.map((row: { Amount?: unknown }) => String(row.Amount ?? "")),
    providerReferences: attempts.map((row: { providerReference?: unknown }) =>
      String(row.providerReference || ""),
    ),
  };
}

describe("issue 5 overlapping SnappPay initiation", () => {
  it("lets A finish one token while B and C cannot steal the lease or dispatch", async () => {
    const http = installSnappayHttp({ pauseToken: true });
    await ensureSnappayGateway();
    const seeded = await seedCart({ stockCount: 2, quantity: 1 });
    const created = await placeGatewayOrder(seeded.user.id, "snappay");
    expect(created.result.success).toBe(true);
    const attemptNumericId = Number(created.result.paymentAttempt.id);
    const callbackNonce = String(created.result.snappayCallbackNonce || "");
    expect(callbackNonce).toBeTruthy();

    const orchestrator = strapi.service("api::payment-gateway.snappay-orchestrator");
    const startA = orchestrator.initiate({
      paymentAttemptId: attemptNumericId,
      callbackNonce,
      mobile: "09121234567",
    });

    await waitUntil("A persisted pendingDispatch and posted /token", async () => {
      if (http.tokenCalls() < 1) return false;
      const row = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
        where: { id: attemptNumericId },
      });
      return Boolean(row?.providerResponse?.pendingDispatch);
    });

    const before = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
      where: { id: attemptNumericId },
    });
    const leaseUntil = String(before.leaseUntil || "");
    const leaseVersion = Number(before.leaseVersion ?? before.lease_version);
    const dispatchId = String(before.providerResponse?.pendingDispatch?.transactionId || "");
    expect(leaseUntil).toBeTruthy();
    expect(leaseVersion).toBeGreaterThan(0);
    expect(dispatchId).toBeTruthy();

    const [b, c] = await Promise.all([
      orchestrator.initiate({
        paymentAttemptId: attemptNumericId,
        callbackNonce,
        mobile: "09121234567",
      }),
      orchestrator.initiate({
        paymentAttemptId: attemptNumericId,
        callbackNonce,
        mobile: "09121234567",
      }),
    ]);

    expect(http.tokenCalls()).toBe(1);
    for (const loser of [b, c]) {
      expect(loser.success).toBe(false);
      expect(["PAYMENT_UNKNOWN", "PAYMENT_IN_PROGRESS"]).toContain(String(loser.errorCode));
    }

    const mid = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
      where: { id: attemptNumericId },
    });
    expect(String(mid.leaseUntil || "")).toBe(leaseUntil);
    expect(Number(mid.leaseVersion ?? mid.lease_version)).toBe(leaseVersion);
    expect(String(mid.providerResponse?.pendingDispatch?.transactionId || "")).toBe(dispatchId);

    http.releaseToken();
    const a = await startA;
    expect(a.success).toBe(true);
    expect(String(a.redirectUrl || "")).toContain("paymentToken=provider-token-1");
    expect(http.tokenCalls()).toBe(1);

    const persisted = await strapi.db.connection.raw(
      `SELECT status, redirect_url, lease_version, next_action, provider_response
         FROM payment_attempts
        WHERE id = ?`,
      [attemptNumericId],
    );
    const row = persisted.rows[0];
    const rawResponse = row.provider_response;
    const providerResponse =
      typeof rawResponse === "string" ? JSON.parse(rawResponse) : rawResponse || {};
    expect(providerResponse.pendingDispatch).toBeFalsy();
    expect(String(providerResponse.generation?.transactionId || "")).toBe(dispatchId);
    expect(Number(providerResponse.tokenAttemptSeq || 0)).toBeGreaterThan(0);
    expect(String(row.redirect_url || "")).toContain("paymentToken=provider-token-1");
    expect(Number(row.lease_version)).toBe(leaseVersion);
    const dbStatus = String(row.status || "");
    if (dbStatus === "Unknown") {
      // Integration Redis is mocked; enqueue failure parks queue_recovery
      // after the token row is already installed.
      expect(String(row.next_action || "")).toBe("queue_recovery");
    } else {
      expect(["Redirected", "Pending"]).toContain(dbStatus);
    }
  });
});

describe("issue 2 cross-order payment isolation", () => {
  it("keeps card order B unchanged when SnappPay order A receives callback and recovery activity", async () => {
    installSnappayHttp();
    await ensureSnappayGateway();
    const seeded = await seedCart({ stockCount: 2, quantity: 1 });
    const snapp = await placeGatewayOrder(seeded.user.id, "snappay");
    expect(snapp.result.success).toBe(true);

    const orchestrator = strapi.service("api::payment-gateway.snappay-orchestrator");
    const initiated = await orchestrator.initiate({
      paymentAttemptId: Number(snapp.result.paymentAttempt.id),
      callbackNonce: String(snapp.result.snappayCallbackNonce || ""),
      mobile: "09121234567",
    });
    expect(initiated.success).toBe(true);

    const card = await placeGatewayOrder(seeded.user.id, "mellat");
    expect(card.result.success).toBe(true);
    expect(card.result.order.id).not.toBe(snapp.result.order.id);

    const mellatRef = `MELLAT-B-${card.result.order.id}`;
    await strapi.db.query("api::payment-attempt.payment-attempt").update({
      where: { id: card.result.paymentAttempt.id },
      data: { providerReference: mellatRef, Status: "Redirected" },
    });

    const beforeB = await snapshotPurchase(card.result.order.id);
    const attemptA = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
      where: { id: snapp.result.paymentAttempt.id },
    });

    await orchestrator.acceptCallback({
      transactionId: String(attemptA.providerReference),
      state: "OK",
      amount: Number(attemptA.Amount),
      nonce: String(snapp.result.snappayCallbackNonce || ""),
    });
    await orchestrator.reconcileOrder(Number(snapp.result.order.id), "verification-recovery");

    expect(await snapshotPurchase(card.result.order.id)).toEqual(beforeB);

    const ctx = {
      request: {
        method: "POST",
        ip: "127.0.0.1",
        query: {},
        body: {
          RefId: mellatRef,
          ResCode: "17",
          OrderId: String(snapp.result.order.id),
          SaleOrderId: String(snapp.result.order.id),
        },
        header: { "content-type": "application/json", "user-agent": "jest-integration" },
      },
      redirect: jest.fn((url: string) => url),
      badRequest: jest.fn((message: string, payload?: unknown) => ({ message, payload })),
    };
    const beforeA = await snapshotPurchase(snapp.result.order.id);
    await verifyPaymentHandler(strapi, ctx);
    const afterA = await snapshotPurchase(snapp.result.order.id);
    expect(afterA.status).toBe(beforeA.status);
    expect(afterA.reservation).toBe(beforeA.reservation);
    expect(afterA.attemptIds).toEqual(beforeA.attemptIds);
  });
});

describe("issue 3 coupon apply and remove", () => {
  it("creates a new payable at the discounted amount and keeps the original order continuable", async () => {
    const seeded = await seedCart({ stockCount: 3, quantity: 1 });
    const discount = await f.createDiscount({
      code: `SAVE10-${seeded.user.id}`,
      type: "Cash",
      amount: 10_000,
      isActive: true,
    });

    const first = await placeGatewayOrder(seeded.user.id, "mellat");
    expect(first.result.success).toBe(true);
    const originalAmountIrr = Number(first.result.paymentAttempt.Amount);
    expect(originalAmountIrr).toBe(Math.round(first.quote.financialSummary.total * 10));

    const discountedQuote = await createCheckoutQuote(strapi, seeded.user.id, {
      shippingCost: 0,
      gateway: "mellat",
      discountCode: discount.Code,
    });
    expect(discountedQuote.quoteHash).not.toBe(first.quote.quoteHash);
    expect(discountedQuote.financialSummary.discount).toBe(10_000);
    expect(discountedQuote.financialSummary.total).toBe(first.quote.financialSummary.total - 10_000);

    const couponAttemptId = randomUUID();
    const couponOrder = await strapi.service("api::cart.cart").finalizeCartToOrder(
      seeded.user.id,
      {
        gateway: "mellat",
        attemptId: couponAttemptId,
        quoteHash: discountedQuote.quoteHash,
        shippingCost: 0,
        discountCode: discount.Code,
      },
    );
    await rememberFinalize(couponOrder);
    expect(couponOrder.success).toBe(true);
    expect(couponOrder.replayed).not.toBe(true);
    expect(couponOrder.order.id).not.toBe(first.result.order.id);
    expect(Number(couponOrder.paymentAttempt.Amount)).toBe(
      Math.round(discountedQuote.financialSummary.total * 10),
    );
    expect(Number(couponOrder.paymentAttempt.Amount)).not.toBe(originalAmountIrr);

    const removedQuote = await createCheckoutQuote(strapi, seeded.user.id, {
      shippingCost: 0,
      gateway: "mellat",
    });
    expect(removedQuote.quoteHash).toBe(first.quote.quoteHash);
    const removed = await strapi.service("api::cart.cart").finalizeCartToOrder(seeded.user.id, {
      gateway: "mellat",
      attemptId: randomUUID(),
      quoteHash: removedQuote.quoteHash,
      shippingCost: 0,
    });
    await rememberFinalize(removed);
    expect(removed.success).toBe(true);
    expect(removed.order.id).not.toBe(first.result.order.id);
    expect(removed.order.id).not.toBe(couponOrder.order.id);
    expect(Number(removed.paymentAttempt.Amount)).toBe(originalAmountIrr);

    const continued = await strapi.service("api::cart.cart").finalizeCartToOrder(
      seeded.user.id,
      {
        gateway: "mellat",
        attemptId: first.attemptId,
        quoteHash: first.quote.quoteHash,
      },
    );
    expect(continued.success).toBe(true);
    expect(continued.replayed).toBe(true);
    expect(continued.order.id).toBe(first.result.order.id);
  });
});

describe("issue 6 hold lookup fault injection", () => {
  it("returns a retryable lookup failure, then resumes the original order after restore", async () => {
    const seeded = await seedCart({ stockCount: 1, quantity: 1 });
    const first = await placeGatewayOrder(seeded.user.id, "mellat");
    expect(first.result.success).toBe(true);
    const beforeCart = await strapi.service("api::cart.cart").getUserCart(seeded.user.id);
    const beforeQty = Number(beforeCart.cart_items?.[0]?.Count || 0);
    const beforeAttempt = await snapshotPurchase(first.result.order.id);

    const txMod = distTransactionExecutor();
    const originalRawSql = txMod.runRawSql.bind(txMod);
    let injectHoldLookupFailure = true;
    let holdSqlCount = 0;
    const spy = jest.spyOn(txMod, "runRawSql").mockImplementation(
      async (strapiArg, sql, bindings, trx) => {
        const text = String(sql);
        if (text.includes("reservation_status") && text.includes("reserved_until")) {
          holdSqlCount += 1;
          if (injectHoldLookupFailure) {
            throw new Error("injected hold lookup failure");
          }
        }
        return originalRawSql(strapiArg, sql, bindings, trx);
      },
    );

    try {
      const failed = await strapi.service("api::cart.cart").finalizeCartToOrder(
        seeded.user.id,
        {
          gateway: "mellat",
          attemptId: first.attemptId,
          quoteHash: first.quote.quoteHash,
        },
      );
      expect(failed.success).toBe(false);
      expect(failed.errorCode).toBe("RESERVATION_LOOKUP_FAILED");
      expect(failed.status).toBe(503);

      const afterFailCart = await strapi.service("api::cart.cart").getUserCart(seeded.user.id);
      expect(Number(afterFailCart.cart_items?.[0]?.Count || 0)).toBe(beforeQty);
      expect(await snapshotPurchase(first.result.order.id)).toEqual(beforeAttempt);

      const orders = await strapi.db.query("api::order.order").findMany({
        where: { user: { id: seeded.user.id } },
      });
      expect(orders).toHaveLength(1);

      injectHoldLookupFailure = false;
      const resumed = await strapi.service("api::cart.cart").finalizeCartToOrder(
        seeded.user.id,
        {
          gateway: "mellat",
          attemptId: first.attemptId,
          quoteHash: first.quote.quoteHash,
        },
      );
      expect(resumed.success).toBe(true);
      expect(resumed.replayed).toBe(true);
      expect(resumed.order.id).toBe(first.result.order.id);
    } finally {
      spy.mockRestore();
    }
    expect(holdSqlCount).toBeGreaterThan(0);
  });

  it("does not run old-hold SQL on a fresh checkout without a previous attempt", async () => {
    const seeded = await seedCart({ stockCount: 2, quantity: 1 });
    const txMod = distTransactionExecutor();
    const originalRawSql = txMod.runRawSql.bind(txMod);
    let holdSqlCount = 0;
    const spy = jest.spyOn(txMod, "runRawSql").mockImplementation(
      async (strapiArg, sql, bindings, trx) => {
        const text = String(sql);
        if (text.includes("reservation_status") && text.includes("reserved_until")) {
          holdSqlCount += 1;
        }
        return originalRawSql(strapiArg, sql, bindings, trx);
      },
    );

    try {
      const stock = await checkCartStockOp(strapi, seeded.user.id);
      expect(stock.valid).toBe(true);
      expect(holdSqlCount).toBe(0);

      const created = await placeGatewayOrder(seeded.user.id, "mellat");
      expect(created.result.success).toBe(true);
      expect(created.result.replayed).not.toBe(true);
      expect(holdSqlCount).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
