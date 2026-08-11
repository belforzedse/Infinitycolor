import type { Strapi } from "@strapi/strapi";
import { restoreStockAtomic } from "../../../cart/services/lib/stock";
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

export async function creditOrderRefund(
  strapi: Strapi,
  params: {
    userId: number;
    orderId: number;
    contractId: number | null;
    transactions: any[];
    refundToman: number;
    kind: "cancel" | "adjust";
    note?: string;
    trx: any;
  },
): Promise<number | null> {
  const refundIrr = Math.round(Number(params.refundToman) * 10);
  if (refundIrr <= 0) return null;

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
        ReferenceId: `order-${params.orderId}-${params.kind}-${Date.now()}`,
        user_wallet: credit.walletId,
      },
      transacting: params.trx,
    } as any);

  if (!Number.isFinite(Number(params.contractId))) return null;

  const maxStep = (params.transactions || []).reduce(
    (max, transaction) => Math.max(max, Number(transaction?.Step || 0)),
    0,
  );
  const returnTransaction = await strapi.db
    .query("api::contract-transaction.contract-transaction")
    .create({
      data: {
        Type: "Return",
        Amount: refundIrr,
        Step: maxStep + 1,
        Status: "Success",
        external_source: "System",
        contract: Number(params.contractId),
        Date: new Date(),
      },
      transacting: params.trx,
    } as any);

  return Number(returnTransaction.id);
}
