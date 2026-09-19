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
import { finalizeGatewaySettlement } from "../../../api/order/controllers/helpers/gatewaySettlement";
import { settleOrderWithWallet } from "../../../api/cart/controllers/handlers/wallet-settlement";
import { claimPaymentAttemptForInitiation } from "../../../api/payment-attempt/services/claim-payment-attempt";
import { releaseOrderReservation } from "../../../utils/stockReservations";
import { refreshWalletReadiness } from "../../../api/local-user-wallet/services/wallet-readiness";
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
  strapi = await setupStrapi();
  await refreshWalletReadiness(strapi);
});

afterAll(async () => {
  await teardownStrapi();
  delete process.env.WALLET_HOLDS_ENABLED;
  delete process.env.WALLET_CHECKOUT_SPLIT_ENABLED;
});

beforeEach(async () => {
  f = makeFactories(strapi);
  // Gateway availability is driven by active `payment_gateways` rows, and a
  // fresh integration database has none. Both tenders this suite uses have to
  // be switched on for the quote to offer a split at all.
  await f.createPaymentGateway({ title: "Wallet", isActive: true });
  await f.createPaymentGateway({ title: "ZarinPal", isActive: true });
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

describe("mixed wallet + gateway checkout", () => {
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
    expect(
      legs.reduce((sum: number, leg: any) => sum + Number(leg.Amount), 0),
    ).toBe(TOTAL_TOMAN * 10);
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
    expect(
      logs.some((log: any) => log?.Changes?.walletPath === "hold"),
    ).toBe(true);
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
    expect(await claimPaymentAttemptForInitiation(strapi, Number(first.result.paymentAttempt.id))).toBe(
      true,
    );

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
});
