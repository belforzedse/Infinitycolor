import type { Strapi } from "@strapi/strapi";
import { consumeOrderReservation } from "../../../../utils/stockReservations";
import { deductWalletBalanceAtomic } from "../../../local-user-wallet/services/local-user-wallet";
import {
  captureWalletHoldForAttempt,
  upsertWalletContractLeg,
  upsertWalletLedgerDebit,
  walletOrderLedgerReference,
  type WalletHoldStatus,
} from "../../../local-user-wallet/services/wallet-holds";
import { confirmReservePaymentForOrder } from "../../../reserve-group/lib/reserve-group";

export class WalletSettlementError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}:${message}`);
    this.name = "WalletSettlementError";
  }
}

/**
 * Settles a wallet-only order in one transaction.
 *
 * ## Lock order
 * `orders` → `payment_attempts` → `product_stocks` → `local_user_wallets`, the
 * same order `finalizeGatewaySettlement` uses. The order row is locked first so
 * that admin cancellation, reservation expiry and this settlement serialize on
 * one row instead of deadlocking against each other; the wallet is touched last
 * because it is the row shared across a customer's concurrent checkouts. Stock
 * is therefore consumed *before* the debit — the previous order (debit, then
 * stock) both broke the global lock order and could debit a customer for an
 * order whose stock consumption then failed.
 *
 * ## Which wallet path runs
 * `wallet_hold_status` is a persisted discriminator, never inferred:
 *   - `Active`       spend the hold that finalize placed (the normal path)
 *   - `Captured`     an earlier settlement already spent it — return it, no debit
 *   - `Released`     the hold was returned; settling now would overdraw
 *   - `DirectDebit`  created while holds were disabled → debit directly
 *   - `NULL`         created before this feature shipped → debit directly
 *   - `None`         a wallet order with no wallet leg: an integrity error
 */
export async function settleOrderWithWallet(
  strapi: Strapi,
  params: {
    userId: number;
    orderId: number;
    contractId: number;
    paymentAttemptId: number;
    attemptId: string;
    totalToman: number;
    discountToman: number;
  },
) {
  const {
    userId,
    orderId,
    contractId,
    paymentAttemptId,
    attemptId,
    totalToman,
    discountToman,
  } = params;
  const totalIrr = Math.round(totalToman) * 10;
  const discountIrr = Math.round(discountToman) * 10;
  const walletReference = walletOrderLedgerReference(orderId, attemptId);

  return strapi.db.transaction(async ({ trx }) => {
    // 1. Order — first in the global lock order.
    const lockedOrder = await trx.raw(
      "SELECT id, status FROM orders WHERE id = ? FOR UPDATE",
      [orderId],
    );
    if ((lockedOrder?.rows || []).length === 0) {
      throw new WalletSettlementError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
    }

    // 2. Payment attempt. Serializes every settlement for this durable attempt
    // before its state is read: locking the wallet alone is insufficient, since
    // a second request can wait for the first debit and then debit again after
    // observing the first ledger entry.
    await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [
      paymentAttemptId,
    ]);
    const currentAttempt: any = await strapi.db
      .query("api::payment-attempt.payment-attempt")
      .findOne({ where: { id: paymentAttemptId }, transacting: trx } as any);
    if (currentAttempt?.Status === "Succeeded") {
      return { success: true, reference: currentAttempt.providerReference };
    }
    if (currentAttempt?.Status !== "Created") {
      throw new WalletSettlementError(
        "PAYMENT_ATTEMPT_NOT_SETTLEABLE",
        String(currentAttempt?.Status || "missing"),
      );
    }

    const holdStatus = (currentAttempt?.WalletHoldStatus ?? null) as WalletHoldStatus | null;
    if (holdStatus === "Released") {
      throw new WalletSettlementError(
        "WALLET_HOLD_RELEASED",
        `Attempt ${paymentAttemptId} no longer holds wallet credit`,
      );
    }
    if (holdStatus === "None") {
      throw new WalletSettlementError(
        "WALLET_HOLD_MISSING",
        `Wallet order ${orderId} has no wallet leg recorded on its attempt`,
      );
    }

    // 3. Stock, before any wallet mutation.
    const consumed = await consumeOrderReservation(strapi, orderId, trx);
    if (consumed.outcome !== "consumed") {
      throw new WalletSettlementError(
        "STOCK_RESERVATION_CONSUME_FAILED",
        consumed.expired ? "expired" : consumed.reason,
      );
    }

    // 4. Wallet — last.
    let newBalance: number | undefined;
    if (holdStatus === "Active" || holdStatus === "Captured") {
      const capture = await captureWalletHoldForAttempt(
        strapi,
        {
          userId,
          paymentAttemptId,
          attemptId,
          orderId,
          contractId,
          discountIrr,
        },
        trx,
      );
      if (capture.outcome === "not_active" || capture.outcome === "none") {
        throw new WalletSettlementError(
          "WALLET_HOLD_NOT_ACTIVE",
          `Attempt ${paymentAttemptId} hold is ${String(
            capture.outcome === "not_active" ? capture.status : "missing",
          )}`,
        );
      }
      if (capture.amountIrr !== totalIrr) {
        throw new WalletSettlementError(
          "WALLET_HOLD_AMOUNT_MISMATCH",
          `Attempt ${paymentAttemptId} holds ${capture.amountIrr} IRR for a ${totalIrr} IRR order`,
        );
      }
    } else {
      // DirectDebit (holds disabled) and NULL (pre-deploy row) both debit
      // directly. Idempotency comes from the ledger reference, which is unique
      // per (order, attempt) and backed by a database index.
      const alreadyPosted = await strapi.db
        .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
        .findOne({ where: { ReferenceId: walletReference }, transacting: trx } as any);
      if (alreadyPosted) {
        throw new WalletSettlementError(
          "WALLET_DEBIT_ALREADY_POSTED",
          `Ledger entry ${walletReference} exists but attempt ${paymentAttemptId} is still Created`,
        );
      }
      const walletResult = await deductWalletBalanceAtomic(strapi, userId, totalIrr, trx);
      if (!walletResult.success || !walletResult.walletId) {
        throw new WalletSettlementError(
          "WALLET_DEBIT_FAILED",
          walletResult.error || "unknown",
        );
      }
      newBalance = walletResult.newBalance;
      await upsertWalletLedgerDebit(strapi, trx, {
        walletId: walletResult.walletId,
        amountIrr: totalIrr,
        reference: walletReference,
      });
      await upsertWalletContractLeg(strapi, trx, {
        contractId,
        amountIrr: totalIrr,
        discountIrr,
        reference: walletReference,
      });
      await trx.raw(
        `UPDATE payment_attempts
            SET wallet_hold_status = 'Captured',
                wallet_amount = ?,
                wallet_captured_at = NOW(),
                wallet_ledger_reference_id = ?,
                updated_at = NOW()
          WHERE id = ?`,
        [totalIrr, walletReference, paymentAttemptId],
      );
    }

    await strapi.db.query("api::contract.contract").update({
      where: { id: contractId },
      data: {
        Status: "Confirmed",
        external_source: "Wallet",
        external_id: walletReference,
      },
      transacting: trx,
    } as any);
    await strapi.db.query("api::order.order").update({
      where: { id: orderId },
      data: {
        Status: "Started",
        PaymentGateway: "Wallet",
        external_source: "Wallet",
        external_id: walletReference,
      },
      transacting: trx,
    } as any);

    // Opens the 48h combined-shipping window on the first paid order, or confirms
    // an already-bound child. No-op for non-reserve orders. Must run on every
    // paid transition: a group left PendingActivation would never get a deadline,
    // never be attachable, and hold its parcel indefinitely.
    await confirmReservePaymentForOrder(strapi as any, Number(orderId), trx);
    await strapi.db.query("api::payment-attempt.payment-attempt").update({
      where: { id: paymentAttemptId },
      data: {
        Status: "Succeeded",
        providerReference: walletReference,
        providerResponse: { walletTransactionReference: walletReference },
        resolvedAt: new Date(),
      },
      transacting: trx,
    } as any);
    await strapi.db.query("api::order-log.order-log").create({
      data: {
        order: orderId,
        Action: "Update",
        Description: "Wallet payment settled atomically",
        Changes: {
          attemptId,
          reference: walletReference,
          walletPath: holdStatus === "Active" || holdStatus === "Captured" ? "hold" : "direct",
        },
      },
      transacting: trx,
    } as any);

    return {
      success: true,
      reference: walletReference,
      ...(newBalance != null ? { newBalance } : {}),
    };
  });
}
