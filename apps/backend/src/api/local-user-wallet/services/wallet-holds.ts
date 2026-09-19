import type { Strapi } from "@strapi/strapi";
import { isSnappayGatewayValue } from "../../payment-gateway/services/checkout-gateway-availability";

/**
 * Wallet holds: the single mutation path for reserved (not yet spent) credit.
 *
 * ## Money model
 * `local_user_wallets.balance` is the posted balance in IRR. `held_balance` is
 * the part of it committed to a live checkout. Spendable credit is
 * `balance - held_balance`; a capture moves money out of both, a release only
 * out of `held_balance`. Both columns are nullable (Strapi applies `required`
 * and `default` in the entity layer, not in DDL), so every predicate COALESCEs.
 *
 * ## Lock order
 * `orders` → `payment_attempts` → `product_stocks` (ascending id) →
 * `local_user_wallets`. The wallet row is always taken last because it is the
 * one row shared between a customer's concurrent checkouts. Every function here
 * assumes its caller already holds the locks to its left and takes only the
 * wallet lock itself; none of them contacts a provider while holding it.
 *
 * ## Hold state is its own column
 * `payment_attempts.wallet_hold_status` is CAS'd independently of `Status`,
 * which `reconcileOrderPaymentAttempt` rewrites from order state. It is a
 * four-way discriminator, not a boolean:
 *   - `NULL`         a row written before this feature shipped → legacy settlement
 *   - `None`         new-format attempt with no wallet leg
 *   - `DirectDebit`  new-format wallet-only attempt created while holds were off
 *   - `Active`       money is held for this attempt
 *   - `Captured`     the hold has been spent; the ledger row exists
 *   - `Released`     the hold was returned to spendable credit
 */

export type WalletHoldStatus =
  | "None"
  | "DirectDebit"
  | "Active"
  | "Captured"
  | "Released";

export class WalletHoldError extends Error {
  constructor(
    readonly code:
      | "WALLET_INSUFFICIENT_AVAILABLE"
      | "WALLET_HOLD_AMOUNT_MISMATCH"
      | "WALLET_HOLD_NOT_ACTIVE"
      | "WALLET_HOLD_INVALID_AMOUNT"
      | "WALLET_CAPTURE_FAILED"
      | "WALLET_RELEASE_FAILED"
      | "WALLET_MUTATION_FAILED",
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WalletHoldError";
  }
}

export type LockedWallet = {
  walletId: number;
  balanceIrr: number;
  heldIrr: number;
  availableIrr: number;
};

export type WalletAvailability = {
  walletId: number | null;
  balanceIrr: number;
  heldIrr: number;
  /** Spendable now: posted balance minus everything held. */
  availableIrr: number;
  /**
   * Held by one named predecessor attempt that this checkout is allowed to
   * supersede. Reported separately from `availableIrr` — it is not spendable
   * until that attempt is actually superseded, and it is never derived from
   * "every Created hold this customer has".
   */
  reusableIrr: number;
  /**
   * True when the balance could not be read at all. Zeros then mean "unknown",
   * not "empty", and a checkout that wants to spend credit must say so rather
   * than telling the customer to lower an amount they can actually afford.
   */
  degraded?: boolean;
};

const WALLET_TX_UID =
  "api::local-user-wallet-transaction.local-user-wallet-transaction";
const CONTRACT_TX_UID = "api::contract-transaction.contract-transaction";

const toInt = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const assertPositiveInt = (amountIrr: number, label: string): number => {
  if (!Number.isInteger(amountIrr) || amountIrr <= 0) {
    throw new WalletHoldError(
      "WALLET_HOLD_INVALID_AMOUNT",
      `${label} must be a positive integer number of IRR`,
    );
  }
  return amountIrr;
};

/**
 * Locks the caller's wallet row, creating it on first use.
 *
 * Creation is race-safe without a savepoint, which matters: `strapi.db.transaction`
 * in @strapi/database 4.25.21 has no savepoint support (a nested call reuses the
 * same trx through AsyncLocalStorage), so catching a 23505 would poison the whole
 * transaction. Instead the link row is inserted with `ON CONFLICT DO NOTHING`,
 * which blocks on a concurrent inserter and then reports zero rows instead of
 * raising. The loser drops the wallet row it just created — nothing references it
 * yet — and re-reads the winner's row under the same lock.
 */
export async function getOrCreateWalletForUpdate(
  strapi: Strapi,
  userId: number,
  trx: any,
): Promise<LockedWallet> {
  if (!trx?.raw) {
    throw new WalletHoldError(
      "WALLET_MUTATION_FAILED",
      "Wallet mutations require an explicit transaction",
    );
  }

  const read = async (): Promise<LockedWallet | null> => {
    const result = await trx.raw(
      `SELECT w.id, w.balance, w.held_balance
         FROM local_user_wallets w
         JOIN local_user_wallets_user_links l ON l.local_user_wallet_id = w.id
        WHERE l.user_id = ?
        ORDER BY w.id ASC
        LIMIT 1
          FOR UPDATE OF w`,
      [userId],
    );
    const row = result?.rows?.[0];
    if (!row) return null;
    const balanceIrr = toInt(row.balance);
    const heldIrr = toInt(row.held_balance);
    return {
      walletId: Number(row.id),
      balanceIrr,
      heldIrr,
      availableIrr: balanceIrr - heldIrr,
    };
  };

  const existing = await read();
  if (existing) return existing;

  const created = await trx.raw(
    `INSERT INTO local_user_wallets (balance, held_balance, created_at, updated_at)
     VALUES (0, 0, NOW(), NOW())
     RETURNING id`,
  );
  const walletId = Number(created?.rows?.[0]?.id);
  if (!Number.isInteger(walletId) || walletId <= 0) {
    throw new WalletHoldError("WALLET_MUTATION_FAILED", "Wallet row could not be created");
  }

  const linked = await trx.raw(
    `INSERT INTO local_user_wallets_user_links (local_user_wallet_id, user_id)
     VALUES (?, ?)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [walletId, userId],
  );
  if ((linked?.rows || []).length === 0) {
    await trx.raw(`DELETE FROM local_user_wallets WHERE id = ?`, [walletId]);
    const winner = await read();
    if (!winner) {
      throw new WalletHoldError(
        "WALLET_MUTATION_FAILED",
        "Wallet creation lost its race but no owning wallet is visible",
      );
    }
    return winner;
  }

  return { walletId, balanceIrr: 0, heldIrr: 0, availableIrr: 0 };
}

/**
 * Lock-free read for quotes and the customer wallet endpoint.
 *
 * `reusableAttemptId` names the one predecessor checkout this request is
 * entitled to supersede. Its hold is reported as `reusableIrr` and never folded
 * into `availableIrr`: a customer with a live payment in another tab must not
 * see that money as spendable.
 */
/**
 * Whether a payment attempt's wallet hold can be handed back to its owner.
 *
 * Two places need this answer and must never disagree: the quote, which counts
 * a named predecessor's hold as money the customer can spend again, and the
 * supersession, which actually releases it. If the quote were the more generous
 * of the two, it would offer credit the finalize then refuses, and the customer
 * would sit in a 409 loop with no way out.
 *
 * `Created` alone is not proof that nothing is in flight: SnappPay mints a
 * transaction id and a Pending contract transaction the moment the attempt is
 * created, and any attempt with a persisted provider reference has already been
 * shown to a bank. Those funds stay where they are until that payment resolves.
 */
export const isSupersedableHoldRow = (row: {
  status?: unknown;
  gateway?: unknown;
  provider_reference?: unknown;
  wallet_hold_status?: unknown;
}): boolean =>
  row.wallet_hold_status === "Active" &&
  row.status === "Created" &&
  !row.provider_reference &&
  !isSnappayGatewayValue(row.gateway);

export async function readWalletAvailability(
  strapi: Strapi,
  userId: number,
  options: { reusableAttemptId?: string | null } = {},
): Promise<WalletAvailability> {
  try {
    return await readWalletAvailabilityOrThrow(strapi, userId, options);
  } catch (error) {
    // A wallet read must never take down a checkout that is not using the
    // wallet — the same lesson the SnappPay eligibility call taught here. Zeros
    // are also the fail-closed answer for a checkout that *is* using it: the
    // allocation then refuses for insufficient credit rather than proceeding on
    // an unknown balance.
    strapi.log.error(
      `Wallet availability could not be read for user ${userId}: ${String(
        (error as any)?.message || error,
      ).slice(0, 200)}`,
    );
    return {
      walletId: null,
      balanceIrr: 0,
      heldIrr: 0,
      availableIrr: 0,
      reusableIrr: 0,
      degraded: true,
    };
  }
}

async function readWalletAvailabilityOrThrow(
  strapi: Strapi,
  userId: number,
  options: { reusableAttemptId?: string | null },
): Promise<WalletAvailability> {
  const result = await strapi.db.connection.raw(
    `SELECT w.id, w.balance, w.held_balance
       FROM local_user_wallets w
       JOIN local_user_wallets_user_links l ON l.local_user_wallet_id = w.id
      WHERE l.user_id = ?
      ORDER BY w.id ASC
      LIMIT 1`,
    [userId],
  );
  const row = result?.rows?.[0];
  const balanceIrr = toInt(row?.balance);
  const heldIrr = toInt(row?.held_balance);

  let reusableIrr = 0;
  const reusableAttemptId = String(options.reusableAttemptId || "").trim();
  if (reusableAttemptId) {
    const candidate = await strapi.db.connection.raw(
      `SELECT pa.wallet_amount, pa.status, pa.gateway, pa.provider_reference,
              pa.wallet_hold_status
         FROM payment_attempts pa
         JOIN payment_attempts_user_links pul ON pul.payment_attempt_id = pa.id
        WHERE pa.attempt_id = ?
          AND pul.user_id = ?
        LIMIT 1`,
      [reusableAttemptId, userId],
    );
    const candidateRow = candidate?.rows?.[0];
    // Read through the same predicate the release uses, so the quote can never
    // credit money the finalize is going to refuse.
    if (candidateRow && isSupersedableHoldRow(candidateRow)) {
      reusableIrr = Math.max(0, toInt(candidateRow.wallet_amount));
    }
  }

  return {
    walletId: row ? Number(row.id) : null,
    balanceIrr,
    heldIrr,
    availableIrr: balanceIrr - heldIrr,
    reusableIrr,
  };
}

async function readAttemptHold(
  trx: any,
  paymentAttemptId: number,
): Promise<{ status: WalletHoldStatus | null; walletAmountIrr: number } | null> {
  const result = await trx.raw(
    `SELECT wallet_hold_status, wallet_amount FROM payment_attempts WHERE id = ?`,
    [paymentAttemptId],
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  return {
    status: (row.wallet_hold_status as WalletHoldStatus) ?? null,
    walletAmountIrr: toInt(row.wallet_amount),
  };
}

export type HoldOutcome =
  | { outcome: "held"; walletId: number; availableIrr: number }
  | { outcome: "already_active"; walletId: number | null }
  | { outcome: "already_captured" };

/**
 * Commits `amountIrr` of spendable credit to one payment attempt.
 *
 * The attempt row must already be locked by the caller. The CAS on
 * `wallet_hold_status` is what makes a duplicated finalize idempotent: the
 * second request sees `Active` with the same amount and adds nothing.
 */
export async function holdWalletForAttempt(
  strapi: Strapi,
  params: { userId: number; paymentAttemptId: number; amountIrr: number },
  trx: any,
): Promise<HoldOutcome> {
  const amountIrr = assertPositiveInt(params.amountIrr, "Wallet hold amount");

  const claimed = await trx.raw(
    `UPDATE payment_attempts
        SET wallet_hold_status = 'Active',
            wallet_amount = ?,
            wallet_held_at = NOW(),
            wallet_released_at = NULL,
            wallet_release_reason = NULL,
            updated_at = NOW()
      WHERE id = ?
        AND (wallet_hold_status IS NULL OR wallet_hold_status = 'None')
      RETURNING id`,
    [amountIrr, params.paymentAttemptId],
  );

  if ((claimed?.rows || []).length === 0) {
    const current = await readAttemptHold(trx, params.paymentAttemptId);
    if (!current) {
      throw new WalletHoldError(
        "WALLET_MUTATION_FAILED",
        `Payment attempt ${params.paymentAttemptId} disappeared while holding wallet credit`,
      );
    }
    if (current.status === "Active") {
      if (current.walletAmountIrr !== amountIrr) {
        throw new WalletHoldError(
          "WALLET_HOLD_AMOUNT_MISMATCH",
          `Attempt ${params.paymentAttemptId} already holds ${current.walletAmountIrr} IRR, not ${amountIrr}`,
          { heldIrr: current.walletAmountIrr, requestedIrr: amountIrr },
        );
      }
      return { outcome: "already_active", walletId: null };
    }
    if (current.status === "Captured") return { outcome: "already_captured" };
    throw new WalletHoldError(
      "WALLET_HOLD_NOT_ACTIVE",
      `Attempt ${params.paymentAttemptId} cannot take a wallet hold from state ${String(current.status)}`,
      { status: current.status },
    );
  }

  const wallet = await getOrCreateWalletForUpdate(strapi, params.userId, trx);
  const updated = await trx.raw(
    `UPDATE local_user_wallets
        SET held_balance = COALESCE(held_balance, 0) + ?,
            updated_at = NOW()
      WHERE id = ?
        AND COALESCE(balance, 0) - COALESCE(held_balance, 0) >= ?
      RETURNING balance, held_balance`,
    [amountIrr, wallet.walletId, amountIrr],
  );
  if ((updated?.rows || []).length === 0) {
    throw new WalletHoldError(
      "WALLET_INSUFFICIENT_AVAILABLE",
      `Wallet has ${wallet.availableIrr} IRR available, ${amountIrr} IRR requested`,
      { availableIrr: wallet.availableIrr, requestedIrr: amountIrr },
    );
  }

  return {
    outcome: "held",
    walletId: wallet.walletId,
    availableIrr:
      toInt(updated.rows[0].balance) - toInt(updated.rows[0].held_balance),
  };
}

export type CaptureOutcome =
  | { outcome: "captured"; amountIrr: number; reference: string; walletId: number }
  | { outcome: "already_captured"; amountIrr: number; reference: string }
  | { outcome: "none" }
  | { outcome: "not_active"; status: WalletHoldStatus | null };

export const walletOrderLedgerReference = (orderId: number, attemptId: string): string =>
  `wallet-order-${orderId}-${attemptId}`;

/**
 * Spends an active hold: posts the debit, the ledger row and the wallet leg of
 * the contract in the caller's transaction.
 *
 * Must run after the order row is locked and after stock has been consumed, so
 * that the wallet lock stays last in the global order. Returns `not_active`
 * instead of throwing so each settlement writer can raise the error its own
 * rollback/reversal path understands.
 */
export async function captureWalletHoldForAttempt(
  strapi: Strapi,
  params: {
    userId: number;
    paymentAttemptId: number;
    attemptId: string;
    orderId: number;
    contractId: number;
    discountIrr?: number;
  },
  trx: any,
): Promise<CaptureOutcome> {
  const current = await readAttemptHold(trx, params.paymentAttemptId);
  if (!current || current.status === null || current.status === "None") {
    return { outcome: "none" };
  }
  if (current.status === "DirectDebit") {
    return { outcome: "not_active", status: current.status };
  }

  const reference = walletOrderLedgerReference(params.orderId, params.attemptId);
  const claimed = await trx.raw(
    `UPDATE payment_attempts
        SET wallet_hold_status = 'Captured',
            wallet_captured_at = NOW(),
            wallet_ledger_reference_id = ?,
            updated_at = NOW()
      WHERE id = ?
        AND wallet_hold_status = 'Active'
      RETURNING wallet_amount`,
    [reference, params.paymentAttemptId],
  );

  if ((claimed?.rows || []).length === 0) {
    const after = await readAttemptHold(trx, params.paymentAttemptId);
    if (after?.status === "Captured") {
      return {
        outcome: "already_captured",
        amountIrr: after.walletAmountIrr,
        reference,
      };
    }
    return { outcome: "not_active", status: after?.status ?? null };
  }

  const amountIrr = toInt(claimed.rows[0].wallet_amount);
  if (amountIrr <= 0) {
    throw new WalletHoldError(
      "WALLET_CAPTURE_FAILED",
      `Attempt ${params.paymentAttemptId} was Active with a non-positive wallet amount`,
    );
  }

  const wallet = await getOrCreateWalletForUpdate(strapi, params.userId, trx);
  const debited = await trx.raw(
    `UPDATE local_user_wallets
        SET balance = COALESCE(balance, 0) - ?,
            held_balance = COALESCE(held_balance, 0) - ?,
            last_transaction_date = NOW(),
            updated_at = NOW()
      WHERE id = ?
        AND COALESCE(balance, 0) >= ?
        AND COALESCE(held_balance, 0) >= ?
      RETURNING balance`,
    [amountIrr, amountIrr, wallet.walletId, amountIrr, amountIrr],
  );
  if ((debited?.rows || []).length === 0) {
    throw new WalletHoldError(
      "WALLET_CAPTURE_FAILED",
      `Wallet ${wallet.walletId} could not settle a ${amountIrr} IRR hold`,
      { walletId: wallet.walletId, amountIrr },
    );
  }

  await upsertWalletLedgerDebit(strapi, trx, {
    walletId: wallet.walletId,
    amountIrr,
    reference,
  });
  await upsertWalletContractLeg(strapi, trx, {
    contractId: params.contractId,
    amountIrr,
    discountIrr: Math.max(0, toInt(params.discountIrr)),
    reference,
  });

  return { outcome: "captured", amountIrr, reference, walletId: wallet.walletId };
}

/** Insert-once ledger debit. `reference_id` uniqueness is the database backstop. */
export async function upsertWalletLedgerDebit(
  strapi: Strapi,
  trx: any,
  params: { walletId: number; amountIrr: number; reference: string; cause?: string },
): Promise<void> {
  const existing = await strapi.db.query(WALLET_TX_UID).findOne({
    where: { ReferenceId: params.reference },
    select: ["id"],
    transacting: trx,
  } as any);
  if (existing) return;
  await strapi.db.query(WALLET_TX_UID).create({
    data: {
      Amount: params.amountIrr,
      Type: "Minus",
      Date: new Date(),
      Cause: params.cause || "Order Payment",
      ReferenceId: params.reference,
      user_wallet: params.walletId,
    },
    transacting: trx,
  } as any);
}

/**
 * The wallet leg of a split payment.
 *
 * `Type: "Gateway"` so `computePaidAmountToman` counts it towards what the
 * customer paid, and `SettlementGateway: "Wallet"` so the reports attribute it
 * to the wallet rather than to the bank that carried the remainder.
 */
export async function upsertWalletContractLeg(
  strapi: Strapi,
  trx: any,
  params: {
    contractId: number;
    amountIrr: number;
    discountIrr: number;
    reference: string;
  },
): Promise<void> {
  const existing = await strapi.db.query(CONTRACT_TX_UID).findOne({
    where: {
      contract: { id: params.contractId },
      external_source: "Wallet",
      external_id: params.reference,
    },
    select: ["id"],
    transacting: trx,
  } as any);
  if (existing) return;

  let walletGateway: any = await strapi.db
    .query("api::payment-gateway.payment-gateway")
    .findOne({ where: { Title: "Wallet" }, transacting: trx } as any);
  if (!walletGateway) {
    walletGateway = await strapi.db.query("api::payment-gateway.payment-gateway").create({
      data: { Title: "Wallet", IsActive: true, Description: "Infinity wallet balance" },
      transacting: trx,
    } as any);
  }

  await strapi.db.query(CONTRACT_TX_UID).create({
    data: {
      Type: "Gateway",
      Amount: params.amountIrr,
      DiscountAmount: params.discountIrr,
      Step: 1,
      Status: "Success",
      TrackId: params.reference,
      external_id: params.reference,
      external_source: "Wallet",
      SettlementGateway: "Wallet",
      contract: params.contractId,
      payment_gateway: walletGateway.id,
      Date: new Date(),
    },
    transacting: trx,
  } as any);
}

export type ReleaseOutcome =
  | { outcome: "released"; amountIrr: number }
  | { outcome: "skipped"; reason: "no_hold" | "not_active" | "order_settled" };

async function releaseLockedHold(
  strapi: Strapi,
  trx: any,
  params: { paymentAttemptId: number; userId: number; reason: string },
): Promise<ReleaseOutcome> {
  const claimed = await trx.raw(
    `UPDATE payment_attempts
        SET wallet_hold_status = 'Released',
            wallet_released_at = NOW(),
            wallet_release_reason = ?,
            updated_at = NOW()
      WHERE id = ?
        AND wallet_hold_status = 'Active'
      RETURNING wallet_amount`,
    [String(params.reason).slice(0, 255), params.paymentAttemptId],
  );
  if ((claimed?.rows || []).length === 0) {
    return { outcome: "skipped", reason: "not_active" };
  }

  const amountIrr = toInt(claimed.rows[0].wallet_amount);
  if (amountIrr <= 0) return { outcome: "released", amountIrr: 0 };

  const wallet = await getOrCreateWalletForUpdate(strapi, params.userId, trx);
  const updated = await trx.raw(
    `UPDATE local_user_wallets
        SET held_balance = GREATEST(COALESCE(held_balance, 0) - ?, 0),
            updated_at = NOW()
      WHERE id = ?
      RETURNING held_balance`,
    [amountIrr, wallet.walletId],
  );
  if ((updated?.rows || []).length === 0) {
    throw new WalletHoldError(
      "WALLET_RELEASE_FAILED",
      `Wallet ${wallet.walletId} could not release a ${amountIrr} IRR hold`,
    );
  }
  return { outcome: "released", amountIrr };
}

/**
 * Returns every active hold on an order to spendable credit.
 *
 * A release is a hold transition, never a ledger row: nothing was posted, so
 * nothing is reversed. Captured money is refunded through `creditOrderRefund`
 * instead. A paid order is refused outright — an `Active` hold on a `Started`
 * order is an integrity problem for an operator, not something to quietly undo.
 */
export async function releaseWalletHoldsForOrder(
  strapi: Strapi,
  params: { orderId: number; reason: string },
  trx: any,
): Promise<ReleaseOutcome> {
  if (!trx) {
    return strapi.db.transaction(async ({ trx: inner }) =>
      releaseWalletHoldsForOrder(strapi, params, inner),
    );
  }
  if (!trx.raw) {
    // Never retry by opening another transaction: @strapi/database reuses the
    // same trx for a nested `db.transaction`, so that would recurse forever.
    throw new WalletHoldError(
      "WALLET_RELEASE_FAILED",
      "Releasing a wallet hold requires a transaction that can run raw SQL",
    );
  }

  const candidates = await trx.raw(
    `SELECT pa.id, pul.user_id
       FROM payment_attempts pa
       JOIN payment_attempts_order_links pol ON pol.payment_attempt_id = pa.id
       LEFT JOIN payment_attempts_user_links pul ON pul.payment_attempt_id = pa.id
      WHERE pol.order_id = ?
        AND pa.wallet_hold_status = 'Active'
      ORDER BY pa.id ASC`,
    [params.orderId],
  );
  const rows = candidates?.rows || [];
  if (rows.length === 0) return { outcome: "skipped", reason: "no_hold" };

  const order = await trx.raw(`SELECT status FROM orders WHERE id = ?`, [params.orderId]);
  const status = String(order?.rows?.[0]?.status || "");
  if (["Started", "Shipment", "Done"].includes(status)) {
    strapi.log.error(
      `Refusing to release a wallet hold on paid order ${params.orderId} (status ${status}); this needs operator review`,
    );
    return { outcome: "skipped", reason: "order_settled" };
  }

  let releasedIrr = 0;
  for (const row of rows) {
    const userId = Number(row.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new WalletHoldError(
        "WALLET_RELEASE_FAILED",
        `Payment attempt ${row.id} holds wallet credit but has no owner link`,
      );
    }
    const result = await releaseLockedHold(strapi, trx, {
      paymentAttemptId: Number(row.id),
      userId,
      reason: params.reason,
    });
    if (result.outcome === "released") releasedIrr += result.amountIrr;
  }
  return releasedIrr > 0
    ? { outcome: "released", amountIrr: releasedIrr }
    : { outcome: "skipped", reason: "not_active" };
}

/** Releases one named attempt's hold. Used by supersession, which has already CAS'd the attempt. */
export async function releaseWalletHoldForAttempt(
  strapi: Strapi,
  params: { paymentAttemptId: number; userId: number; reason: string },
  trx: any,
): Promise<ReleaseOutcome> {
  return releaseLockedHold(strapi, trx, params);
}

/**
 * Locks an existing wallet without creating one. Returns null when the customer
 * has never had a wallet row — a debit must fail in that case rather than
 * silently opening an empty wallet.
 */
export async function findWalletForUpdate(
  strapi: Strapi,
  userId: number,
  trx: any,
): Promise<LockedWallet | null> {
  if (!trx?.raw) {
    throw new WalletHoldError(
      "WALLET_MUTATION_FAILED",
      "Wallet mutations require an explicit transaction",
    );
  }
  const result = await trx.raw(
    `SELECT w.id, w.balance, w.held_balance
       FROM local_user_wallets w
       JOIN local_user_wallets_user_links l ON l.local_user_wallet_id = w.id
      WHERE l.user_id = ?
      ORDER BY w.id ASC
      LIMIT 1
        FOR UPDATE OF w`,
    [userId],
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  const balanceIrr = toInt(row.balance);
  const heldIrr = toInt(row.held_balance);
  return { walletId: Number(row.id), balanceIrr, heldIrr, availableIrr: balanceIrr - heldIrr };
}

/**
 * Captures the wallet leg of a *gateway* settlement.
 *
 * Called by every provider settlement writer after the order row is locked and
 * the stock reservation is consumed, so the wallet stays last in the lock
 * order. It resolves the attempt's owner and reference itself, so a settlement
 * writer only has to know the attempt id.
 *
 * The outcome is returned rather than thrown: each writer has its own rollback
 * or provider-reversal path and raises the error that path understands.
 */
export async function captureWalletLegForSettlement(
  strapi: Strapi,
  params: { paymentAttemptId: number; orderId: number; contractId: number },
  trx: any,
): Promise<CaptureOutcome> {
  const attempt = await trx.raw(
    `SELECT pa.attempt_id, pa.wallet_hold_status, pa.wallet_amount, pul.user_id
       FROM payment_attempts pa
       LEFT JOIN payment_attempts_user_links pul ON pul.payment_attempt_id = pa.id
      WHERE pa.id = ?
      LIMIT 1`,
    [params.paymentAttemptId],
  );
  const row = attempt?.rows?.[0];
  if (!row) return { outcome: "none" };

  const status = (row.wallet_hold_status as WalletHoldStatus) ?? null;
  if (status === null || status === "None") return { outcome: "none" };
  if (status === "DirectDebit") {
    // A gateway settlement can never legitimately meet a direct-debit attempt:
    // that state only exists for wallet-only payments.
    return { outcome: "not_active", status };
  }

  const userId = Number(row.user_id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new WalletHoldError(
      "WALLET_CAPTURE_FAILED",
      `Payment attempt ${params.paymentAttemptId} holds wallet credit but has no owner link`,
    );
  }

  return captureWalletHoldForAttempt(
    strapi,
    {
      userId,
      paymentAttemptId: params.paymentAttemptId,
      attemptId: String(row.attempt_id || ""),
      orderId: params.orderId,
      contractId: params.contractId,
    },
    trx,
  );
}
