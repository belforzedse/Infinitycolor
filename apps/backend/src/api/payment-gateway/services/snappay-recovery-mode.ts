import type { Strapi } from "@strapi/strapi";
import * as Sentry from "@sentry/node";
import {
  NOT_FOUND_KINDS,
  readShadowStats,
  type EvidenceMode,
} from "../../payment-attempt-evidence/services/evidence";
import {
  paymentAttemptEvidenceIsConstrained,
  paymentAttemptEvidenceIsDeduplicated,
  paymentAttemptEvidenceIsImmutable,
} from "../../payment-attempt-evidence/services/evidence-database";

/**
 * Staged rollout for every recovery path that acts on provider evidence.
 *
 * `off`    — today's code path exactly. No decision pipeline, no decision rows.
 * `shadow` — the full pipeline (provenance, scheduling, breakers) writing
 *            `would_*` evidence and Sentry events, then today's outcome.
 * `enforce`— the mutation.
 *
 * The ladder exists because production proved the naive reading of SnappPay's
 * 1007 wrong: 56 of 481 settled attempts carried a `providerCode: 1007` from an
 * earlier status read, settling a median 4.3 minutes (max 23.4) after the token
 * was issued. Releasing on the first 1007 would have cancelled paying
 * customers. Nothing here may mutate an order, a reservation or a wallet before
 * production has run the decision in shadow.
 */
export type RecoveryMode = EvidenceMode;

export type RecoveryPath = "not_found" | "registered" | "late_success";

export const RECOVERY_MODE_ENV: Record<RecoveryPath, string> = {
  not_found: "SNAPPAY_NOT_FOUND_AUTO_RELEASE_MODE",
  registered: "SNAPPAY_REGISTERED_AUTO_REVERT_MODE",
  late_success: "SNAPPAY_LATE_SUCCESS_MODE",
};

/**
 * Unrecognised values resolve to `off`, never to a mutation. A typo in an env
 * var must not be the reason money moved.
 */
export function parseRecoveryMode(value: unknown): RecoveryMode {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "enforce":
      return "enforce";
    case "shadow":
      return "shadow";
    default:
      return "off";
  }
}

export function configuredRecoveryMode(
  path: RecoveryPath,
  env: NodeJS.ProcessEnv = process.env,
): RecoveryMode {
  const mode = parseRecoveryMode(env[RECOVERY_MODE_ENV[path]]);
  // The late-success path has no safe "today" to return to. Once the sweep
  // stamps a timed-out attempt terminal, a late OK callback that is not routed
  // to the matrix is silently dropped (`acceptSnappayCallback` returns
  // "recorded" and writes nothing), so a real payment would vanish. `off`
  // therefore means "observe and park for review", never "ignore".
  if (path === "late_success" && mode === "off") return "shadow";
  return mode;
}

/** Minimum shadow observation before NOT_FOUND may enforce (plan §9.2 item 2). */
const SHADOW_MIN_DAYS = 7;
const SHADOW_MIN_WOULD_RELEASE = 100;
/**
 * How far the configured minimum token age must clear the largest age at which
 * a 1007 read was later contradicted by a settlement. The tail is a measured
 * lower bound on the unsafe window, not the provider's true session lifetime,
 * so the margin is deliberate headroom rather than a derived quantity.
 */
export const NOT_FOUND_TAIL_MARGIN_MS = 5 * 60 * 1000;

export const DEFAULT_NOT_FOUND_MIN_TOKEN_AGE_MS = 30 * 60 * 1000;
export const DEFAULT_NOT_FOUND_CONFIRM_DELAY_MS = 3 * 60 * 1000;
export const DEFAULT_FAILED_NOT_FOUND_MIN_TOKEN_AGE_MS = 10 * 60 * 1000;
export const DEFAULT_REGISTERED_REVERT_AFTER_MS = 30 * 60 * 1000;
export const DEFAULT_AUTO_RELEASE_MAX_PER_15M = 30;
export const DEFAULT_RECONCILE_MAX_AGE_HOURS = 48;

const positiveNumber = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Returns null when unset, which the value breaker reads as "fail closed". */
const optionalPositiveNumber = (value: unknown): number | null => {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export function recoveryConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    notFoundMinTokenAgeMs: positiveNumber(
      env.SNAPPAY_NOT_FOUND_MIN_TOKEN_AGE_MS,
      DEFAULT_NOT_FOUND_MIN_TOKEN_AGE_MS,
    ),
    notFoundConfirmDelayMs: positiveNumber(
      env.SNAPPAY_NOT_FOUND_CONFIRM_DELAY_MS,
      DEFAULT_NOT_FOUND_CONFIRM_DELAY_MS,
    ),
    failedNotFoundMinTokenAgeMs: positiveNumber(
      env.SNAPPAY_FAILED_NOT_FOUND_MIN_TOKEN_AGE_MS,
      DEFAULT_FAILED_NOT_FOUND_MIN_TOKEN_AGE_MS,
    ),
    registeredRevertAfterMs: positiveNumber(
      env.SNAPPAY_REGISTERED_REVERT_AFTER_MS,
      DEFAULT_REGISTERED_REVERT_AFTER_MS,
    ),
    maxAutoReleasePer15m: positiveNumber(
      env.SNAPPAY_AUTO_RELEASE_MAX_PER_15M,
      DEFAULT_AUTO_RELEASE_MAX_PER_15M,
    ),
    maxWalletIrrPer24h: optionalPositiveNumber(env.SNAPPAY_AUTO_RELEASE_MAX_WALLET_IRR_PER_24H),
    maxSingleWalletIrr: optionalPositiveNumber(env.SNAPPAY_AUTO_RELEASE_MAX_SINGLE_WALLET_IRR),
    reconcileMaxAgeHours: positiveNumber(
      env.SNAPPAY_RECONCILE_MAX_AGE_HOURS,
      DEFAULT_RECONCILE_MAX_AGE_HOURS,
    ),
    notFoundSemanticsAck: String(env.SNAPPAY_NOT_FOUND_SEMANTICS_ACK || "").trim(),
  };
}

export type RecoveryPathReadiness = {
  configured: RecoveryMode;
  effective: RecoveryMode;
  /** Why `effective` is lower than `configured`. Empty when they match. */
  blockedBy: string[];
};

export type RecoveryReadiness = {
  evaluatedAt: string;
  evidenceImmutable: boolean;
  evidenceDeduplicated: boolean;
  evidenceConstrained: boolean;
  measuredTailMs: number | null;
  shadowWouldReleaseCount: number;
  shadowContradictions: number;
  paths: Record<RecoveryPath, RecoveryPathReadiness>;
};

const unevaluated = (): RecoveryReadiness => ({
  evaluatedAt: new Date(0).toISOString(),
  evidenceImmutable: false,
  evidenceDeduplicated: false,
  evidenceConstrained: false,
  measuredTailMs: null,
  shadowWouldReleaseCount: 0,
  shadowContradictions: 0,
  paths: {
    not_found: { configured: "off", effective: "off", blockedBy: ["not_evaluated"] },
    registered: { configured: "off", effective: "off", blockedBy: ["not_evaluated"] },
    late_success: { configured: "shadow", effective: "shadow", blockedBy: [] },
  },
});

let cached: RecoveryReadiness = unevaluated();

/**
 * Re-reads every ENFORCE prerequisite and caches the verdict. Called from
 * `bootstrap` after `ensurePaymentAttemptEvidenceInvariants`, and safe to call
 * again so an operator can confirm a repair without a restart.
 *
 * A path whose prerequisites are unmet is degraded to `shadow` — never silently
 * left at `enforce` on the strength of a log line saying the prerequisite could
 * not be verified.
 */
export async function evaluateRecoveryReadiness(
  strapi: Strapi,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RecoveryReadiness> {
  const config = recoveryConfig(env);
  const evidenceImmutable = await paymentAttemptEvidenceIsImmutable(strapi).catch(() => false);
  const evidenceDeduplicated = await paymentAttemptEvidenceIsDeduplicated(strapi).catch(
    () => false,
  );
  // Strapi renders an enumeration as plain text, so without these a misspelt
  // `decision` would escape both the breakers and the uniqueness index.
  const evidenceConstrained = await paymentAttemptEvidenceIsConstrained(strapi).catch(
    () => false,
  );

  let shadow = {
    wouldReleaseCount: 0,
    oldestWouldReleaseAt: null as string | null,
    contradictedTailMs: null as number | null,
    contradictionCount: 0,
  };
  try {
    shadow = await readShadowStats(strapi, { kinds: NOT_FOUND_KINDS });
  } catch (error: any) {
    strapi.log.error(
      `Could not read SnappPay shadow statistics; NOT_FOUND enforcement stays off: ${String(
        error?.message || error,
      ).slice(0, 200)}`,
    );
    shadow.contradictionCount = -1;
  }

  const evidenceBlockers: string[] = [];
  if (!evidenceImmutable) evidenceBlockers.push("evidence_trigger_missing");
  if (!evidenceDeduplicated) evidenceBlockers.push("evidence_unique_index_missing");
  if (!evidenceConstrained) evidenceBlockers.push("evidence_vocabulary_unconstrained");

  const notFoundBlockers = [...evidenceBlockers];
  if (!config.notFoundSemanticsAck) notFoundBlockers.push("semantics_ack_missing");
  if (shadow.contradictionCount < 0) notFoundBlockers.push("shadow_stats_unreadable");
  if (shadow.contradictionCount > 0) notFoundBlockers.push("shadow_contradicted_by_settlement");
  if (shadow.wouldReleaseCount < SHADOW_MIN_WOULD_RELEASE) {
    notFoundBlockers.push("shadow_sample_too_small");
  }
  const oldestMs = shadow.oldestWouldReleaseAt
    ? Date.now() - new Date(shadow.oldestWouldReleaseAt).getTime()
    : 0;
  if (oldestMs < SHADOW_MIN_DAYS * 24 * 60 * 60 * 1000) {
    notFoundBlockers.push("shadow_window_too_short");
  }
  if (
    shadow.contradictedTailMs !== null &&
    config.notFoundMinTokenAgeMs < shadow.contradictedTailMs + NOT_FOUND_TAIL_MARGIN_MS
  ) {
    notFoundBlockers.push("min_token_age_below_measured_tail");
  }

  const resolve = (path: RecoveryPath, blockers: string[]): RecoveryPathReadiness => {
    const configured = configuredRecoveryMode(path, env);
    if (configured !== "enforce" || blockers.length === 0) {
      return { configured, effective: configured, blockedBy: [] };
    }
    return { configured, effective: "shadow", blockedBy: blockers };
  };

  const paths: Record<RecoveryPath, RecoveryPathReadiness> = {
    not_found: resolve("not_found", notFoundBlockers),
    registered: resolve("registered", evidenceBlockers),
    late_success: resolve("late_success", evidenceBlockers),
  };

  cached = {
    evaluatedAt: new Date().toISOString(),
    evidenceImmutable,
    evidenceDeduplicated,
    evidenceConstrained,
    measuredTailMs: shadow.contradictedTailMs,
    shadowWouldReleaseCount: shadow.wouldReleaseCount,
    shadowContradictions: Math.max(0, shadow.contradictionCount),
    paths,
  };

  for (const path of Object.keys(paths) as RecoveryPath[]) {
    const readiness = paths[path];
    if (readiness.blockedBy.length === 0) continue;
    strapi.log.error(
      `SnappPay recovery path ${path} is configured for enforce but degraded to shadow: ${readiness.blockedBy.join(", ")}`,
    );
    Sentry.captureMessage("snappay.recovery.mode_degraded", {
      level: "warning",
      tags: { path, reason: readiness.blockedBy[0] },
      extra: { blockedBy: readiness.blockedBy, evaluatedAt: cached.evaluatedAt },
    });
  }
  strapi.log.info(
    `SnappPay recovery readiness: ${(Object.keys(paths) as RecoveryPath[])
      .map((path) => `${path}=${paths[path].effective}`)
      .join(" ")} measuredTailMs=${cached.measuredTailMs ?? "n/a"} shadowRows=${cached.shadowWouldReleaseCount}`,
  );
  return cached;
}

export const getRecoveryReadiness = (): RecoveryReadiness => cached;

/**
 * The mode a decision must obey right now. Always the *effective* mode, so a
 * path whose prerequisites regressed cannot mutate even though the env still
 * says `enforce`.
 */
export const getRecoveryMode = (path: RecoveryPath): RecoveryMode =>
  cached.paths[path]?.effective ?? (path === "late_success" ? "shadow" : "off");

/** Test seam: unit and integration tests set the verdict they mean to exercise. */
export const __setRecoveryReadinessForTests = (value: Partial<RecoveryReadiness>) => {
  cached = { ...unevaluated(), ...cached, ...value } as RecoveryReadiness;
};

export const __resetRecoveryReadinessForTests = () => {
  cached = unevaluated();
};

export const __private = { SHADOW_MIN_DAYS, SHADOW_MIN_WOULD_RELEASE };
