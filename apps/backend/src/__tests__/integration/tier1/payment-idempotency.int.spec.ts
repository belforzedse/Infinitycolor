/**
 * Tier 1 integration suite - payment callback idempotency.
 *
 * Runs against a REAL Strapi + REAL Postgres. Only the external ZarinPal
 * verification seam is mocked; order/contract/transaction persistence and stock
 * reservation consume/release behavior are real.
 */
import { verifyPaymentHandler } from "../../../api/order/controllers/helpers/payment";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

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
  jest.restoreAllMocks();
  await f.cleanup();
});

function zarinpalCallbackCtx(authority: string, status: string = "OK") {
  return {
    request: {
      method: "GET",
      ip: "127.0.0.1",
      query: {
        Authority: authority,
        Status: status,
      },
      body: {},
      header: {
        "content-type": "application/json",
        "user-agent": "jest-integration",
        "x-forwarded-for": "127.0.0.1",
      },
    },
    redirect: jest.fn((url: string) => url),
    badRequest: jest.fn((message: string, payload?: unknown) => ({ message, payload })),
  };
}

function latestRedirect(ctx: ReturnType<typeof zarinpalCallbackCtx>) {
  const calls = ctx.redirect.mock.calls;
  return String(calls[calls.length - 1]?.[0] || "");
}

function mockZarinPalVerify(result: Record<string, unknown>) {
  const zarinpalService = strapi.service("api::payment-gateway.zarinpal") as any;
  return jest.spyOn(zarinpalService, "verifyPayment").mockResolvedValue(result);
}

describe("ZarinPal payment callback idempotency", () => {
  it("verifies a successful callback, confirms records, and consumes reserved stock once", async () => {
    const payable = await f.createPayableOrder({
      amountToman: 250000,
      authority: "ZP_AUTH_SUCCESS",
      items: [{ count: 2, stockCount: 10, stockReserved: 2, perAmount: 125000 }],
    });
    const verifySpy = mockZarinPalVerify({
      success: true,
      alreadyVerified: false,
      code: 100,
      refId: "ZP_REF_SUCCESS",
      gatewayResponse: { data: { code: 100, ref_id: "ZP_REF_SUCCESS" } },
    });
    const ctx = zarinpalCallbackCtx(payable.authority);

    await verifyPaymentHandler(strapi, ctx);

    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy).toHaveBeenCalledWith({
      authority: payable.authority,
      amountToman: payable.amountToman,
    });

    const order = await f.getOrder(payable.order.id);
    const contract = await f.getContract(payable.contract.id);
    const transaction = await f.getContractTransaction(payable.transaction.id);
    const stock = await f.getStock(payable.items[0].stockId);

    expect(order.Status).toBe("Started");
    expect(order.ReservationStatus).toBe("Consumed");
    expect(order.external_source).toBe("ZarinPal");
    expect(order.external_id).toBe("ZP_REF_SUCCESS");
    expect(contract.Status).toBe("Confirmed");
    expect(contract.external_source).toBe("ZarinPal");
    expect(contract.external_id).toBe("ZP_REF_SUCCESS");
    expect(transaction.Status).toBe("Success");
    expect(Number(transaction.Amount)).toBe(payable.amountToman * 10);
    expect(transaction.TrackId).toBe(payable.authority);
    expect(transaction.GatewayAuthority).toBe(payable.authority);
    expect(transaction.GatewayRefId).toBe("ZP_REF_SUCCESS");
    expect(transaction.GatewayStatus).toBe("VERIFIED");
    expect(transaction.external_source).toBe("ZarinPal");
    expect(transaction.external_id).toBe("ZP_REF_SUCCESS");
    expect(transaction.VerifiedAt).toBeTruthy();
    expect(Number(stock.Count)).toBe(8);
    expect(Number(stock.reservedCount)).toBe(0);
    expect(latestRedirect(ctx)).toContain("/payment/success");
    expect(latestRedirect(ctx)).toContain(`orderId=${payable.order.id}`);
    expect(latestRedirect(ctx)).toContain("transactionId=ZP_REF_SUCCESS");
  });

  it("duplicate callback returns success without re-verifying, creating a second success, or consuming stock twice", async () => {
    const payable = await f.createPayableOrder({
      amountToman: 300000,
      authority: "ZP_AUTH_DUPLICATE",
      items: [{ count: 2, stockCount: 10, stockReserved: 2, perAmount: 150000 }],
    });
    const verifySpy = mockZarinPalVerify({
      success: true,
      alreadyVerified: false,
      code: 100,
      refId: "ZP_REF_DUPLICATE",
      gatewayResponse: { data: { code: 100, ref_id: "ZP_REF_DUPLICATE" } },
    });

    await verifyPaymentHandler(strapi, zarinpalCallbackCtx(payable.authority));
    expect(verifySpy).toHaveBeenCalledTimes(1);

    const afterFirstStock = await f.getStock(payable.items[0].stockId);
    expect(Number(afterFirstStock.Count)).toBe(8);
    expect(Number(afterFirstStock.reservedCount)).toBe(0);

    verifySpy.mockClear();
    const replayCtx = zarinpalCallbackCtx(payable.authority);
    await verifyPaymentHandler(strapi, replayCtx);

    expect(verifySpy).not.toHaveBeenCalled();
    const afterReplayStock = await f.getStock(payable.items[0].stockId);
    const order = await f.getOrder(payable.order.id);
    const transactions = await f.getContractTransactions(payable.contract.id);
    const successTransactions = transactions.filter((tx: any) => tx.Status === "Success");

    expect(Number(afterReplayStock.Count)).toBe(8);
    expect(Number(afterReplayStock.reservedCount)).toBe(0);
    expect(order.Status).toBe("Started");
    expect(order.ReservationStatus).toBe("Consumed");
    expect(transactions).toHaveLength(1);
    expect(successTransactions).toHaveLength(1);
    expect(successTransactions[0].id).toBe(payable.transaction.id);
    expect(successTransactions[0].GatewayRefId).toBe("ZP_REF_DUPLICATE");
    expect(latestRedirect(replayCtx)).toContain("/payment/success");
    expect(latestRedirect(replayCtx)).toContain(`orderId=${payable.order.id}`);
  });

  it("marks a verified gateway failure as failed, cancels records, and releases reserved stock", async () => {
    const payable = await f.createPayableOrder({
      amountToman: 200000,
      authority: "ZP_AUTH_FAIL",
      items: [{ count: 2, stockCount: 10, stockReserved: 2, perAmount: 100000 }],
    });
    const verifySpy = mockZarinPalVerify({
      success: false,
      code: -51,
      error: "Authority invalid",
    });
    const ctx = zarinpalCallbackCtx(payable.authority);

    await verifyPaymentHandler(strapi, ctx);

    const order = await f.getOrder(payable.order.id);
    const contract = await f.getContract(payable.contract.id);
    const transaction = await f.getContractTransaction(payable.transaction.id);
    const stock = await f.getStock(payable.items[0].stockId);

    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(order.Status).toBe("Cancelled");
    expect(order.ReservationStatus).toBe("Released");
    expect(contract.Status).toBe("Cancelled");
    expect(transaction.Status).toBe("Failed");
    expect(transaction.GatewayAuthority).toBe(payable.authority);
    expect(transaction.GatewayStatus).toBe("OK");
    expect(transaction.GatewayResponse).toEqual(
      expect.objectContaining({ reason: "Authority invalid" }),
    );
    expect(Number(stock.Count)).toBe(10);
    expect(Number(stock.reservedCount)).toBe(0);
    expect(latestRedirect(ctx)).toContain("/payment/failure");
    expect(latestRedirect(ctx)).toContain(`orderId=${payable.order.id}`);
  });

  it("handles a NOK callback without gateway verification and releases reserved stock", async () => {
    const payable = await f.createPayableOrder({
      amountToman: 180000,
      authority: "ZP_AUTH_NOK",
      items: [{ count: 3, stockCount: 12, stockReserved: 3, perAmount: 60000 }],
    });
    const verifySpy = mockZarinPalVerify({
      success: true,
      code: 100,
      refId: "SHOULD_NOT_BE_USED",
    });
    const ctx = zarinpalCallbackCtx(payable.authority, "NOK");

    await verifyPaymentHandler(strapi, ctx);

    const order = await f.getOrder(payable.order.id);
    const contract = await f.getContract(payable.contract.id);
    const transaction = await f.getContractTransaction(payable.transaction.id);
    const stock = await f.getStock(payable.items[0].stockId);

    expect(verifySpy).not.toHaveBeenCalled();
    expect(order.Status).toBe("Cancelled");
    expect(order.ReservationStatus).toBe("Released");
    expect(contract.Status).toBe("Cancelled");
    expect(transaction.Status).toBe("Failed");
    expect(transaction.GatewayAuthority).toBe(payable.authority);
    expect(transaction.GatewayStatus).toBe("NOK");
    expect(Number(stock.Count)).toBe(12);
    expect(Number(stock.reservedCount)).toBe(0);
    expect(latestRedirect(ctx)).toContain("/payment/cancelled");
    expect(latestRedirect(ctx)).toContain(`orderId=${payable.order.id}`);
    expect(latestRedirect(ctx)).toContain("reason=user-cancelled");
  });
});
