import { factories } from "@strapi/strapi";
import type { Strapi } from "@strapi/strapi";
import { creditWalletBalanceAtomic } from "../../local-user-wallet/services/local-user-wallet";
import {
  initiateTopup,
  isTopupGatewayCode,
  verifyTopup,
  walletTopupLimits,
  type TopupGatewayCode,
} from "./topup-gateways";
import { runRawSql } from "../../../utils/transactionExecutor";
import { writeAuditEvent } from "../../../audit/writer";
import type {
  AuditActorType,
  AuditOrigin,
  AuditPrincipal,
} from "../../../audit/types";

const TOPUP_UID = "api::wallet-topup.wallet-topup";
const WALLET_TX_UID =
  "api::local-user-wallet-transaction.local-user-wallet-transaction";
const PROCESSING_LEASE_MS = 5 * 60 * 1000;
const MAX_RECONCILE_ATTEMPTS = 12;
const BACKOFF_MINUTES = [1, 5, 15, 60, 360] as const;

type WalletTopupAuditExecution = {
  actor: AuditPrincipal<AuditActorType>;
  origin: AuditOrigin;
  requestId?: string | null;
  correlationId?: string | null;
  jobId?: string | number | null;
};

type ProviderResult = {
  success?: boolean;
  resCode?: number;
  error?: string;
};

const providerCode = (result: ProviderResult | null | undefined): number | null => {
  const value = Number(result?.resCode);
  return Number.isFinite(value) ? value : null;
};

export type MellatTopupInquiryAction = "settled" | "settle" | "reversed" | "unknown";

export const classifyMellatTopupInquiry = (
  code: number | null,
): MellatTopupInquiryAction => {
  if (code === 45) return "settled";
  if (code !== null && [0, 43, 46].includes(code)) return "settle";
  if (code === 48) return "reversed";
  return "unknown";
};

export const isMellatTopupSettleConfirmed = (result: ProviderResult): boolean => {
  const code = providerCode(result);
  return result?.success === true || code === 0 || code === 45;
};

const errorMessage = (error: unknown): string =>
  String(error instanceof Error ? error.message : error || "unknown").slice(0, 2_000);

export class WalletTopupIntentError extends Error {
  constructor(
    readonly code:
      | "WALLET_TOPUP_DISABLED"
      | "WALLET_TOPUP_AMOUNT_INVALID"
      | "WALLET_TOPUP_GATEWAY_INVALID"
      | "WALLET_TOPUP_IDEMPOTENCY_CONFLICT"
      | "WALLET_TOPUP_PENDING_LIMIT"
      | "WALLET_TOPUP_REFERENCE_EXHAUSTED",
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WalletTopupIntentError";
  }
}

/**
 * Ledger keys a confirmed top-up may have been posted under.
 *
 * New credits are keyed `wallet-topup-{gateway}-{reference}` so two providers
 * cannot collide on a shared reference format. Rows written before top-ups were
 * multi-gateway used the bare provider reference, so both are checked whenever
 * we ask "has this already been credited?" — otherwise a replayed callback on a
 * legacy row would credit a second time.
 */
export const walletTopupLedgerReferences = (
  gateway: string | null | undefined,
  providerReference: string,
): string[] => {
  const raw = String(providerReference || "").trim();
  if (!raw) return [];
  const code = String(gateway || "").trim();
  return code ? [`wallet-topup-${code}-${raw}`, raw] : [raw];
};

export async function findWalletTopupCredit(
  strapi: Strapi,
  saleReferenceId: string,
  trx?: any,
  gateway?: string | null,
) {
  const references = walletTopupLedgerReferences(gateway, saleReferenceId);
  if (references.length === 0) return null;
  return strapi.db.query(WALLET_TX_UID).findOne({
    where: { ReferenceId: { $in: references } },
    select: ["id", "ReferenceId"],
    ...(trx ? { transacting: trx } : {}),
  } as any);
}

/** Numeric because Mellat's SaleOrderId is a number; unique because it correlates a callback. */
const mintSaleOrderId = (): string =>
  `${Date.now()}${Math.floor(Math.random() * 900) + 100}`;

/**
 * Opens a durable, owner-bound top-up intent before any provider is contacted.
 *
 * Two guarantees, both taken under one per-customer advisory lock so they hold
 * across instances rather than merely within one process:
 *
 *  - **Idempotency.** A client-supplied key, scoped to the owner, returns the
 *    same intent for a repeated submission of the same request, and refuses
 *    outright when the same key arrives with a different amount or gateway. A
 *    disabled button, a rate limit or a pending cap are none of them this
 *    guarantee: they reduce the odds, they do not make the operation singular.
 *  - **The pending cap.** Counting and inserting inside the same lock is what
 *    stops two simultaneous requests from both observing "one below the cap".
 */
export async function createWalletTopupIntent(
  strapi: Strapi,
  params: {
    userId: number;
    amountIrr: number;
    gateway: TopupGatewayCode;
    idempotencyKey?: string | null;
  },
): Promise<{ topup: any; reused: boolean }> {
  const limits = walletTopupLimits();
  const amountIrr = Number(params.amountIrr);
  if (!Number.isInteger(amountIrr) || amountIrr <= 0) {
    throw new WalletTopupIntentError("WALLET_TOPUP_AMOUNT_INVALID", "مبلغ نامعتبر است");
  }
  if (!isTopupGatewayCode(params.gateway)) {
    throw new WalletTopupIntentError("WALLET_TOPUP_GATEWAY_INVALID", "درگاه نامعتبر است");
  }

  const scopedKey = String(params.idempotencyKey || "").trim()
    ? `${params.userId}:${String(params.idempotencyKey).trim()}`
    : null;

  return strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
      `wallet-topup:${params.userId}`,
    ]);

    if (scopedKey) {
      const existing: any = await strapi.db.query(TOPUP_UID).findOne({
        where: { IdempotencyKey: scopedKey },
        transacting: trx,
      } as any);
      if (existing) {
        const sameRequest =
          Number(existing.Amount) === amountIrr &&
          String(existing.Gateway || "") === params.gateway;
        if (!sameRequest) {
          throw new WalletTopupIntentError(
            "WALLET_TOPUP_IDEMPOTENCY_CONFLICT",
            "این درخواست قبلاً با مبلغ یا درگاه دیگری ثبت شده است.",
            { amountIrr: Number(existing.Amount), gateway: existing.Gateway },
          );
        }
        return { topup: existing, reused: true };
      }
    }

    const pending = await trx.raw(
      `SELECT COUNT(*)::int AS count
         FROM wallet_topups t
         JOIN wallet_topups_user_links l ON l.wallet_topup_id = t.id
        WHERE l.user_id = ?
          AND t.status IN ('Pending', 'Processing', 'Unknown')`,
      [params.userId],
    );
    if (Number(pending.rows[0].count) >= limits.maxPending) {
      throw new WalletTopupIntentError(
        "WALLET_TOPUP_PENDING_LIMIT",
        "چند درخواست افزایش موجودی در حال بررسی دارید. لطفاً نتیجه آن‌ها را بررسی کنید.",
        { maxPending: limits.maxPending },
      );
    }

    let saleOrderId = "";
    for (let attempt = 0; attempt < 5 && !saleOrderId; attempt += 1) {
      const candidate = mintSaleOrderId();
      // A second lock on the reference itself makes check-then-insert atomic
      // globally, not just for this customer.
      await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [
        `wallet-topup-sale:${candidate}`,
      ]);
      const taken = await trx.raw(
        `SELECT 1 FROM wallet_topups WHERE sale_order_id = ? LIMIT 1`,
        [candidate],
      );
      if ((taken.rows || []).length === 0) saleOrderId = candidate;
    }
    if (!saleOrderId) {
      throw new WalletTopupIntentError(
        "WALLET_TOPUP_REFERENCE_EXHAUSTED",
        "امکان ایجاد شناسه پرداخت وجود ندارد. لطفاً دوباره تلاش کنید.",
      );
    }

    const topup = await strapi.db.query(TOPUP_UID).create({
      data: {
        Amount: amountIrr,
        Gateway: params.gateway,
        Status: "Pending",
        SaleOrderId: saleOrderId,
        ExpiresAt: new Date(Date.now() + limits.ttlMinutes * 60 * 1000),
        ...(scopedKey ? { IdempotencyKey: scopedKey } : {}),
        user: params.userId,
        Date: new Date(),
      },
      transacting: trx,
    } as any);

    return { topup, reused: false };
  });
}

/**
 * Records the provider handle we will later correlate a callback against.
 *
 * Persisting it is not best-effort: a redirect sent before the handle is
 * durable produces a payable session we cannot recognise on the way back. The
 * caller must treat a failure here as an unknown outcome, never as a refusal.
 */
export async function markWalletTopupRedirected(
  strapi: Strapi,
  params: {
    topupId: number;
    /** The handle a later callback is correlated and verified against, when the provider gives one up front. */
    providerReference?: string | null;
    /** The token that opens the provider's payment page. */
    initiationToken: string;
  },
): Promise<boolean> {
  const result = await runRawSql(
    strapi,
    `UPDATE wallet_topups
        SET provider_reference = COALESCE(provider_reference, ?),
            ref_id = COALESCE(ref_id, ?),
            updated_at = NOW()
      WHERE id = ?
        AND status = 'Pending'
      RETURNING id`,
    [params.providerReference ?? null, params.initiationToken, params.topupId],
  );
  return (result?.rows || []).length === 1;
}

/**
 * Binds the verification handle a provider only reveals on the way back.
 *
 * Saman's callback is the first time we learn the RefNum that its verification
 * API takes. Writing it with a CAS on NULL means a second callback carrying a
 * different RefNum cannot repoint an intent at someone else's transaction.
 */
export async function bindWalletTopupProviderReference(
  strapi: Strapi,
  params: { topupId: number; providerReference: string },
): Promise<boolean> {
  const result = await runRawSql(
    strapi,
    `UPDATE wallet_topups
        SET provider_reference = ?,
            updated_at = NOW()
      WHERE id = ?
        AND (provider_reference IS NULL OR provider_reference = ?)
      RETURNING id`,
    [params.providerReference, params.topupId, params.providerReference],
  );
  return (result?.rows || []).length === 1;
}

/**
 * Grants exactly one caller the right to verify this intent with the provider.
 *
 * Unlike the Mellat-specific claim, this does not require a settlement
 * reference: Saman and ZarinPal only produce one *after* verification, so the
 * lease has to be taken first.
 */
export async function claimWalletTopupForVerification(
  strapi: Strapi,
  topupId: number,
): Promise<boolean> {
  const leaseUntil = new Date(Date.now() + PROCESSING_LEASE_MS);
  const result = await runRawSql(
    strapi,
    `UPDATE wallet_topups
        SET status = 'Processing',
            next_reconcile_at = ?,
            last_provider_error = NULL,
            updated_at = NOW()
      WHERE id = ?
        AND (
          status = 'Pending'
          OR (
            status IN ('Processing', 'Unknown')
            AND next_reconcile_at IS NOT NULL
            AND next_reconcile_at <= NOW()
          )
        )
      RETURNING id`,
    [leaseUntil, topupId],
  );
  return (result?.rows || []).length === 1;
}

/** Owner-scoped lookup used by the customer status endpoint. */
export async function findWalletTopupForOwner(
  strapi: Strapi,
  params: { userId: number; saleOrderId: string },
): Promise<any | null> {
  const rows = await strapi.db.connection.raw(
    `SELECT t.*
       FROM wallet_topups t
       JOIN wallet_topups_user_links l ON l.wallet_topup_id = t.id
      WHERE l.user_id = ? AND t.sale_order_id = ?
      LIMIT 1`,
    [params.userId, params.saleOrderId],
  );
  return rows?.rows?.[0] || null;
}

/** Most recent top-ups for one owner, newest first. */
export async function listWalletTopupsForOwner(
  strapi: Strapi,
  params: { userId: number; limit?: number },
): Promise<any[]> {
  const limit = Math.min(50, Math.max(1, Number(params.limit || 20)));
  const rows = await strapi.db.connection.raw(
    `SELECT t.*
       FROM wallet_topups t
       JOIN wallet_topups_user_links l ON l.wallet_topup_id = t.id
      WHERE l.user_id = ?
      ORDER BY t.id DESC
      LIMIT ?`,
    [params.userId, limit],
  );
  return rows?.rows || [];
}

/**
 * Closes intents the customer never carried to a provider.
 *
 * Only rows that never got a provider handle are cancelled: without one no
 * session can exist, so there is nothing that could still be paid. A row that
 * *does* have a handle keeps its place in the reconciliation ladder however
 * long it has been sitting there — an elapsed local TTL is not evidence about
 * what happened at the bank.
 */
export async function expireAbandonedWalletTopups(
  strapi: Strapi,
  options: { graceMinutes?: number } = {},
): Promise<{ cancelled: number }> {
  const grace = Math.max(0, Number(options.graceMinutes ?? 10));
  const cutoff = new Date(Date.now() - grace * 60 * 1000);
  const result = await runRawSql(
    strapi,
    `UPDATE wallet_topups
        SET status = 'Cancelled',
            next_reconcile_at = NULL,
            last_provider_error = 'Abandoned before the provider was contacted',
            updated_at = NOW()
      WHERE status = 'Pending'
        AND provider_reference IS NULL
        AND ref_id IS NULL
        AND sale_reference_id IS NULL
        AND expires_at IS NOT NULL
        AND expires_at < ?
      RETURNING id`,
    [cutoff],
  );
  return { cancelled: (result?.rows || []).length };
}

export async function claimWalletTopupCallback(
  strapi: Strapi,
  topupId: number,
  saleReferenceId: string,
): Promise<boolean> {
  const leaseUntil = new Date(Date.now() + PROCESSING_LEASE_MS);
  const result = await runRawSql(
    strapi,
    `UPDATE wallet_topups
     SET status = 'Processing',
         sale_reference_id = ?,
         next_reconcile_at = ?,
         last_provider_error = NULL,
         updated_at = NOW()
     WHERE id = ?
       AND (sale_reference_id IS NULL OR sale_reference_id = ?)
       AND (
         status = 'Pending'
         OR (
           status = 'Unknown'
           AND next_reconcile_at IS NOT NULL
           AND next_reconcile_at <= NOW()
         )
       )
     RETURNING id`,
    [saleReferenceId, leaseUntil, topupId, saleReferenceId],
  );
  return (result?.rows || []).length === 1;
}

export async function markWalletTopupUnknown(
  strapi: Strapi,
  params: {
    topupId: number;
    attempt?: number;
    providerCode?: number | null;
    error: unknown;
  },
): Promise<void> {
  const attempt = Math.max(0, Number(params.attempt || 0));
  const nextReconcileAt =
    attempt >= MAX_RECONCILE_ATTEMPTS
      ? null
      : new Date(
          Date.now() +
            BACKOFF_MINUTES[Math.min(Math.max(attempt - 1, 0), BACKOFF_MINUTES.length - 1)] *
              60 *
              1000,
        );
  await runRawSql(
    strapi,
    `UPDATE wallet_topups
     SET status = 'Unknown',
         next_reconcile_at = ?,
         last_provider_code = ?,
         last_provider_error = ?,
         updated_at = NOW()
     WHERE id = ?
       AND status IN ('Pending', 'Processing', 'Unknown')`,
    [
      nextReconcileAt,
      params.providerCode ?? null,
      errorMessage(params.error),
      params.topupId,
    ],
  );
}

export async function markWalletTopupFailed(
  strapi: Strapi,
  params: {
    topupId: number;
    providerCode?: number | null;
    error?: unknown;
    allowedFrom?: Array<"Pending" | "Processing" | "Unknown">;
  },
): Promise<boolean> {
  const allowed = params.allowedFrom || ["Pending"];
  const placeholders = allowed.map(() => "?").join(", ");
  const result = await runRawSql(
    strapi,
    `UPDATE wallet_topups
     SET status = 'Failed',
         next_reconcile_at = NULL,
         last_provider_code = ?,
         last_provider_error = ?,
         updated_at = NOW()
     WHERE id = ?
       AND status IN (${placeholders})
     RETURNING id`,
    [
      params.providerCode ?? null,
      params.error ? errorMessage(params.error) : null,
      params.topupId,
      ...allowed,
    ],
  );
  return (result?.rows || []).length === 1;
}

export async function applyConfirmedWalletTopup(
  strapi: Strapi,
  params: {
    topupId: number;
    saleReferenceId: string;
    providerCode?: number | null;
    audit?: WalletTopupAuditExecution;
  },
): Promise<{ status: "success"; replayed: boolean }> {
  return strapi.db.transaction(async ({ trx }) => {
    const locked = await trx.raw(
      `SELECT id, amount, status, sale_reference_id, gateway
       FROM wallet_topups
       WHERE id = ?
       FOR UPDATE`,
      [params.topupId],
    );
    const row = locked?.rows?.[0];
    if (!row) throw new Error("WALLET_TOPUP_NOT_FOUND");
    const persistedReference = String(row.sale_reference_id || "");
    if (persistedReference && persistedReference !== params.saleReferenceId) {
      throw new Error("WALLET_TOPUP_REFERENCE_MISMATCH");
    }

    const gateway = String(row.gateway || "Mellat");
    const ledgerReferenceId = walletTopupLedgerReferences(gateway, params.saleReferenceId)[0];
    const existingCredit = await findWalletTopupCredit(
      strapi,
      params.saleReferenceId,
      trx,
      gateway,
    );
    if (existingCredit) {
      await strapi.db.query(TOPUP_UID).update({
        where: { id: params.topupId },
        data: {
          Status: "Success",
          SaleReferenceId: params.saleReferenceId,
          LedgerReferenceId: String(existingCredit.ReferenceId || ledgerReferenceId),
          NextReconcileAt: null,
          LastProviderCode: params.providerCode ?? null,
          LastProviderError: null,
        },
        transacting: trx,
      } as any);
      return { status: "success" as const, replayed: true };
    }

    if (String(row.status) === "Success") {
      throw new Error("WALLET_TOPUP_SUCCESS_WITHOUT_LEDGER");
    }
    if (!["Pending", "Processing", "Unknown"].includes(String(row.status))) {
      throw new Error(`WALLET_TOPUP_STATE_CONFLICT:${String(row.status)}`);
    }

    const topup: any = await strapi.db.query(TOPUP_UID).findOne({
      where: { id: params.topupId },
      populate: { user: true },
      transacting: trx,
    } as any);
    const userId = Number(topup?.user?.id || topup?.user);
    const amount = Number(row.amount);
    if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(amount) || amount <= 0) {
      throw new Error("WALLET_TOPUP_INVALID_DURABLE_DATA");
    }

    const credited = await creditWalletBalanceAtomic(strapi, userId, amount, trx);
    if (!credited.success || credited.walletId == null) {
      throw new Error(credited.error || "WALLET_TOPUP_CREDIT_FAILED");
    }
    await strapi.db.query(WALLET_TX_UID).create({
      data: {
        Amount: amount,
        Type: "Add",
        Date: new Date(),
        Cause: "Wallet Topup",
        ReferenceId: ledgerReferenceId,
        user_wallet: credited.walletId,
      },
      transacting: trx,
    } as any);
    await strapi.db.query(TOPUP_UID).update({
      where: { id: params.topupId },
      data: {
        Status: "Success",
        SaleReferenceId: params.saleReferenceId,
        LedgerReferenceId: ledgerReferenceId,
        NextReconcileAt: null,
        LastProviderCode: params.providerCode ?? null,
        LastProviderError: null,
      },
      transacting: trx,
    } as any);
    const afterBalance = Number(credited.newBalance);
    await writeAuditEvent(strapi, {
      eventKey: "payments.webhook_processed",
      result: "success",
      initiator: {
        type: "customer",
        id: userId,
        label: `مشتری #${userId}`,
      },
      actor: params.audit?.actor || {
        type: "system",
        id: "wallet-topup-finalizer",
        label: "سامانه تسویه کیف پول",
      },
      origin: params.audit?.origin || "maintenance",
      target: {
        type: "wallet",
        id: credited.walletId,
        label: `کیف پول مشتری #${userId}`,
      },
      related: {
        type: "wallet_topup",
        id: params.topupId,
        label: `افزایش موجودی #${params.topupId}`,
      },
      changes: [{
        field: "balance",
        label: "موجودی کیف پول (ریال)",
        from: Number.isFinite(afterBalance) ? afterBalance - amount : null,
        to: Number.isFinite(afterBalance) ? afterBalance : null,
      }],
      requestId: params.audit?.requestId,
      correlationId: params.audit?.correlationId,
      jobId: params.audit?.jobId,
      metadata: {
        provider: gateway,
        amountIrr: amount,
        providerReference: params.saleReferenceId,
        providerCode: params.providerCode ?? null,
      },
      dedupeKey: `wallet-topup:${params.topupId}:${params.saleReferenceId}:confirmed`,
      summaryFa: "افزایش موجودی کیف پول توسط درگاه تأیید شد",
      summaryEn: "Wallet top-up confirmed by payment provider",
    }, { trx });
    return { status: "success" as const, replayed: false };
  });
}

async function claimDueWalletTopups(strapi: Strapi, limit: number) {
  const candidates = await strapi.db.connection.raw(
    `SELECT id
     FROM wallet_topups
     WHERE status IN ('Pending', 'Processing', 'Unknown')
       AND sale_reference_id IS NOT NULL
       AND next_reconcile_at IS NOT NULL
       AND next_reconcile_at <= NOW()
     ORDER BY next_reconcile_at ASC, id ASC
     LIMIT ?`,
    [limit],
  );
  const claimed: any[] = [];
  for (const candidate of candidates?.rows || []) {
    const leaseUntil = new Date(Date.now() + PROCESSING_LEASE_MS);
    const result = await strapi.db.connection.raw(
      `UPDATE wallet_topups
       SET status = 'Processing',
           reconcile_attempts = COALESCE(reconcile_attempts, 0) + 1,
           next_reconcile_at = ?,
           updated_at = NOW()
       WHERE id = ?
         AND status IN ('Pending', 'Processing', 'Unknown')
         AND next_reconcile_at IS NOT NULL
         AND next_reconcile_at <= NOW()
       RETURNING id, sale_order_id, sale_reference_id, provider_reference, gateway,
                 amount, reconcile_attempts`,
      [leaseUntil, Number(candidate.id)],
    );
    if (result?.rows?.[0]) claimed.push(result.rows[0]);
  }
  return claimed;
}

export async function reconcileWalletTopups(
  strapi: Strapi,
  options: { batchSize?: number } = {},
) {
  const batchSize = Math.min(100, Math.max(1, Number(options.batchSize || 25)));
  // Folded into the same tick rather than given its own schedule: both are
  // cheap, both are about intents nobody is waiting on, and one cadence is one
  // thing to reason about. Only intents that never reached a provider are
  // closed — see expireAbandonedWalletTopups.
  const expired = await expireAbandonedWalletTopups(strapi).catch((error) => {
    strapi.log.error(`Abandoned wallet top-up sweep failed: ${errorMessage(error)}`);
    return { cancelled: 0 };
  });
  const rows = await claimDueWalletTopups(strapi, batchSize);
  const paymentService = strapi.service("api::payment-gateway.mellat-v3") as any;
  if (!paymentService) throw new Error("MELLAT_PAYMENT_SERVICE_UNAVAILABLE");

  const stats = {
    scanned: rows.length,
    succeeded: 0,
    failed: 0,
    unknown: 0,
    cancelled: expired.cancelled,
  };
  for (const row of rows) {
    const topupId = Number(row.id);
    const saleOrderId = String(row.sale_order_id || "");
    const saleReferenceId = String(row.sale_reference_id || "");
    const gateway = String(row.gateway || "Mellat") as TopupGatewayCode;
    const attempt = Number(row.reconcile_attempts || 0);

    // Saman and ZarinPal expose no separate inquiry: re-running verification is
    // the supported way to learn an outcome, and both treat a repeat of an
    // already-verified transaction as success rather than as a new charge.
    if (gateway !== "Mellat") {
      try {
        const verification = await verifyTopup(strapi, {
          gateway,
          saleOrderId,
          amountIrr: Number(row.amount || 0),
          providerReference: String(row.provider_reference || ""),
          saleReferenceId: saleReferenceId || undefined,
        });
        if (verification.outcome === "confirmed") {
          await applyConfirmedWalletTopup(strapi, {
            topupId,
            saleReferenceId: verification.providerReference,
            providerCode: verification.providerCode,
            audit: {
              actor: {
                type: "background_worker",
                id: "wallet-topup-reconciler",
                label: "پردازشگر تطبیق افزایش موجودی",
              },
              origin: "scheduled_task",
              correlationId: `wallet-topup:${topupId}`,
            },
          });
          stats.succeeded += 1;
        } else if (verification.outcome === "failed") {
          await markWalletTopupFailed(strapi, {
            topupId,
            providerCode: verification.providerCode,
            error: verification.message,
            allowedFrom: ["Pending", "Processing", "Unknown"],
          });
          stats.failed += 1;
        } else {
          await markWalletTopupUnknown(strapi, {
            topupId,
            attempt,
            providerCode: verification.providerCode,
            error: verification.message,
          });
          stats.unknown += 1;
        }
      } catch (error) {
        await markWalletTopupUnknown(strapi, { topupId, attempt, error });
        stats.unknown += 1;
        strapi.log.error(
          `Wallet topup reconciliation failed for ${gateway} topup ${topupId} attempt ${attempt}: ${errorMessage(error)}`,
        );
      }
      continue;
    }

    try {
      const inquiry: ProviderResult = await paymentService.inquiryTransaction({
        orderId: saleOrderId,
        saleOrderId,
        saleReferenceId,
      });
      const inquiryCode = providerCode(inquiry);
      const inquiryAction = classifyMellatTopupInquiry(inquiryCode);
      if (inquiryAction === "reversed") {
        await markWalletTopupFailed(strapi, {
          topupId,
          providerCode: inquiryCode,
          error: "Mellat reports transaction reversed",
          allowedFrom: ["Processing"],
        });
        stats.failed += 1;
        continue;
      }

      if (inquiryAction === "settled") {
        await applyConfirmedWalletTopup(strapi, {
          topupId,
          saleReferenceId,
          providerCode: inquiryCode,
          audit: {
            actor: {
              type: "background_worker",
              id: "wallet-topup-reconciler",
              label: "پردازشگر تطبیق افزایش موجودی",
            },
            origin: "scheduled_task",
            correlationId: `wallet-topup:${topupId}`,
          },
        });
        stats.succeeded += 1;
        continue;
      }

      if (inquiryAction === "settle") {
        const settled: ProviderResult = await paymentService.settleTransaction({
          orderId: saleOrderId,
          saleOrderId,
          saleReferenceId,
          allowResCode45Success: true,
        });
        const settleCode = providerCode(settled);
        if (isMellatTopupSettleConfirmed(settled)) {
          await applyConfirmedWalletTopup(strapi, {
            topupId,
            saleReferenceId,
            providerCode: settleCode,
            audit: {
              actor: {
                type: "background_worker",
                id: "wallet-topup-reconciler",
                label: "پردازشگر تطبیق افزایش موجودی",
              },
              origin: "scheduled_task",
              correlationId: `wallet-topup:${topupId}`,
            },
          });
          stats.succeeded += 1;
          continue;
        }
        await markWalletTopupUnknown(strapi, {
          topupId,
          attempt,
          providerCode: settleCode,
          error: settled?.error || "Mellat settlement remains ambiguous",
        });
        stats.unknown += 1;
        continue;
      }

      await markWalletTopupUnknown(strapi, {
        topupId,
        attempt,
        providerCode: inquiryCode,
        error: inquiry?.error || `Unclassified Mellat inquiry code ${String(inquiryCode)}`,
      });
      stats.unknown += 1;
    } catch (error) {
      await markWalletTopupUnknown(strapi, { topupId, attempt, error });
      stats.unknown += 1;
      strapi.log.error("Wallet topup reconciliation attempt failed", {
        topupId,
        attempt,
        error: errorMessage(error),
      });
    }
  }
  return stats;
}

export default factories.createCoreService(TOPUP_UID);
