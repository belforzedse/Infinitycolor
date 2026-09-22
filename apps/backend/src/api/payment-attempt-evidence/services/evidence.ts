import type { Strapi } from "@strapi/strapi";
import { EVIDENCE_TABLE } from "./evidence-database";

export const EVIDENCE_UID = "api::payment-attempt-evidence.payment-attempt-evidence";

export type EvidenceKind =
  | "not_found_read"
  | "not_found_confirmed"
  | "failed_then_not_found"
  | "registered_aged"
  | "registered_reverted"
  | "local_ttl"
  | "local_ceiling"
  | "provider_revert"
  | "provider_cancel"
  | "late_success_observed"
  | "late_success_reverted"
  | "late_success_review"
  | "followup";

export type EvidenceMode = "off" | "shadow" | "enforce";

export type EvidenceDecision =
  | "observed"
  | "would_release"
  | "released"
  | "would_revert"
  | "reverted"
  | "refused_breaker_count"
  | "refused_breaker_value"
  | "refused_single_cap"
  | "refused_prerequisite"
  | "refused_unproven"
  | "review";

/** The decisions that actually moved money or stock. */
export const TERMINAL_DECISIONS: EvidenceDecision[] = ["released", "reverted"];

/**
 * The decisions a shadow run produces that a follow-up probe must later check.
 * `review` is included because a parked late-success case is exactly the kind of
 * row an operator needs a second reading for.
 */
export const FOLLOWUP_DECISIONS: EvidenceDecision[] = ["would_release", "would_revert", "review"];

/** Evidence kinds that belong to each mode-gated recovery path. */
export const NOT_FOUND_KINDS: EvidenceKind[] = [
  "not_found_read",
  "not_found_confirmed",
  "failed_then_not_found",
];
export const REGISTERED_KINDS: EvidenceKind[] = ["registered_aged", "registered_reverted"];
export const LATE_SUCCESS_KINDS: EvidenceKind[] = [
  "late_success_observed",
  "late_success_reverted",
  "late_success_review",
];

export type EvidenceRow = {
  attemptId: number;
  orderId?: number | null;
  kind: EvidenceKind;
  mode: EvidenceMode;
  decision: EvidenceDecision;
  providerHost?: string | null;
  clientIdFingerprint?: string | null;
  tokenFingerprint?: string | null;
  generationSeq?: number | null;
  httpStatus?: number | null;
  providerCode?: number | null;
  providerStatus?: string | null;
  callbackState?: string | null;
  tokenAgeMs?: number | null;
  walletAmountIrr?: number | null;
  gatewayAmountIrr?: number | null;
  observedAt?: Date | null;
  details?: Record<string, unknown> | null;
};

const int = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
};

const text = (value: unknown, max = 255): string | null => {
  const parsed = String(value ?? "").trim();
  return parsed ? parsed.slice(0, max) : null;
};

/**
 * Appends one evidence row.
 *
 * When `trx` is supplied the row commits with the financial transition that
 * produced it, which is the whole point for a `released`/`reverted` decision:
 * the row exists if and only if the release committed. A duplicate money-moving
 * decision violates the expression-only unique index, which aborts that
 * transaction rather than releasing twice — so callers on a release path must
 * *not* swallow this.
 *
 * Observational rows (`observed`, `would_*`, `refused_*`, `followup`) are
 * written outside any transaction and must never fail a recovery run, so
 * `recordEvidenceSafely` wraps this for them.
 */
export async function recordEvidence(
  strapi: Strapi,
  row: EvidenceRow,
  trx?: any,
): Promise<{ id: number } | null> {
  const created: any = await strapi.db.query(EVIDENCE_UID).create({
    data: {
      attemptId: int(row.attemptId),
      orderId: int(row.orderId),
      kind: row.kind,
      mode: row.mode,
      decision: row.decision,
      providerHost: text(row.providerHost),
      clientIdFingerprint: text(row.clientIdFingerprint),
      tokenFingerprint: text(row.tokenFingerprint),
      generationSeq: int(row.generationSeq),
      httpStatus: int(row.httpStatus),
      providerCode: int(row.providerCode),
      providerStatus: text(row.providerStatus),
      callbackState: text(row.callbackState),
      tokenAgeMs: int(row.tokenAgeMs),
      walletAmountIrr: int(row.walletAmountIrr),
      gatewayAmountIrr: int(row.gatewayAmountIrr),
      observedAt: row.observedAt ?? new Date(),
      details: row.details ?? null,
    },
    ...(trx ? { transacting: trx } : {}),
  } as any);
  return created?.id ? { id: Number(created.id) } : null;
}

/**
 * Appends an observational row without ever failing the caller. Used for every
 * decision that did not move money: losing an audit line must not turn a park
 * into a crash, and the sweep still ends the attempt either way.
 */
export async function recordEvidenceSafely(
  strapi: Strapi,
  row: EvidenceRow,
): Promise<{ id: number } | null> {
  try {
    return await recordEvidence(strapi, row);
  } catch (error: any) {
    strapi.log.error("Failed to record payment-attempt evidence", {
      attemptId: row.attemptId,
      kind: row.kind,
      decision: row.decision,
      error: String(error?.message || error).slice(0, 300),
    });
    return null;
  }
}

export type StoredEvidence = {
  id: number;
  attemptId: number;
  orderId: number | null;
  kind: EvidenceKind;
  mode: EvidenceMode;
  decision: EvidenceDecision;
  providerStatus: string | null;
  providerCode: number | null;
  httpStatus: number | null;
  callbackState: string | null;
  tokenAgeMs: number | null;
  walletAmountIrr: number | null;
  observedAt: string | null;
  createdAt: string | null;
  details: Record<string, unknown> | null;
};

const mapRow = (row: Record<string, any>): StoredEvidence => ({
  id: Number(row.id),
  attemptId: Number(row.attempt_id),
  orderId: row.order_id === null || row.order_id === undefined ? null : Number(row.order_id),
  kind: row.kind,
  mode: row.mode,
  decision: row.decision,
  providerStatus: row.provider_status ?? null,
  providerCode: row.provider_code === null ? null : Number(row.provider_code),
  httpStatus: row.http_status === null ? null : Number(row.http_status),
  callbackState: row.callback_state ?? null,
  tokenAgeMs: row.token_age_ms === null ? null : Number(row.token_age_ms),
  walletAmountIrr: row.wallet_amount_irr === null ? null : Number(row.wallet_amount_irr),
  observedAt: row.observed_at ? new Date(row.observed_at).toISOString() : null,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  details: row.details ?? null,
});

/** Every evidence row for one attempt, oldest first. Attached to the bundle. */
export async function listEvidenceForAttempt(
  strapi: Strapi,
  attemptId: number,
  options: { limit?: number } = {},
): Promise<StoredEvidence[]> {
  const result = await strapi.db.connection.raw(
    `SELECT * FROM ${EVIDENCE_TABLE}
      WHERE attempt_id = ?
      ORDER BY id ASC
      LIMIT ?`,
    [attemptId, Math.max(1, Math.min(500, options.limit ?? 200))],
  );
  return (result?.rows || []).map(mapRow);
}

/**
 * The attempt has a committed money-moving decision of one of these kinds.
 *
 * This is the durable replacement for reading `provider_response.generation
 * .terminalEvidence`, which §10 proves is overwritable by any later observation
 * write or generation rotation.
 */
export async function hasTerminalEvidence(
  strapi: Strapi,
  attemptId: number,
  kinds?: EvidenceKind[],
): Promise<boolean> {
  const bindings: unknown[] = [attemptId];
  let kindClause = "";
  if (kinds && kinds.length > 0) {
    kindClause = ` AND kind = ANY(?)`;
    bindings.push(kinds);
  }
  const result = await strapi.db.connection.raw(
    `SELECT 1 FROM ${EVIDENCE_TABLE}
      WHERE attempt_id = ?
        AND decision IN ('released', 'reverted')${kindClause}
      LIMIT 1`,
    bindings,
  );
  return (result?.rows || []).length > 0;
}

/** Count of money-moving decisions in a recent window, for the count breaker. */
export async function countRecentTerminalDecisions(
  strapi: Strapi,
  params: { kinds: EvidenceKind[]; windowMs: number; now?: Date },
): Promise<number> {
  const since = new Date((params.now ?? new Date()).getTime() - params.windowMs);
  const result = await strapi.db.connection.raw(
    `SELECT COUNT(*)::int AS count FROM ${EVIDENCE_TABLE}
      WHERE decision IN ('released', 'reverted')
        AND kind = ANY(?)
        AND created_at >= ?`,
    [params.kinds, since],
  );
  return Number(result?.rows?.[0]?.count || 0);
}

/**
 * Wallet money released automatically in a recent window, for the value
 * breaker. Deliberately not scoped by path: the question the breaker answers is
 * "how much customer money has automation handed back unattended", and three
 * paths each under their own limit is not the same guarantee.
 */
export async function sumRecentReleasedWalletIrr(
  strapi: Strapi,
  params: { windowMs: number; now?: Date },
): Promise<number> {
  const since = new Date((params.now ?? new Date()).getTime() - params.windowMs);
  const result = await strapi.db.connection.raw(
    `SELECT COALESCE(SUM(wallet_amount_irr), 0)::bigint AS total FROM ${EVIDENCE_TABLE}
      WHERE decision IN ('released', 'reverted')
        AND created_at >= ?`,
    [since],
  );
  return Number(result?.rows?.[0]?.total || 0);
}

/**
 * The proven NOT_FOUND reads for one attempt, oldest first.
 *
 * The confirm protocol counts reads and measures the gap between them from this
 * table rather than from a counter on the operation row, because operation rows
 * are updated in place (847 of 4,349 on production) and two workers racing the
 * same read would otherwise double-count or lose one.
 */
export async function listNotFoundReads(
  strapi: Strapi,
  attemptId: number,
  kind: EvidenceKind,
): Promise<StoredEvidence[]> {
  const result = await strapi.db.connection.raw(
    `SELECT * FROM ${EVIDENCE_TABLE}
      WHERE attempt_id = ?
        AND kind = ?
        AND decision = 'observed'
      ORDER BY id ASC`,
    [attemptId, kind],
  );
  return (result?.rows || []).map(mapRow);
}

export type ShadowStats = {
  wouldReleaseCount: number;
  oldestWouldReleaseAt: string | null;
  /**
   * Largest `token_age_ms` recorded on a NOT_FOUND read whose attempt later
   * settled. This is the measured unsafe window: a token that answered 1007 at
   * this age still became a paid order.
   */
  contradictedTailMs: number | null;
  contradictionCount: number;
};

/**
 * Readiness input for the NOT_FOUND ENFORCE gate (plan §9.2 item 2).
 *
 * `contradictedTailMs` is computed by joining NOT_FOUND read rows to attempts
 * that reached `Succeeded`. Production already contains 56 such attempts (a
 * 1007 read followed by a successful settle, p90 10.8 min, max 23.4 min), so
 * this is a live measurement, not a hypothetical.
 */
export async function readShadowStats(
  strapi: Strapi,
  params: { kinds: EvidenceKind[] },
): Promise<ShadowStats> {
  const wouldRelease = await strapi.db.connection.raw(
    `SELECT COUNT(*)::int AS count, MIN(created_at) AS oldest
       FROM ${EVIDENCE_TABLE}
      WHERE decision = 'would_release'
        AND kind = ANY(?)`,
    [params.kinds],
  );
  const contradicted = await strapi.db.connection.raw(
    `SELECT COUNT(*)::int AS count, MAX(e.token_age_ms) AS tail
       FROM ${EVIDENCE_TABLE} e
       JOIN payment_attempts pa ON pa.id = e.attempt_id
      WHERE e.kind = ANY(?)
        AND pa.status = 'Succeeded'`,
    [params.kinds],
  );
  const oldest = wouldRelease?.rows?.[0]?.oldest;
  const tail = contradicted?.rows?.[0]?.tail;
  return {
    wouldReleaseCount: Number(wouldRelease?.rows?.[0]?.count || 0),
    oldestWouldReleaseAt: oldest ? new Date(oldest).toISOString() : null,
    contradictedTailMs: tail === null || tail === undefined ? null : Number(tail),
    contradictionCount: Number(contradicted?.rows?.[0]?.count || 0),
  };
}

/**
 * Attempts whose shadow decision has not been probed yet, for the +24h
 * follow-up read. `details->>'followupScheduled'` is not consulted: the
 * scheduler keys on the absence of a `followup` row for the attempt, so a lost
 * schedule simply retries on the next sweep.
 */
export async function listAttemptsAwaitingFollowup(
  strapi: Strapi,
  params: { olderThanMs: number; limit?: number; now?: Date },
): Promise<Array<{ attemptId: number; orderId: number | null }>> {
  const cutoff = new Date((params.now ?? new Date()).getTime() - params.olderThanMs);
  const result = await strapi.db.connection.raw(
    `SELECT DISTINCT e.attempt_id, e.order_id
       FROM ${EVIDENCE_TABLE} e
      WHERE e.decision IN ('would_release', 'would_revert', 'review')
        AND e.created_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM ${EVIDENCE_TABLE} f
           WHERE f.attempt_id = e.attempt_id
             AND f.kind = 'followup'
        )
      ORDER BY e.attempt_id ASC
      LIMIT ?`,
    [cutoff, Math.max(1, Math.min(200, params.limit ?? 50))],
  );
  return (result?.rows || []).map((row: any) => ({
    attemptId: Number(row.attempt_id),
    orderId: row.order_id === null ? null : Number(row.order_id),
  }));
}

/** Rolling summary for the hourly `snappay.recovery.summary` log line. */
export async function summarizeRecentEvidence(
  strapi: Strapi,
  params: { windowMs: number; now?: Date },
): Promise<Array<{ kind: string; mode: string; decision: string; count: number }>> {
  const since = new Date((params.now ?? new Date()).getTime() - params.windowMs);
  const result = await strapi.db.connection.raw(
    `SELECT kind, mode, decision, COUNT(*)::int AS count
       FROM ${EVIDENCE_TABLE}
      WHERE created_at >= ?
      GROUP BY kind, mode, decision
      ORDER BY count DESC`,
    [since],
  );
  return (result?.rows || []).map((row: any) => ({
    kind: String(row.kind),
    mode: String(row.mode),
    decision: String(row.decision),
    count: Number(row.count),
  }));
}
