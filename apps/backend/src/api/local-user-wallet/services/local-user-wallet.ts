/**
 * local-user-wallet service
 */

import { factories } from '@strapi/strapi';
import type { Strapi } from "@strapi/strapi";

type WalletBalanceResult = {
  success: boolean;
  newBalance?: number;
  error?: string;
  walletId?: number;
};

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

export default factories.createCoreService('api::local-user-wallet.local-user-wallet');
