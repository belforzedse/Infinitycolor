import type { Strapi } from "@strapi/strapi";
import { restoreStockAtomic } from "../../../cart/services/lib/stock";
import { randomUUID } from "node:crypto";
import { creditWalletBalanceAtomic } from "../../../local-user-wallet/services/local-user-wallet";

export class OrderChangedConcurrentlyError extends Error {
  readonly code = "ORDER_CHANGED_CONCURRENTLY";

  constructor(message = "Order changed while the operation was in progress") {
    super(message);
    this.name = "OrderChangedConcurrentlyError";
  }
}

export async function lockOrderForAdminMutation(
  trx: any,
  orderId: number,
): Promise<void> {
  const result = await trx.raw(
    "SELECT id FROM orders WHERE id = ? FOR UPDATE",
    [orderId],
  );
  if ((result?.rows || []).length === 0) {
    throw new OrderChangedConcurrentlyError("Order no longer exists");
  }
}

export async function restoreStockWithMandatoryAudit(
  strapi: Strapi,
  params: {
    stockId: number;
    quantity: number;
    orderId: number;
    cause: "Admin Order Cancellation" | "Admin Order Adjustment";
    trx: any;
  },
): Promise<number> {
  const restored = await restoreStockAtomic(
    strapi,
    params.stockId,
    params.quantity,
    params.trx,
  );
  if (!restored.success || restored.newCount == null) {
    throw new Error(restored.error || "RESTORE_STOCK_FAILED");
  }

  await strapi.db.query("api::product-stock-log.product-stock-log").create({
    data: {
      product_stock: params.stockId,
      Count: params.quantity,
      Type: "Add",
      Description: `Stock restored for order #${params.orderId}`,
      Cause: params.cause,
    },
    transacting: params.trx,
  } as any);

  return Number(restored.newCount);
}

/**
 * Splits a refund across the legs that funded the order.
 *
 * Reporting only — the money itself goes to the wallet either way — but it has
 * to be *cumulative*, not per-refund. Rounding each partial refund on its own
 * drifts, and a series of them would never add back up to the original legs.
 * Each call therefore computes the total entitlement at the new cumulative
 * refund and subtracts what previous refunds already allocated, so a full
 * refund always reconciles exactly to `walletIrr + gatewayIrr`.
 */
export function allocateRefundAcrossLegs(params: {
  refundIrr: number;
  priorRefundedIrr: number;
  priorWalletAllocatedIrr: number;
  walletFundingIrr: number;
  totalFundingIrr: number;
}): { walletIrr: number; gatewayIrr: number } {
  const refundIrr = Math.max(0, Math.trunc(params.refundIrr));
  if (refundIrr === 0) return { walletIrr: 0, gatewayIrr: 0 };
  if (params.totalFundingIrr <= 0 || params.walletFundingIrr <= 0) {
    return { walletIrr: 0, gatewayIrr: refundIrr };
  }

  const cumulative = Math.max(0, Math.trunc(params.priorRefundedIrr)) + refundIrr;
  const cappedCumulative = Math.min(cumulative, params.totalFundingIrr);
  const cumulativeWallet = Math.min(
    params.walletFundingIrr,
    Math.floor((cappedCumulative * params.walletFundingIrr) / params.totalFundingIrr),
  );
  const walletIrr = Math.max(
    0,
    Math.min(refundIrr, cumulativeWallet - Math.max(0, Math.trunc(params.priorWalletAllocatedIrr))),
  );
  return { walletIrr, gatewayIrr: refundIrr - walletIrr };
}

/**
 * Reads what actually funded an order, and what previous refunds already gave
 * back, from the contract's own transaction rows.
 */
const readFundingAndRefunds = (transactions: any[]) => {
  let walletFundingIrr = 0;
  let totalFundingIrr = 0;
  let priorRefundedIrr = 0;
  let priorWalletAllocatedIrr = 0;
  let maxStep = 0;

  for (const transaction of transactions || []) {
    const amountIrr = Math.max(0, Math.trunc(Number(transaction?.Amount || 0)));
    const type = String(transaction?.Type || "").toLowerCase();
    maxStep = Math.max(maxStep, Number(transaction?.Step || 0));
    if (type === "gateway" && String(transaction?.Status || "").toLowerCase() !== "failed") {
      totalFundingIrr += amountIrr;
      if (String(transaction?.SettlementGateway || transaction?.external_source || "") === "Wallet") {
        walletFundingIrr += amountIrr;
      }
    } else if (type === "return") {
      priorRefundedIrr += amountIrr;
      priorWalletAllocatedIrr += Math.max(
        0,
        Math.trunc(Number(transaction?.GatewayResponse?.walletLegIrr || 0)),
      );
    }
  }

  return {
    walletFundingIrr,
    totalFundingIrr,
    priorRefundedIrr,
    priorWalletAllocatedIrr,
    maxStep,
  };
};

/**
 * Returns money to the customer's wallet and records the Return leg.
 *
 * The store's refund policy is unchanged: non-SnappPay refunds are store
 * credit. What changed is that the ledger entry is keyed on a durable
 * *operation* identity rather than on a wall clock, so a retried cancellation
 * or adjustment posts once instead of once per attempt. `step{n}` would not do:
 * a retry of the same business operation can see a different step count.
 */
export async function creditOrderRefund(
  strapi: Strapi,
  params: {
    userId: number;
    orderId: number;
    contractId: number | null;
    transactions: any[];
    refundToman: number;
    kind: "cancel" | "adjust";
    /**
     * Identifies the business operation. A cancellation happens at most once per
     * order, so the order is enough; an adjustment needs the caller to name its
     * own operation, and one is generated only as a last resort.
     */
    operationId?: string;
    note?: string;
    trx: any;
  },
): Promise<number | null> {
  const refundIrr = Math.round(Number(params.refundToman) * 10);
  if (refundIrr <= 0) return null;

  const operationId =
    params.kind === "cancel"
      ? "cancel"
      : String(params.operationId || "").trim() || `adjust-${randomUUID()}`;
  const reference = `wallet-refund-order-${params.orderId}-${operationId}`;

  const existing = await strapi.db
    .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
    .findOne({ where: { ReferenceId: reference }, select: ["id"], transacting: params.trx } as any);
  if (existing) {
    // The same operation already paid this out. Re-posting would refund twice.
    strapi.log.info(
      `Refund ${reference} was already credited; treating this as a retransmission`,
    );
    return null;
  }

  const credit = await creditWalletBalanceAtomic(
    strapi,
    params.userId,
    refundIrr,
    params.trx,
  );
  if (!credit.success || credit.walletId == null) {
    throw new Error(credit.error || "WALLET_REFUND_FAILED");
  }

  await strapi.db
    .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
    .create({
      data: {
        Amount: refundIrr,
        Type: "Add",
        Date: new Date(),
        Cause:
          params.kind === "cancel"
            ? "Order Cancelled (Admin)"
            : "Order Adjustment (Admin)",
        Note: params.note || undefined,
        ReferenceId: reference,
        user_wallet: credit.walletId,
      },
      transacting: params.trx,
    } as any);

  if (!Number.isFinite(Number(params.contractId))) return null;

  const funding = readFundingAndRefunds(params.transactions);
  const allocation = allocateRefundAcrossLegs({
    refundIrr,
    priorRefundedIrr: funding.priorRefundedIrr,
    priorWalletAllocatedIrr: funding.priorWalletAllocatedIrr,
    walletFundingIrr: funding.walletFundingIrr,
    totalFundingIrr: funding.totalFundingIrr,
  });

  const returnTransaction = await strapi.db
    .query("api::contract-transaction.contract-transaction")
    .create({
      data: {
        Type: "Return",
        Amount: refundIrr,
        Step: funding.maxStep + 1,
        Status: "Success",
        // The refund is store credit, so the wallet is what carried it. The
        // original funding split is recorded alongside for reporting; it never
        // rewrites the funding rows themselves, which are historical facts.
        external_source: "WalletCredit",
        external_id: reference,
        SettlementGateway: "Wallet",
        GatewayResponse: {
          operationId,
          walletLegIrr: allocation.walletIrr,
          gatewayLegIrr: allocation.gatewayIrr,
        },
        contract: Number(params.contractId),
        Date: new Date(),
      },
      transacting: params.trx,
    } as any);

  return Number(returnTransaction.id);
}
