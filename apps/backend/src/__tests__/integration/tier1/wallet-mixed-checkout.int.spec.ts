/**
 * Mixed tender end to end against a real Postgres: a customer pays part of an
 * order from their wallet and the rest through a bank gateway.
 *
 * The acceptance case is the one in the task: a 1,200,000 toman order, a
 * 500,000 toman wallet, 350,000 chosen from the wallet, 850,000 charged
 * externally, and a final wallet balance of 150,000.
 */
import { createCheckoutQuote } from "../../../api/cart/services/lib/checkout-quote";
import { PaymentAllocationError } from "../../../api/cart/services/lib/payment-allocation";
import { buildWalletCheckoutContext } from "../../../api/cart/services/lib/wallet-checkout";
import { supersedeCheckoutAttempt } from "../../../api/cart/services/lib/checkout-supersede";
import { finalizeGatewaySettlement } from "../../../api/order/controllers/helpers/gatewaySettlement";
import { settleOrderWithWallet } from "../../../api/cart/controllers/handlers/wallet-settlement";
import { claimPaymentAttemptForInitiation } from "../../../api/payment-attempt/services/claim-payment-attempt";
import { releaseOrderReservation } from "../../../utils/stockReservations";
import { refreshWalletReadiness } from "../../../api/local-user-wallet/services/wallet-readiness";
import {
  applySnappayAdminUpdate,
  applySnappayCancellation,
  finalizeSnappaySettlement,
} from "../../../api/payment-gateway/services/snappay-finalization";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";

let strapi: any;
let f: Factories;

const TOTAL_TOMAN = 1_200_000;
const WALLET_TOMAN = 350_000;
const GATEWAY_TOMAN = TOTAL_TOMAN - WALLET_TOMAN;
const START_BALANCE_IRR = 5_000_000; // 500,000 toman

beforeAll(async () => {
  process.env.WALLET_HOLDS_ENABLED = "true";
  process.env.WALLET_CHECKOUT_SPLIT_ENABLED = "true";
  process.env.WALLET_SPLIT_SNAPPAY_ENABLED = "true";
  strapi = await setupStrapi();
  await refreshWalletReadiness(strapi);
});

afterAll(async () => {
  await teardownStrapi();
  delete process.env.WALLET_HOLDS_ENABLED;
  delete process.env.WALLET_CHECKOUT_SPLIT_ENABLED;
  delete process.env.WALLET_SPLIT_SNAPPAY_ENABLED;
});

beforeEach(async () => {
  f = makeFactories(strapi);
  // Gateway availability is driven by active `payment_gateways` rows, and a
  // fresh integration database has none. Both tenders this suite uses have to
  // be switched on for the quote to offer a split at all.
  await f.createPaymentGateway({ title: "Wallet", isActive: true });
  await f.createPaymentGateway({ title: "ZarinPal", isActive: true });
  await f.createPaymentGateway({ title: "SnappPay", isActive: true });
});

afterEach(async () => {
  await f.cleanup();
});

const wallet = async (userId: number) => {
  const result = await strapi.db.connection.raw(
    `SELECT w.id, w.balance, w.held_balance
       FROM local_user_wallets w
       JOIN local_user_wallets_user_links l ON l.local_user_wallet_id = w.id
      WHERE l.user_id = ?`,
    [userId],
  );
  const row = result.rows[0];
  return {
    id: Number(row.id),
    balanceIrr: Number(row.balance),
    heldIrr: Number(row.held_balance),
  };
};

const attemptRow = async (id: number) => {
  const result = await strapi.db.connection.raw(
    `SELECT status, wallet_hold_status, wallet_amount, gateway_amount, amount,
            supersedes_attempt_id
       FROM payment_attempts WHERE id = ?`,
    [id],
  );
  return result.rows[0];
};

async function rememberFinalize(result: any) {
  if (result?.order?.id) {
    f.remember("api::order.order", result.order.id);
    const items = await strapi.db.query("api::order-item.order-item").findMany({
      where: { order: { id: result.order.id } },
    });
    for (const item of items) f.remember("api::order-item.order-item", item.id);
  }
  if (result?.contract?.id) f.remember("api::contract.contract", result.contract.id);
  if (result?.paymentAttempt?.id) {
    f.remember("api::payment-attempt.payment-attempt", result.paymentAttempt.id);
  }
}

async function seedShopper(opts: { balanceIrr?: number; quantity?: number } = {}) {
  const quantity = opts.quantity ?? 1;
  const user = await f.createUser();
  await f.createWallet({
    userId: user.id,
    balanceIrr: opts.balanceIrr ?? START_BALANCE_IRR,
  });
  const product = await f.createProduct({ status: "Active" });
  const variation = await f.createVariation({
    productId: product.id,
    stockCount: 5,
    price: TOTAL_TOMAN / quantity,
  });
  const cart = await f.createCart({ userId: user.id });
  await f.createCartItem({
    cartId: cart.id,
    variationId: variation.id,
    count: quantity,
    price: TOTAL_TOMAN / quantity,
  });
  return { user, variation, cart };
}

async function quoteAndFinalize(
  userId: number,
  opts: {
    attemptId: string;
    walletAmountToman?: number;
    gateway?: string;
    supersedeAttemptId?: string;
  },
) {
  const gateway = opts.gateway ?? "zarinpal";
  const context = await buildWalletCheckoutContext(strapi, userId, {
    selectedGateway: gateway,
    requestedWalletAmount: opts.walletAmountToman,
    supersedeAttemptId: opts.supersedeAttemptId,
  });
  let quote;
  try {
    quote = await createCheckoutQuote(strapi, userId, {
      shippingCost: 0,
      gateway,
      resolveAllocation: context.resolve,
    });
  } catch (error) {
    if (!(error instanceof PaymentAllocationError)) throw error;
    // A refused split is reported at quote time, exactly as the storefront sees
    // it — there is no point letting the shopper reach finalize with an
    // allocation the server has already rejected. Shaped like the handler's
    // response so the assertions are about one observable contract.
    return {
      quote: null,
      context,
      result: {
        success: false,
        status: 409,
        errorCode: error.code,
        message: error.message,
      },
    };
  }
  const result = await strapi.service("api::cart.cart").finalizeCartToOrder(userId, {
    gateway,
    attemptId: opts.attemptId,
    quoteHash: quote.quoteHash,
    shippingCost: 0,
    walletAmountToman: opts.walletAmountToman,
    supersedeAttemptId: opts.supersedeAttemptId,
  });
  await rememberFinalize(result);
  return { quote, result, context };
}

async function settleMixedSnappayOrder(shopper: { user: { id: number } }, attemptName: string) {
  const snappayOrchestrator = strapi.service("api::payment-gateway.snappay-orchestrator");
  const originalEligibility = snappayOrchestrator.checkEligibility;
  snappayOrchestrator.checkEligibility = jest.fn().mockResolvedValue(undefined);
  const { result } = await quoteAndFinalize(shopper.user.id, {
    attemptId: `${attemptName}-${shopper.user.id}`,
    gateway: "snappay",
    walletAmountToman: WALLET_TOMAN,
  }).finally(() => {
    snappayOrchestrator.checkEligibility = originalEligibility;
  });
  expect(result.success).toBe(true);

  const attempt: any = await strapi.db
    .query("api::payment-attempt.payment-attempt")
    .findOne({ where: { id: result.paymentAttempt.id } });
  const providerTx: any = await strapi.db
    .query("api::contract-transaction.contract-transaction")
    .findOne({
      where: {
        contract: { id: result.contract.id },
        external_source: "SnappPay",
      },
    });
  expect(providerTx).toMatchObject({
    Amount: String(GATEWAY_TOMAN * 10),
    SettlementGateway: "SnappPay",
  });

  await strapi.db.query("api::contract-transaction.contract-transaction").update({
    where: { id: providerTx.id },
    data: { GatewayStatus: "SETTLE" },
  });
  await finalizeSnappaySettlement(strapi, {
    attemptId: Number(attempt.id),
    orderId: Number(result.order.id),
    contractId: Number(result.contract.id),
    transactionRowId: Number(providerTx.id),
    transactionId: String(attempt.providerReference),
  });

  return { result, attempt, providerTx };
}

describe("mixed wallet + gateway checkout", () => {
  it("settles wallet + SnappPay and refunds only the wallet-funded leg locally", async () => {
    const shopper = await seedShopper();
    const { result, attempt, providerTx } = await settleMixedSnappayOrder(shopper, "snappay-mixed");

    expect(await wallet(shopper.user.id)).toMatchObject({
      balanceIrr: START_BALANCE_IRR - WALLET_TOMAN * 10,
      heldIrr: 0,
    });

    await applySnappayCancellation(
      strapi,
      {
        attemptId: Number(attempt.id),
        orderId: Number(result.order.id),
        contractId: Number(result.contract.id),
        transactionRowId: Number(providerTx.id),
        transactionId: String(attempt.providerReference),
      },
      "CANCEL",
      "integration refund",
    );

    // SnappPay returns its own financed leg. Infinity credits exactly what the
    // wallet funded — never the whole order — and does it once.
    expect(await wallet(shopper.user.id)).toMatchObject({
      balanceIrr: START_BALANCE_IRR,
      heldIrr: 0,
    });
    const ledger = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { user_wallet: { id: (await wallet(shopper.user.id)).id } } });
    expect(ledger.map((row: any) => [row.Type, Number(row.Amount)])).toEqual(
      expect.arrayContaining([
        ["Minus", WALLET_TOMAN * 10],
        ["Add", WALLET_TOMAN * 10],
      ]),
    );
    expect(ledger.filter((row: any) => row.Type === "Add")).toHaveLength(1);

    const returns = await strapi.db
      .query("api::contract-transaction.contract-transaction")
      .findMany({
        where: { contract: { id: result.contract.id }, Type: "Return" },
      });
    expect(returns).toHaveLength(2);
    expect(
      Object.fromEntries(
        returns.map((transaction: any) => [
          transaction.SettlementGateway,
          Number(transaction.Amount),
        ]),
      ),
    ).toEqual({
      Wallet: WALLET_TOMAN * 10,
      SnappPay: GATEWAY_TOMAN * 10,
    });
  });

  it("allocates a partial SnappPay refund proportionally and credits only that wallet share", async () => {
    const shopper = await seedShopper({ quantity: 2 });
    const { result, attempt, providerTx } = await settleMixedSnappayOrder(
      shopper,
      "snappay-partial",
    );
    const [orderItem]: any[] = await strapi.db
      .query("api::order-item.order-item")
      .findMany({ where: { order: { id: result.order.id } } });

    await applySnappayAdminUpdate(
      strapi,
      {
        attemptId: Number(attempt.id),
        orderId: Number(result.order.id),
        contractId: Number(result.contract.id),
        transactionRowId: Number(providerTx.id),
        transactionId: String(attempt.providerReference),
      },
      {
        changes: [
          {
            orderItemId: Number(orderItem.id),
            oldCount: 2,
            newCount: 1,
            restockDelta: 1,
          },
        ],
        newTotalToman: TOTAL_TOMAN / 2,
        newDiscountToman: 0,
        newShippingToman: 0,
        expectedOldTotalToman: TOTAL_TOMAN,
        reason: "integration partial refund",
        actorId: 1,
        operationId: 77,
      },
    );

    const expectedWalletRefundIrr = (WALLET_TOMAN * 10) / 2;
    const expectedGatewayRefundIrr = (GATEWAY_TOMAN * 10) / 2;
    expect(await wallet(shopper.user.id)).toMatchObject({
      balanceIrr: START_BALANCE_IRR - WALLET_TOMAN * 10 + expectedWalletRefundIrr,
      heldIrr: 0,
    });

    const returns = await strapi.db
      .query("api::contract-transaction.contract-transaction")
      .findMany({
        where: { contract: { id: result.contract.id }, Type: "Return" },
      });
    expect(returns).toHaveLength(2);
    expect(
      Object.fromEntries(
        returns.map((transaction: any) => [
          transaction.SettlementGateway,
          Number(transaction.Amount),
        ]),
      ),
    ).toEqual({
      Wallet: expectedWalletRefundIrr,
      SnappPay: expectedGatewayRefundIrr,
    });
    expect(
      returns.every((transaction: any) => transaction.GatewayResponse?.operationId === 77),
    ).toBe(true);

    const ledger = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { user_wallet: { id: (await wallet(shopper.user.id)).id } } });
    expect(ledger.filter((row: any) => row.Type === "Add")).toEqual([
      expect.objectContaining({ Amount: String(expectedWalletRefundIrr) }),
    ]);
  });

  it("holds the wallet leg, charges the gateway the remainder, and settles both once", async () => {
    const shopper = await seedShopper();

    const { quote, result } = await quoteAndFinalize(shopper.user.id, {
      attemptId: `mixed-${shopper.user.id}`,
      walletAmountToman: WALLET_TOMAN,
    });

    expect(quote.financialSummary.total).toBe(TOTAL_TOMAN);
    expect(quote.paymentAllocation).toMatchObject({
      totalToman: TOTAL_TOMAN,
      walletToman: WALLET_TOMAN,
      gatewayToman: GATEWAY_TOMAN,
      walletAvailableToman: 500_000,
      requiredGateway: "zarinpal",
    });
    expect(result.success).toBe(true);

    // The order total is unchanged: wallet credit is a tender, not a discount.
    expect(Number(result.contract.Amount)).toBe(TOTAL_TOMAN);

    const held = await wallet(shopper.user.id);
    expect(held.balanceIrr).toBe(START_BALANCE_IRR);
    expect(held.heldIrr).toBe(WALLET_TOMAN * 10);

    const attempt = await attemptRow(result.paymentAttempt.id);
    expect(attempt).toMatchObject({
      wallet_hold_status: "Active",
      wallet_amount: String(WALLET_TOMAN * 10),
      gateway_amount: String(GATEWAY_TOMAN * 10),
      amount: String(TOTAL_TOMAN * 10),
    });

    // The bank confirms its leg; settlement spends the hold in the same
    // transaction that consumes stock and starts the order.
    expect(await claimPaymentAttemptForInitiation(strapi, Number(result.paymentAttempt.id))).toBe(
      true,
    );
    const settlement = await finalizeGatewaySettlement(strapi, {
      orderId: Number(result.order.id),
      contractId: Number(result.contract.id),
      paymentAttemptId: Number(result.paymentAttempt.id),
      gateway: "SamanKish",
      contractTransactionData: {
        Amount: GATEWAY_TOMAN * 10,
        external_source: "SamanKish",
        SettlementGateway: "SamanKish",
      },
      auditDescription: "Integration test settlement",
      auditChanges: {},
    });
    expect(settlement.outcome).toBe("settled");

    const after = await wallet(shopper.user.id);
    expect(after.balanceIrr).toBe(150_000 * 10);
    expect(after.heldIrr).toBe(0);

    const ledger = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { user_wallet: { id: after.id } } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ Type: "Minus", Amount: String(WALLET_TOMAN * 10) });

    // Both funding legs are persisted, each attributed to what carried it.
    const legs = await strapi.db
      .query("api::contract-transaction.contract-transaction")
      .findMany({ where: { contract: { id: result.contract.id } } });
    const byGateway = Object.fromEntries(
      legs.map((leg: any) => [leg.SettlementGateway, Number(leg.Amount)]),
    );
    expect(byGateway).toMatchObject({
      Wallet: WALLET_TOMAN * 10,
      SamanKish: GATEWAY_TOMAN * 10,
    });
    expect(legs.reduce((sum: number, leg: any) => sum + Number(leg.Amount), 0)).toBe(
      TOTAL_TOMAN * 10,
    );
  });

  it("settles a wallet-only order through the hold path and replays without a second debit", async () => {
    const shopper = await seedShopper({ balanceIrr: 20_000_000 });

    // No explicit amount: `gateway: "wallet"` means the wallet covers the total.
    const { quote, result } = await quoteAndFinalize(shopper.user.id, {
      attemptId: `wallet-only-${shopper.user.id}`,
      gateway: "wallet",
    });
    expect(quote!.paymentAllocation).toMatchObject({
      walletToman: TOTAL_TOMAN,
      gatewayToman: 0,
      requiredGateway: "wallet",
    });
    expect(result.success).toBe(true);

    // With holds enabled the wallet-only path reserves first, exactly like a
    // split does, instead of debiting straight away.
    expect(await attemptRow(result.paymentAttempt.id)).toMatchObject({
      wallet_hold_status: "Active",
      wallet_amount: String(TOTAL_TOMAN * 10),
      gateway_amount: "0",
    });
    expect((await wallet(shopper.user.id)).heldIrr).toBe(TOTAL_TOMAN * 10);

    const settle = () =>
      settleOrderWithWallet(strapi, {
        userId: Number(shopper.user.id),
        orderId: Number(result.order.id),
        contractId: Number(result.contract.id),
        paymentAttemptId: Number(result.paymentAttempt.id),
        attemptId: `wallet-only-${shopper.user.id}`,
        totalToman: TOTAL_TOMAN,
        discountToman: 0,
      });

    const settlement = await settle();
    expect(settlement.success).toBe(true);

    const after = await wallet(shopper.user.id);
    expect(after.balanceIrr).toBe(20_000_000 - TOTAL_TOMAN * 10);
    expect(after.heldIrr).toBe(0);
    expect(await attemptRow(result.paymentAttempt.id)).toMatchObject({
      status: "Succeeded",
      wallet_hold_status: "Captured",
    });

    // A replayed settlement returns the existing result and posts nothing.
    const replay = await settle();
    expect(replay).toMatchObject({ success: true, reference: settlement.reference });

    const ledger = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .findMany({ where: { user_wallet: { id: after.id } } });
    expect(ledger).toHaveLength(1);

    const unchanged = await wallet(shopper.user.id);
    expect(unchanged.balanceIrr).toBe(after.balanceIrr);
    expect(unchanged.heldIrr).toBe(0);

    const logs = await strapi.db
      .query("api::order-log.order-log")
      .findMany({ where: { order: { id: result.order.id } } });
    expect(logs.some((log: any) => log?.Changes?.walletPath === "hold")).toBe(true);
  });

  it("returns the held credit exactly once when the checkout is released", async () => {
    const shopper = await seedShopper();
    const { result } = await quoteAndFinalize(shopper.user.id, {
      attemptId: `release-${shopper.user.id}`,
      walletAmountToman: WALLET_TOMAN,
    });

    expect((await wallet(shopper.user.id)).heldIrr).toBe(WALLET_TOMAN * 10);

    await releaseOrderReservation(strapi, Number(result.order.id), "Released");
    await releaseOrderReservation(strapi, Number(result.order.id), "Released");

    const after = await wallet(shopper.user.id);
    expect(after.balanceIrr).toBe(START_BALANCE_IRR);
    expect(after.heldIrr).toBe(0);
    expect((await attemptRow(result.paymentAttempt.id)).wallet_hold_status).toBe("Released");
  });

  it("refuses a late gateway success once the reservation and hold are gone", async () => {
    const shopper = await seedShopper();
    const { result } = await quoteAndFinalize(shopper.user.id, {
      attemptId: `late-${shopper.user.id}`,
      walletAmountToman: WALLET_TOMAN,
    });
    await claimPaymentAttemptForInitiation(strapi, Number(result.paymentAttempt.id));
    await releaseOrderReservation(strapi, Number(result.order.id), "Expired");

    await expect(
      finalizeGatewaySettlement(strapi, {
        orderId: Number(result.order.id),
        contractId: Number(result.contract.id),
        paymentAttemptId: Number(result.paymentAttempt.id),
        gateway: "SamanKish",
        contractTransactionData: { Amount: GATEWAY_TOMAN * 10 },
        auditDescription: "late settlement",
        auditChanges: {},
      }),
    ).rejects.toMatchObject({ code: "RESERVATION_NOT_ACTIVE" });

    // The customer's money is intact and untouched — no overdraft, no silent
    // re-seizure of credit that has already gone back to them.
    const after = await wallet(shopper.user.id);
    expect(after.balanceIrr).toBe(START_BALANCE_IRR);
    expect(after.heldIrr).toBe(0);
  });

  it("keeps two independent checkouts of the same customer separate", async () => {
    const shopper = await seedShopper({ balanceIrr: 10_000_000, quantity: 1 });

    const first = await quoteAndFinalize(shopper.user.id, {
      attemptId: `tab-a-${shopper.user.id}`,
      walletAmountToman: 200_000,
    });
    expect(first.result.success).toBe(true);

    // A second, unrelated checkout. It names no predecessor, so the first one
    // must keep its order, its reservation and its wallet hold.
    await f.createCartItem({
      cartId: shopper.cart.id,
      variationId: shopper.variation.id,
      count: 1,
      price: TOTAL_TOMAN,
    });
    const second = await quoteAndFinalize(shopper.user.id, {
      attemptId: `tab-b-${shopper.user.id}`,
      walletAmountToman: 300_000,
    });
    expect(second.result.success).toBe(true);
    expect(Number(second.result.order.id)).not.toBe(Number(first.result.order.id));

    const firstAttempt = await attemptRow(first.result.paymentAttempt.id);
    expect(firstAttempt).toMatchObject({ status: "Created", wallet_hold_status: "Active" });

    const after = await wallet(shopper.user.id);
    expect(after.heldIrr).toBe((200_000 + 300_000) * 10);

    const firstOrder = await strapi.db
      .query("api::order.order")
      .findOne({ where: { id: first.result.order.id } });
    expect(firstOrder).toMatchObject({ Status: "Paying", ReservationStatus: "Reserved" });
  });

  it("releases only the named predecessor, and refuses one already handed to a provider", async () => {
    const shopper = await seedShopper({ balanceIrr: 5_000_000 });

    const first = await quoteAndFinalize(shopper.user.id, {
      attemptId: `old-${shopper.user.id}`,
      walletAmountToman: WALLET_TOMAN,
    });
    expect((await wallet(shopper.user.id)).heldIrr).toBe(WALLET_TOMAN * 10);

    await f.createCartItem({
      cartId: shopper.cart.id,
      variationId: shopper.variation.id,
      count: 1,
      price: TOTAL_TOMAN,
    });

    // Replacing it with a larger wallet amount only fits if the predecessor's
    // hold is genuinely released first.
    const second = await quoteAndFinalize(shopper.user.id, {
      attemptId: `new-${shopper.user.id}`,
      walletAmountToman: 500_000,
      supersedeAttemptId: `old-${shopper.user.id}`,
    });
    expect(second.result.success).toBe(true);

    expect(await attemptRow(first.result.paymentAttempt.id)).toMatchObject({
      status: "Cancelled",
      wallet_hold_status: "Released",
    });
    expect(await attemptRow(second.result.paymentAttempt.id)).toMatchObject({
      wallet_hold_status: "Active",
      supersedes_attempt_id: `old-${shopper.user.id}`,
    });
    const after = await wallet(shopper.user.id);
    expect(after.heldIrr).toBe(5_000_000);
    expect(after.balanceIrr).toBe(5_000_000);
  });

  it("does not let supersession free credit once initiation has claimed the attempt", async () => {
    const shopper = await seedShopper({ balanceIrr: 5_000_000 });
    const first = await quoteAndFinalize(shopper.user.id, {
      attemptId: `inflight-${shopper.user.id}`,
      walletAmountToman: WALLET_TOMAN,
    });

    // Initiation wins the race for the same row.
    expect(
      await claimPaymentAttemptForInitiation(strapi, Number(first.result.paymentAttempt.id)),
    ).toBe(true);

    await f.createCartItem({
      cartId: shopper.cart.id,
      variationId: shopper.variation.id,
      count: 1,
      price: TOTAL_TOMAN,
    });

    const second = await quoteAndFinalize(shopper.user.id, {
      attemptId: `replacement-${shopper.user.id}`,
      walletAmountToman: 500_000,
      supersedeAttemptId: `inflight-${shopper.user.id}`,
    });

    // 500,000 toman cannot be held while 350,000 is still committed to a payment
    // that may be in flight, so the replacement is refused and says why.
    expect(second.result).toMatchObject({
      success: false,
      status: 409,
      errorCode: "WALLET_FUNDS_HELD_BY_PENDING_PAYMENT",
    });
    expect(await attemptRow(first.result.paymentAttempt.id)).toMatchObject({
      status: "Pending",
      wallet_hold_status: "Active",
    });
    expect((await wallet(shopper.user.id)).heldIrr).toBe(WALLET_TOMAN * 10);
  });

  it("never offers credit the release would refuse to hand back", async () => {
    const shopper = await seedShopper({ balanceIrr: 5_000_000 });
    const first = await quoteAndFinalize(shopper.user.id, {
      attemptId: `bound-${shopper.user.id}`,
      walletAmountToman: WALLET_TOMAN,
    });

    // SnappPay is the one gateway whose hold its owner may not reclaim on the
    // checkout path: it mints a transaction id at creation, so no local state
    // proves nothing is in flight, and it keeps reporting PENDING long after
    // the shopper has gone. A quote that looked only at the status would count
    // this hold as reclaimable — and the finalize would then refuse it, leaving
    // the shopper in a 409 loop.
    await strapi.db.connection.raw(
      `UPDATE payment_attempts SET gateway = 'snappay', provider_reference = 'SP-BOUND' WHERE id = ?`,
      [Number(first.result.paymentAttempt.id)],
    );

    const context = await buildWalletCheckoutContext(strapi, shopper.user.id, {
      selectedGateway: "zarinpal",
      requestedWalletAmount: 0,
      supersedeAttemptId: `bound-${shopper.user.id}`,
    });
    expect(context.availability.reusableIrr).toBe(0);

    // And the release agrees: nothing is handed back.
    const outcome = await supersedeCheckoutAttempt(strapi, {
      userId: shopper.user.id,
      attemptId: `bound-${shopper.user.id}`,
      replacementAttemptId: `next-${shopper.user.id}`,
    });
    expect(outcome).toMatchObject({ outcome: "refused", reason: "provider_bound" });
    expect((await wallet(shopper.user.id)).heldIrr).toBe(WALLET_TOMAN * 10);
  });

  it("reclaims the credit of a bank checkout the shopper abandoned at the gateway", async () => {
    const shopper = await seedShopper({ balanceIrr: 5_000_000 });
    const first = await quoteAndFinalize(shopper.user.id, {
      attemptId: `abandoned-${shopper.user.id}`,
      walletAmountToman: WALLET_TOMAN,
    });

    // Exactly where an attempt rests once the shopper has been sent to the bank
    // and pressed back: Redirected, with the reference the gateway handed us.
    // Their payment would have been carried forward through the browser-borne
    // callback, so arriving back here is proof they did not pay.
    await strapi.db.connection.raw(
      `UPDATE payment_attempts
          SET status = 'Redirected', provider_reference = 'ZP-ABANDONED'
        WHERE id = ?`,
      [Number(first.result.paymentAttempt.id)],
    );

    const context = await buildWalletCheckoutContext(strapi, shopper.user.id, {
      selectedGateway: "zarinpal",
      requestedWalletAmount: 0,
      supersedeAttemptId: `abandoned-${shopper.user.id}`,
    });
    expect(context.availability.reusableIrr).toBe(WALLET_TOMAN * 10);

    // The release agrees with the quote, which is the invariant that keeps a
    // shopper out of a 409 loop.
    const outcome = await supersedeCheckoutAttempt(strapi, {
      userId: shopper.user.id,
      attemptId: `abandoned-${shopper.user.id}`,
      replacementAttemptId: `next-${shopper.user.id}`,
    });
    expect(outcome).toMatchObject({ outcome: "superseded", releasedIrr: WALLET_TOMAN * 10 });
    expect((await wallet(shopper.user.id)).heldIrr).toBe(0);
    expect(await attemptRow(Number(first.result.paymentAttempt.id))).toMatchObject({
      status: "Cancelled",
    });
  });

  it("refuses to reclaim an abandoned attempt whose payment has already landed", async () => {
    const shopper = await seedShopper({ balanceIrr: 5_000_000 });
    const first = await quoteAndFinalize(shopper.user.id, {
      attemptId: `landed-${shopper.user.id}`,
      walletAmountToman: WALLET_TOMAN,
    });

    // The callback won the race: settlement CAS'd the same status column this
    // supersession competes on. The money is the bank's problem now, not free
    // credit, and the shopper must be told the payment went through.
    await strapi.db.connection.raw(
      `UPDATE payment_attempts
          SET status = 'Succeeded', provider_reference = 'ZP-LANDED'
        WHERE id = ?`,
      [Number(first.result.paymentAttempt.id)],
    );

    const context = await buildWalletCheckoutContext(strapi, shopper.user.id, {
      selectedGateway: "zarinpal",
      requestedWalletAmount: 0,
      supersedeAttemptId: `landed-${shopper.user.id}`,
    });
    expect(context.availability.reusableIrr).toBe(0);

    const outcome = await supersedeCheckoutAttempt(strapi, {
      userId: shopper.user.id,
      attemptId: `landed-${shopper.user.id}`,
      replacementAttemptId: `next-${shopper.user.id}`,
    });
    expect(outcome).toMatchObject({ outcome: "refused", reason: "in_flight" });
    expect((await wallet(shopper.user.id)).heldIrr).toBe(WALLET_TOMAN * 10);
    expect(await attemptRow(Number(first.result.paymentAttempt.id))).toMatchObject({
      status: "Succeeded",
      wallet_hold_status: "Active",
    });
  });

  it("offers a plain abandoned attempt's credit, and hands it back on demand", async () => {
    const shopper = await seedShopper({ balanceIrr: 5_000_000 });
    await quoteAndFinalize(shopper.user.id, {
      attemptId: `plain-${shopper.user.id}`,
      walletAmountToman: WALLET_TOMAN,
    });

    const context = await buildWalletCheckoutContext(strapi, shopper.user.id, {
      selectedGateway: "zarinpal",
      requestedWalletAmount: 0,
      supersedeAttemptId: `plain-${shopper.user.id}`,
    });
    expect(context.availability.reusableIrr).toBe(WALLET_TOMAN * 10);
    // Spendable is what is free plus what this checkout can reclaim, so the
    // whole balance is offered even though every rial of it is held.
    expect(context.availability.availableIrr + context.availability.reusableIrr).toBe(5_000_000);

    const outcome = await supersedeCheckoutAttempt(strapi, {
      userId: shopper.user.id,
      attemptId: `plain-${shopper.user.id}`,
      replacementAttemptId: `next-${shopper.user.id}`,
    });
    expect(outcome).toMatchObject({ outcome: "superseded", releasedIrr: WALLET_TOMAN * 10 });
    expect((await wallet(shopper.user.id)).heldIrr).toBe(0);
  });

  it("lets a shopper retry a checkout whose hold took their whole balance", async () => {
    // The wallet leg is every rial the shopper has, so once it is held the
    // free balance is zero. A retry must still work: the money the quote is
    // being asked to spend is the money this very attempt is holding.
    const shopper = await seedShopper({ balanceIrr: WALLET_TOMAN * 10 });
    const attemptId = `retry-${shopper.user.id}`;

    const first = await quoteAndFinalize(shopper.user.id, {
      attemptId,
      walletAmountToman: WALLET_TOMAN,
    });
    expect(first.result.success).toBe(true);
    const afterHold = await wallet(shopper.user.id);
    expect(afterHold.heldIrr).toBe(WALLET_TOMAN * 10);
    expect(afterHold.balanceIrr - afterHold.heldIrr).toBe(0);

    // Nothing free: quoting without naming the attempt is correctly refused.
    const blind = await buildWalletCheckoutContext(strapi, shopper.user.id, {
      selectedGateway: "zarinpal",
      requestedWalletAmount: WALLET_TOMAN,
      supersedeAttemptId: null,
    });
    expect(() => blind.resolve(TOTAL_TOMAN)).toThrow(
      expect.objectContaining({ code: "WALLET_FUNDS_HELD_BY_PENDING_PAYMENT" }),
    );

    // Naming it — which is what the storefront sends on a retry, because the
    // stored identity is still this attempt — makes the same amount spendable.
    const retry = await quoteAndFinalize(shopper.user.id, {
      attemptId,
      walletAmountToman: WALLET_TOMAN,
      supersedeAttemptId: attemptId,
    });
    expect(retry.result).toMatchObject({ success: true, replayed: true });
    expect(Number(retry.result.paymentAttempt.id)).toBe(Number(first.result.paymentAttempt.id));

    // One hold, one attempt, nothing debited twice.
    const after = await wallet(shopper.user.id);
    expect(after.heldIrr).toBe(WALLET_TOMAN * 10);
    expect(after.balanceIrr).toBe(WALLET_TOMAN * 10);
  });

  it("refuses to reclaim another customer's hold, however it is named", async () => {
    const owner = await seedShopper({ balanceIrr: 5_000_000 });
    const stranger = await seedShopper({ balanceIrr: 5_000_000 });
    await quoteAndFinalize(owner.user.id, {
      attemptId: `owned-${owner.user.id}`,
      walletAmountToman: WALLET_TOMAN,
    });

    const context = await buildWalletCheckoutContext(strapi, stranger.user.id, {
      selectedGateway: "zarinpal",
      requestedWalletAmount: 0,
      supersedeAttemptId: `owned-${owner.user.id}`,
    });
    expect(context.availability.reusableIrr).toBe(0);

    const outcome = await supersedeCheckoutAttempt(strapi, {
      userId: stranger.user.id,
      attemptId: `owned-${owner.user.id}`,
      replacementAttemptId: `stranger-${stranger.user.id}`,
    });
    expect(outcome).toMatchObject({ outcome: "refused", reason: "not_owner" });
    expect((await wallet(owner.user.id)).heldIrr).toBe(WALLET_TOMAN * 10);
  });
});
