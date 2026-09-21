import type { Strapi } from "@strapi/strapi";

function firstRow(result: { rows?: Array<Record<string, unknown>> } | undefined) {
  return Array.isArray(result?.rows) && result.rows.length === 1 ? result.rows[0] : null;
}

function asJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export async function promoteIssuedSnappayGeneration(
  strapi: Strapi,
  input: {
    attemptId: number;
    transactionId: number;
    contractId: number;
    leaseVersion: number;
    pendingSeq: number;
    pendingTransactionId: string;
    pendingCallbackNonceHash: string;
    paymentToken: string;
    paymentPageUrl: string;
    callbackNonce: string;
    callbackNonceHash: string;
    providerResponse: Record<string, unknown>;
    gatewayResponse: Record<string, unknown>;
    httpStatus?: number;
    providerCode?: number;
    trx?: { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>> }> };
  },
): Promise<{ id: number; provider_response: unknown } | null> {
  const now = new Date();
  const exec = input.trx ?? strapi.db.connection;
  const result = await exec.raw(
    `UPDATE payment_attempts
        SET status = 'Redirected',
            provider_status = 'PENDING',
            provider_reference = ?,
            redirect_url = ?,
            redirected_at = ?,
            next_action = 'await_callback',
            next_action_at = NULL,
            lease_until = NULL,
            failure_code = NULL,
            failure_message = NULL,
            callback_nonce = ?,
            callback_nonce_hash = ?,
            provider_response =
              (COALESCE(provider_response, '{}'::jsonb) || ?::jsonb)
                - 'pendingDispatch'
                - 'pendingTransactionId',
            updated_at = ?
      WHERE id = ?
        AND status <> 'Succeeded'
        AND lease_version = ?
        AND provider_response->'pendingDispatch'->>'seq' = ?
        AND provider_response->'pendingDispatch'->>'transactionId' = ?
        AND provider_response->'pendingDispatch'->>'callbackNonceHash' = ?
      RETURNING id, provider_response`,
    [
      input.pendingTransactionId,
      input.paymentPageUrl,
      now,
      input.callbackNonce,
      input.callbackNonceHash,
      asJson(input.providerResponse),
      now,
      input.attemptId,
      input.leaseVersion,
      String(input.pendingSeq),
      input.pendingTransactionId,
      input.pendingCallbackNonceHash,
    ],
  );
  const attemptRow = firstRow(result);
  if (!attemptRow) return null;

  await exec.raw(
    `UPDATE contract_transactions
        SET track_id = ?,
            external_id = ?,
            gateway_status = 'PENDING',
            gateway_response = ?::jsonb,
            last_http_status = ?,
            last_provider_code = ?,
            updated_at = ?
      WHERE id = ?`,
    [
      input.paymentToken,
      input.pendingTransactionId,
      asJson(input.gatewayResponse),
      Number.isInteger(input.httpStatus) ? input.httpStatus : null,
      Number.isInteger(input.providerCode) ? input.providerCode : null,
      now,
      input.transactionId,
    ],
  );
  await exec.raw(
    `UPDATE contracts
        SET external_id = ?,
            updated_at = ?
      WHERE id = ?`,
    [input.pendingTransactionId, now, input.contractId],
  );
  return {
    id: Number(attemptRow.id),
    provider_response: attemptRow.provider_response,
  };
}

export async function mergeSnappayAttemptObservation(
  strapi: Strapi,
  input: {
    attemptId: number;
    transactionId: number;
    patch: Record<string, unknown>;
    providerStatus?: string;
    generationSeq: number;
    generationTransactionId: string;
    httpStatus?: number;
    providerCode?: number;
    generationTerminalEvidence?: "REVERT" | "CANCEL";
  },
): Promise<boolean> {
  const now = new Date();
  const hasGeneration = input.generationSeq > 0 && Boolean(input.generationTransactionId);
  const terminalEvidence = input.generationTerminalEvidence || null;
  const result = await strapi.db.connection.raw(
    `UPDATE payment_attempts
        SET provider_response =
              CASE
                WHEN ?::text IS NULL THEN COALESCE(provider_response, '{}'::jsonb) || ?::jsonb
                ELSE jsonb_set(
                  COALESCE(provider_response, '{}'::jsonb) || ?::jsonb,
                  '{generation,terminalEvidence}',
                  to_jsonb(?::text),
                  true
                )
              END,
            provider_status = COALESCE(?, provider_status),
            last_reconciled_at = ?,
            updated_at = ?
      WHERE id = ?
        AND status <> 'Succeeded'
        AND (
          (
            provider_response->'generation'->>'seq' = ?
            AND provider_response->'generation'->>'transactionId' = ?
          )
          OR (
            provider_response->'generation' IS NULL
            AND provider_response->'pendingDispatch' IS NULL
            AND provider_reference = ?
          )
        )
      RETURNING id`,
    [
      terminalEvidence,
      asJson(input.patch),
      asJson(input.patch),
      terminalEvidence,
      input.providerStatus || null,
      now,
      now,
      input.attemptId,
      hasGeneration ? String(input.generationSeq) : "",
      hasGeneration ? input.generationTransactionId : "",
      input.generationTransactionId,
    ],
  );
  if (!firstRow(result)) return false;

  await strapi.db.connection.raw(
    `UPDATE contract_transactions
        SET gateway_status = COALESCE(?, gateway_status),
            last_http_status = ?,
            last_provider_code = ?,
            last_reconciled_at = ?,
            gateway_response = ?::jsonb,
            updated_at = ?
      WHERE id = ?`,
    [
      input.providerStatus || null,
      Number.isInteger(input.httpStatus) ? input.httpStatus : null,
      Number.isInteger(input.providerCode) ? input.providerCode : null,
      now,
      asJson(input.patch),
      now,
      input.transactionId,
    ],
  );
  return true;
}

export type SnappayReconcileResume =
  | "requeued"
  | "pulled_forward"
  | "running"
  | "queued"
  | "missing";

export function shouldEnqueueSnappayReconcileResume(
  outcome: SnappayReconcileResume,
): boolean {
  return outcome === "requeued" || outcome === "pulled_forward";
}

export async function requeueParkedSnappayReconcile(
  strapi: Strapi,
  input: {
    operationId: number;
    attemptId: number;
    metadata: Record<string, unknown>;
    nextRunAt: Date;
  },
): Promise<SnappayReconcileResume> {
  const now = new Date();
  const callbackState = String(input.metadata.callbackState || "");
  // Both branches below start a run the reconciliation ladder did not schedule.
  // Stamping that fact is what stops a result-page poll, a sweep deferral tick
  // or a bare-GET return from burning a ladder slot: `scheduleOperationRetry`
  // reschedules a pulled run at the same index instead of advancing it. On
  // production this is why `RECONCILIATION_EXHAUSTED` attempts park after a
  // median of 10 minutes instead of running the intended 5m/40m/3h/12h/24h.
  const pullStamp = `jsonb_build_object(
      'pulledAt', ?::text,
      'pullCount', COALESCE((metadata->>'pullCount')::int, 0) + 1
    )`;
  const requeued = await strapi.db.connection.raw(
    `UPDATE payment_operations
        SET status = 'Queued',
            next_run_at = ?,
            metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb || ${pullStamp},
            updated_at = ?
      WHERE id = ?
        AND attempt_key = ?
        AND operation_type = 'RECONCILE'
        AND status = 'Unknown'
        AND next_run_at IS NULL
        AND (lease_until IS NULL OR lease_until < ?)
      RETURNING id, retry_count`,
    [
      input.nextRunAt,
      asJson(input.metadata),
      now.toISOString(),
      now,
      input.operationId,
      input.attemptId,
      now,
    ],
  );
  if (firstRow(requeued)) return "requeued";

  // A CALLBACK_OK (or customer POST) must not wait out a 5-minute unpaid
  // backoff that was scheduled because an earlier poll ran before the
  // provider had the payment. Processing rows stay untouched so two workers
  // cannot claim the same reconcile.
  const pulledForward = await strapi.db.connection.raw(
    `UPDATE payment_operations
        SET next_run_at = ?,
            metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb || ${pullStamp},
            updated_at = ?
      WHERE id = ?
        AND attempt_key = ?
        AND operation_type = 'RECONCILE'
        AND status = 'Queued'
        AND next_run_at IS NOT NULL
        AND next_run_at > ?
        AND (lease_until IS NULL OR lease_until < ?)
        AND NOT (
          COALESCE(metadata->>'callbackState', '') = 'OK'
          AND ? = 'FAILED'
        )
      RETURNING id, retry_count`,
    [
      input.nextRunAt,
      asJson(input.metadata),
      now.toISOString(),
      now,
      input.operationId,
      input.attemptId,
      now,
      now,
      callbackState,
    ],
  );
  if (firstRow(pulledForward)) return "pulled_forward";

  const annotated = await strapi.db.connection.raw(
    `UPDATE payment_operations
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb,
            updated_at = ?
      WHERE id = ?
        AND attempt_key = ?
        AND operation_type = 'RECONCILE'
        AND status IN ('Queued', 'Processing')
        AND NOT (
          COALESCE(metadata->>'callbackState', '') = 'OK'
          AND ? = 'FAILED'
        )
      RETURNING id, status`,
    [
      asJson(input.metadata),
      now,
      input.operationId,
      input.attemptId,
      callbackState,
    ],
  );
  const row = firstRow(annotated);
  if (!row) return "missing";
  return String(row.status) === "Processing" ? "running" : "queued";
}

export async function mergePreviousGenerationCallback(
  strapi: Strapi,
  input: {
    attemptId: number;
    previousTransactionId: string;
    patch: Record<string, unknown>;
  },
): Promise<boolean> {
  const now = new Date();
  const result = await strapi.db.connection.raw(
    `UPDATE payment_attempts
        SET provider_response = jsonb_set(
              COALESCE(provider_response, '{}'::jsonb),
              '{previousGeneration}',
              COALESCE(provider_response->'previousGeneration', '{}'::jsonb) || ?::jsonb
            ),
            updated_at = ?
      WHERE id = ?
        AND status <> 'Succeeded'
        AND provider_response->'previousGeneration'->>'transactionId' = ?
        AND COALESCE(provider_response->'generation'->>'transactionId', '') <> ?
      RETURNING id`,
    [
      asJson(input.patch),
      now,
      input.attemptId,
      input.previousTransactionId,
      input.previousTransactionId,
    ],
  );
  return Boolean(firstRow(result));
}

/**
 * Stamps an attempt terminal because a *local* timeout ended it, not because
 * the provider said anything.
 *
 * The reservation sweep has always released stock and cancelled the order at
 * the TTL or the deferral ceiling while leaving the attempt in its open
 * `Unknown`/`Redirected` state. That left no durable record that the attempt
 * was over, so nothing downstream could tell "this checkout timed out" from
 * "this checkout is still in flight" — which is why a late provider success on
 * such an order had no handler at all.
 *
 * Marking it `Expired` is what makes the late-success matrix reachable, and it
 * is the reason `acceptSnappayCallback` must route a late callback on a
 * terminal attempt to that matrix in the same change: an `Expired` attempt that
 * still looked open to the callback would be resurrected into `Pending/verify`
 * and verified against an order whose stock is already gone.
 *
 * The CAS refuses to overwrite a settled or already-terminal attempt, so a
 * sweep racing a settlement loses and reports it.
 */
export async function markSnappayAttemptLocallyExpired(
  strapi: Strapi,
  input: {
    attemptId: number;
    /** `local_ttl` (parked attempt at the 30-minute TTL) or `local_ceiling`. */
    reason: "local_ttl" | "local_ceiling";
    trx?: { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>> }> };
  },
): Promise<{
  expired: boolean;
  walletAmountIrr: number;
  gatewayAmountIrr: number;
  providerStatus: string | null;
} | null> {
  const now = new Date();
  const exec = input.trx ?? strapi.db.connection;
  const failureCode =
    input.reason === "local_ceiling"
      ? "SNAPPAY_RESERVATION_CEILING_EXPIRED"
      : "SNAPPAY_RESERVATION_TTL_EXPIRED";
  const result = await exec.raw(
    `UPDATE payment_attempts
        SET status = 'Expired',
            next_action = NULL,
            next_action_at = NULL,
            failure_code = ?,
            failure_message = ?,
            resolved_at = ?,
            updated_at = ?
      WHERE id = ?
        AND status NOT IN ('Succeeded', 'Cancelled', 'Failed', 'Expired')
      RETURNING id, wallet_amount, gateway_amount, provider_status`,
    [
      failureCode,
      input.reason === "local_ceiling"
        ? "The SnappPay reservation ceiling was reached before the provider resolved this payment"
        : "The stock reservation expired while this SnappPay payment was parked for review",
      now,
      now,
      input.attemptId,
    ],
  );
  const row = firstRow(result);
  if (!row) return { expired: false, walletAmountIrr: 0, gatewayAmountIrr: 0, providerStatus: null };
  return {
    expired: true,
    walletAmountIrr: Number(row.wallet_amount || 0),
    gatewayAmountIrr: Number(row.gateway_amount || 0),
    providerStatus: (row.provider_status as string) ?? null,
  };
}
