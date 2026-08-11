import { factories } from "@strapi/strapi";
import type { Strapi } from "@strapi/strapi";
import { creditWalletBalanceAtomic } from "../../local-user-wallet/services/local-user-wallet";
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

export async function findWalletTopupCredit(
  strapi: Strapi,
  saleReferenceId: string,
  trx?: any,
) {
  if (!saleReferenceId) return null;
  return strapi.db.query(WALLET_TX_UID).findOne({
    where: { ReferenceId: saleReferenceId },
    select: ["id"],
    ...(trx ? { transacting: trx } : {}),
  } as any);
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
      `SELECT id, amount, status, sale_reference_id
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

    const existingCredit = await findWalletTopupCredit(
      strapi,
      params.saleReferenceId,
      trx,
    );
    if (existingCredit) {
      await strapi.db.query(TOPUP_UID).update({
        where: { id: params.topupId },
        data: {
          Status: "Success",
          SaleReferenceId: params.saleReferenceId,
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
        ReferenceId: params.saleReferenceId,
        user_wallet: credited.walletId,
      },
      transacting: trx,
    } as any);
    await strapi.db.query(TOPUP_UID).update({
      where: { id: params.topupId },
      data: {
        Status: "Success",
        SaleReferenceId: params.saleReferenceId,
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
        provider: "Mellat",
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
       RETURNING id, sale_order_id, sale_reference_id, reconcile_attempts`,
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
  const rows = await claimDueWalletTopups(strapi, batchSize);
  const paymentService = strapi.service("api::payment-gateway.mellat-v3") as any;
  if (!paymentService) throw new Error("MELLAT_PAYMENT_SERVICE_UNAVAILABLE");

  const stats = { scanned: rows.length, succeeded: 0, failed: 0, unknown: 0 };
  for (const row of rows) {
    const topupId = Number(row.id);
    const saleOrderId = String(row.sale_order_id || "");
    const saleReferenceId = String(row.sale_reference_id || "");
    const attempt = Number(row.reconcile_attempts || 0);
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
