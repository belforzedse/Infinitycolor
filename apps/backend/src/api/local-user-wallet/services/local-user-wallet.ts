/**
 * local-user-wallet service
 */

import { factories } from '@strapi/strapi';
import type { Strapi } from "@strapi/strapi";
import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "../../../audit/writer";
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

const runRaw = (strapi: Strapi, trx: any, sql: string, bindings: unknown[]) => {
  if (trx?.raw) return trx.raw(sql, bindings);
  return strapi.db.connection.raw(sql, bindings);
};

/**
 * Atomically deduct amount from wallet balance with race condition protection
 * Uses raw SQL UPDATE with WHERE clause to ensure balance doesn't go negative
 * @returns {Promise<{success: boolean, newBalance?: number, error?: string, walletId?: number}>}
 */
export async function deductWalletBalanceAtomic(
  strapi: Strapi,
  userId: number,
  amountIrr: number,
  trx?: any,
): Promise<WalletBalanceResult> {
  try {
    const amount = Number(amountIrr);
    if (amount <= 0) {
      return { success: false, error: "Deduct amount must be positive" };
    }

    // First, get wallet ID for the user
    const wallet = await strapi.db
      .query("api::local-user-wallet.local-user-wallet")
      .findOne({
        where: { user: userId },
        select: ["id"],
        ...(trx ? { transacting: trx } : {}),
      } as any);

    if (!wallet) {
      return { success: false, error: "Wallet not found for user" };
    }

    // Use raw SQL for atomic deduction with balance validation
    // Note: Strapi converts camelCase to snake_case for database columns
    // So "Balance" becomes "balance" and "LastTransactionDate" becomes "last_transaction_date"
    const result = await runRaw(
      strapi,
      trx,
      `UPDATE local_user_wallets
       SET balance = balance - ?,
           last_transaction_date = NOW()
       WHERE id = ? AND balance >= ?
       RETURNING balance, id`,
      [amount, wallet.id, amount]
    );

    // Check if any rows were updated
    const rows = result.rows || [];
    if (rows.length === 0) {
      // No rows updated means insufficient balance
      const currentWallet = await strapi.db
        .query("api::local-user-wallet.local-user-wallet")
        .findOne({
          where: { id: wallet.id },
          ...(trx ? { transacting: trx } : {}),
        } as any);

      return {
        success: false,
        error: `Insufficient balance: requested ${amount} IRR, available ${currentWallet?.Balance || 0} IRR`,
        walletId: wallet.id
      };
    }

    return {
      success: true,
      newBalance: rows[0].balance,
      walletId: rows[0].id
    };
  } catch (error) {
    strapi.log.error("Failed to deduct wallet balance atomically", {
      userId,
      amountIrr,
      error: (error as Error).message,
    });
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
    if (amount <= 0) {
      return { success: false, error: "Credit amount must be positive" };
    }

    let wallet = await strapi.db
      .query("api::local-user-wallet.local-user-wallet")
      .findOne({ where: { user: userId }, select: ["id"], transacting: trx } as any);

    if (!wallet) {
      wallet = await strapi.db
        .query("api::local-user-wallet.local-user-wallet")
        .create({
          data: { user: userId, Balance: 0 },
          transacting: trx,
        } as any);
    }

    const result = await runRaw(
      strapi,
      trx,
      `UPDATE local_user_wallets
       SET balance = balance + ?,
           last_transaction_date = NOW()
       WHERE id = ?
       RETURNING balance, id`,
      [amount, wallet.id]
    );

    const rows = result.rows || [];
    if (rows.length === 0) {
      return {
        success: false,
        error: "Wallet credit update did not affect any rows",
        walletId: wallet.id,
      };
    }

    return {
      success: true,
      newBalance: rows[0].balance,
      walletId: rows[0].id,
    };
  } catch (error) {
    strapi.log.error("Failed to credit wallet balance atomically", {
      userId,
      amountIrr,
      error: (error as Error).message,
    });
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
    let wallet: any = await strapi.db
      .query("api::local-user-wallet.local-user-wallet")
      .findOne({
        where: { user: params.userId },
        select: ["id"],
        transacting: trx,
      } as any);
    if (!wallet) {
      wallet = await strapi.db
        .query("api::local-user-wallet.local-user-wallet")
        .create({
          data: {
            user: params.userId,
            Balance: 0,
            LastTransactionDate: new Date(),
          },
          transacting: trx,
        } as any);
    }

    const locked = await trx.raw(
      "SELECT id, balance FROM local_user_wallets WHERE id = ? FOR UPDATE",
      [Number(wallet.id)],
    );
    const row = locked?.rows?.[0];
    if (!row) {
      throw new WalletAdjustmentError(
        "WALLET_MUTATION_FAILED",
        "Wallet disappeared during adjustment",
      );
    }

    const beforeBalance = Number(row.balance || 0);
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
        related: { type: "wallet", id: wallet.id, label: `Wallet ${wallet.id}` },
        changes: [{ field: "balance", label: "موجودی", from: beforeBalance, to: beforeBalance }],
        metadata: { mode: params.mode, amountIrr: params.amountIrr, reason: params.reason },
        requestId: params.audit.requestId,
        correlationId: params.audit.correlationId,
        ip: params.audit.ip,
        userAgent: params.audit.userAgent,
        dedupeKey: `wallet-adjust:no-op:${params.userId}:${params.audit.requestId || randomUUID()}`,
      }, { trx });
      return {
        walletId: Number(wallet.id),
        beforeBalance,
        afterBalance: beforeBalance,
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
      const updated = await trx.raw(
        `UPDATE local_user_wallets
         SET balance = ?, last_transaction_date = NOW()
         WHERE id = ?
         RETURNING balance`,
        [params.amountIrr, Number(wallet.id)],
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
          user_wallet: Number(wallet.id),
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
      related: { type: "wallet", id: wallet.id, label: `Wallet ${wallet.id}` },
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
      walletId: Number(wallet.id),
      beforeBalance,
      afterBalance,
      delta,
      changed: true,
      ledgerId: Number(ledger.id),
      transactionType,
    };
  });
}

export default factories.createCoreService('api::local-user-wallet.local-user-wallet');
