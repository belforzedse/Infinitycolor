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
              (COALESCE(provider_response, '{}'::jsonb)
                - 'pendingDispatch'
                - 'pendingTransactionId') || ?::jsonb,
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

export async function requeueParkedSnappayReconcile(
  strapi: Strapi,
  input: {
    operationId: number;
    attemptId: number;
    metadata: Record<string, unknown>;
    nextRunAt: Date;
  },
): Promise<"requeued" | "running" | "queued" | "missing"> {
  const now = new Date();
  const requeued = await strapi.db.connection.raw(
    `UPDATE payment_operations
        SET status = 'Queued',
            next_run_at = ?,
            metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb,
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
      now,
      input.operationId,
      input.attemptId,
      now,
    ],
  );
  if (firstRow(requeued)) return "requeued";

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
      String(input.metadata.callbackState || ""),
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
