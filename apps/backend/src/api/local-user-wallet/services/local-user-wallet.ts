/**
 * local-user-wallet service
 */

import { factories } from '@strapi/strapi';
import type { Strapi } from "@strapi/strapi";
import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "../../../audit/writer";
import {
  findWalletForUpdate,
  getOrCreateWalletForUpdate,
  WalletHoldError,
} from "./wallet-holds";
import type { AuditPrincipal, AuditInitiatorType, AuditActorType, AuditOrigin } from "../../../audit/types";

type WalletBalanceResult = {
  success: boolean;
  newBalance?: number;
  error?: string;
  walletId?: number;
};

export type AdminWalletAdjustmentMode = "credit" | "debit" | "set";

export class WalletAdjustmentError extends Error {
  constructor(
    readonly code:
      | "INSUFFICIENT_BALANCE"
      | "WALLET_MUTATION_FAILED"
      | "INVALID_ADJUSTMENT",
    message: string,
  ) {
    super(message);
    this.name = "WalletAdjustmentError";
  }
}

/**
 * Atomically deduct amount from wallet balance with race condition protection
 * Uses raw SQL UPDATE with WHERE clause to ensure balance doesn't go negative
 * @returns {Promise<{success: boolean, newBalance?: number, error?: string, walletId?: number}>}
 */
/**
 * Atomically deducts posted balance, never dipping into credit that a live
 * checkout has already reserved.
 *
 * The guard is `balance - held_balance >= amount`, not `balance >= amount`:
 * once holds exist, the posted balance includes money that is spoken for, and
 * spending it here would let a customer's second checkout overdraw the first.
 * The guard is unconditional — holds can outlive a flag being switched off.
 */
export async function deductWalletBalanceAtomic(
  strapi: Strapi,
  userId: number,
  amountIrr: number,
  trx?: any,
): Promise<WalletBalanceResult> {
  try {
    const amount = Number(amountIrr);
    if (!Number.isInteger(amount) || amount <= 0) {
      return { success: false, error: "Deduct amount must be positive" };
    }
    if (!trx?.raw) {
      return {
        success: false,
        error: "Wallet debits require an explicit transaction",
      };
    }

    const wallet = await findWalletForUpdate(strapi, userId, trx);
    if (!wallet) {
      return { success: false, error: "Wallet not found for user" };
    }

    const result = await trx.raw(
      `UPDATE local_user_wallets
       SET balance = COALESCE(balance, 0) - ?,
           last_transaction_date = NOW(),
           updated_at = NOW()
       WHERE id = ?
         AND COALESCE(balance, 0) - COALESCE(held_balance, 0) >= ?
       RETURNING balance, id`,
      [amount, wallet.walletId, amount],
    );

    const rows = result.rows || [];
    if (rows.length === 0) {
      return {
        success: false,
        error: `Insufficient balance: requested ${amount} IRR, available ${wallet.availableIrr} IRR`,
        walletId: wallet.walletId,
      };
    }

    return {
      success: true,
      newBalance: Number(rows[0].balance),
      walletId: Number(rows[0].id),
    };
  } catch (error) {
    strapi.log.error(
      `Failed to deduct wallet balance atomically for user ${userId}: ${(error as Error).message}`,
    );
    return {
      success: false,
      error: `Database error: ${(error as Error).message}`,
    };
  }
}

/**
 * Atomically credit amount to wallet balance.
 * Uses raw SQL UPDATE so concurrent credits cannot overwrite each other.
 */
export async function creditWalletBalanceAtomic(
  strapi: Strapi,
  userId: number,
  amountIrr: number,
  trx?: any
): Promise<WalletBalanceResult> {
  try {
    const amount = Number(amountIrr);
    if (!Number.isInteger(amount) || amount <= 0) {
      return { success: false, error: "Credit amount must be positive" };
    }
    if (!trx?.raw) {
      return {
        success: false,
        error: "Wallet credits require an explicit transaction",
      };
    }

    // Race-safe first use: the link row carries a unique index on the owner, so
    // two concurrent first credits converge on one wallet instead of creating
    // two. See getOrCreateWalletForUpdate for why this cannot use a savepoint.
    const wallet = await getOrCreateWalletForUpdate(strapi, userId, trx);

    const result = await trx.raw(
      `UPDATE local_user_wallets
       SET balance = COALESCE(balance, 0) + ?,
           last_transaction_date = NOW(),
           updated_at = NOW()
       WHERE id = ?
       RETURNING balance, id`,
      [amount, wallet.walletId],
    );

    const rows = result.rows || [];
    if (rows.length === 0) {
      return {
        success: false,
        error: "Wallet credit update did not affect any rows",
        walletId: wallet.walletId,
      };
    }

    return {
      success: true,
      newBalance: Number(rows[0].balance),
      walletId: Number(rows[0].id),
    };
  } catch (error) {
    if (error instanceof WalletHoldError) {
      return { success: false, error: `${error.code}: ${error.message}` };
    }
    strapi.log.error(
      `Failed to credit wallet balance atomically for user ${userId}: ${(error as Error).message}`,
    );
    return {
      success: false,
      error: `Database error: ${(error as Error).message}`,
    };
  }
}

export async function applyAdminWalletAdjustment(
  strapi: Strapi,
  params: {
    userId: number;
    mode: AdminWalletAdjustmentMode;
    amountIrr: number;
    reason: string;
    audit: {
      initiator: AuditPrincipal<AuditInitiatorType>;
      actor: AuditPrincipal<AuditActorType>;
      origin: AuditOrigin;
      ip?: string | null;
      userAgent?: string | null;
      requestId?: string | null;
      correlationId?: string | null;
    };
  },
): Promise<{
  walletId: number;
  beforeBalance: number;
  afterBalance: number;
  heldBalance: number;
  delta: number;
  changed: boolean;
  ledgerId: number | null;
  transactionType: "Add" | "Minus" | null;
}> {
  if (
    !Number.isInteger(params.userId) ||
    params.userId <= 0 ||
    !["credit", "debit", "set"].includes(params.mode) ||
    !Number.isInteger(params.amountIrr) ||
    params.amountIrr <= 0
  ) {
    throw new WalletAdjustmentError("INVALID_ADJUSTMENT", "Invalid wallet adjustment");
  }

  return strapi.db.transaction(async ({ trx }) => {
    // One locked read that also creates the wallet on first use. The previous
    // find-then-create could open a second wallet for the same customer under
    // concurrency; the owner-unique link index now makes that impossible.
    const wallet = await getOrCreateWalletForUpdate(strapi, params.userId, trx);

    const beforeBalance = wallet.balanceIrr;
    const heldBalance = wallet.heldIrr;
    const delta =
      params.mode === "credit"
        ? params.amountIrr
        : params.mode === "debit"
          ? -params.amountIrr
          : params.amountIrr - beforeBalance;

    if (delta === 0) {
      await writeAuditEvent(strapi, {
        eventKey: "wallets.adjusted",
        result: "no_op",
        initiator: params.audit.initiator,
        actor: params.audit.actor,
        origin: params.audit.origin,
        target: { type: "customer", id: params.userId, label: `User ${params.userId}` },
        related: { type: "wallet", id: wallet.walletId, label: `Wallet ${wallet.walletId}` },
        changes: [{ field: "balance", label: "موجودی", from: beforeBalance, to: beforeBalance }],
        metadata: { mode: params.mode, amountIrr: params.amountIrr, reason: params.reason },
        requestId: params.audit.requestId,
        correlationId: params.audit.correlationId,
        ip: params.audit.ip,
        userAgent: params.audit.userAgent,
        dedupeKey: `wallet-adjust:no-op:${params.userId}:${params.audit.requestId || randomUUID()}`,
      }, { trx });
      return {
        walletId: wallet.walletId,
        beforeBalance,
        afterBalance: beforeBalance,
        heldBalance,
        delta,
        changed: false,
        ledgerId: null,
        transactionType: null,
      };
    }

    let afterBalance: number;
    let transactionType: "Add" | "Minus";
    if (params.mode === "set") {
      if (params.amountIrr < 0) {
        throw new WalletAdjustmentError(
          "INSUFFICIENT_BALANCE",
          "Wallet balance cannot be negative",
        );
      }
      // Setting the balance below what a live checkout already holds would make
      // held_balance exceed balance — the customer would be able to complete a
      // payment the wallet can no longer fund.
      if (params.amountIrr < heldBalance) {
        throw new WalletAdjustmentError(
          "INSUFFICIENT_BALANCE",
          "مبلغ هدف کمتر از موجودی در حال رزرو است",
        );
      }
      const updated = await trx.raw(
        `UPDATE local_user_wallets
         SET balance = ?, last_transaction_date = NOW(), updated_at = NOW()
         WHERE id = ?
         RETURNING balance`,
        [params.amountIrr, wallet.walletId],
      );
      if (!updated?.rows?.length) {
        throw new WalletAdjustmentError(
          "WALLET_MUTATION_FAILED",
          "Wallet set update did not affect any rows",
        );
      }
      afterBalance = Number(updated.rows[0].balance);
      transactionType = delta > 0 ? "Add" : "Minus";
    } else if (delta > 0) {
      const result = await creditWalletBalanceAtomic(
        strapi,
        params.userId,
        delta,
        trx,
      );
      if (!result.success || result.walletId == null || result.newBalance == null) {
        throw new WalletAdjustmentError(
          "WALLET_MUTATION_FAILED",
          result.error || "Failed to credit wallet",
        );
      }
      afterBalance = Number(result.newBalance);
      transactionType = "Add";
    } else {
      const result = await deductWalletBalanceAtomic(
        strapi,
        params.userId,
        Math.abs(delta),
        trx,
      );
      if (!result.success || result.walletId == null || result.newBalance == null) {
        const insufficient = String(result.error || "").includes("Insufficient");
        throw new WalletAdjustmentError(
          insufficient ? "INSUFFICIENT_BALANCE" : "WALLET_MUTATION_FAILED",
          result.error || "Failed to debit wallet",
        );
      }
      afterBalance = Number(result.newBalance);
      transactionType = "Minus";
    }

    const ledger: any = await strapi.db
      .query("api::local-user-wallet-transaction.local-user-wallet-transaction")
      .create({
        data: {
          Amount: Math.abs(delta),
          Type: transactionType,
          Date: new Date(),
          Cause: "Admin Wallet Adjustment",
          Note: params.reason,
          ReferenceId: `admin-adj-${params.userId}-${randomUUID()}`,
          user_wallet: wallet.walletId,
        },
        transacting: trx,
      } as any);

    await writeAuditEvent(strapi, {
      eventKey: "wallets.adjusted",
      importance: "critical",
      initiator: params.audit.initiator,
      actor: params.audit.actor,
      origin: params.audit.origin,
      target: { type: "customer", id: params.userId, label: `User ${params.userId}` },
      related: { type: "wallet", id: wallet.walletId, label: `Wallet ${wallet.walletId}` },
      changes: [{ field: "balance", label: "موجودی", from: beforeBalance, to: afterBalance }],
      metadata: {
        mode: params.mode,
        amountIrr: params.amountIrr,
        deltaIrr: delta,
        reason: params.reason,
        ledgerId: Number(ledger.id),
        transactionType,
      },
      requestId: params.audit.requestId,
      correlationId: params.audit.correlationId,
      ip: params.audit.ip,
      userAgent: params.audit.userAgent,
      dedupeKey: `wallet-adjust:ledger:${Number(ledger.id)}`,
    }, { trx });

    return {
      walletId: wallet.walletId,
      beforeBalance,
      afterBalance,
      heldBalance,
      delta,
      changed: true,
      ledgerId: Number(ledger.id),
      transactionType,
    };
  });
}

export default factories.createCoreService('api::local-user-wallet.local-user-wallet');
