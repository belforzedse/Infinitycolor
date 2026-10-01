import type { Strapi } from "@strapi/strapi";
import * as Sentry from "@sentry/node";
import { routeExpectedDiagnostic } from "../../../utils/diagnostic-log";
import {
  countRecentTerminalDecisions,
  sumRecentReleasedWalletIrr,
  type EvidenceDecision,
  type EvidenceKind,
} from "../../payment-attempt-evidence/services/evidence";
import { recoveryConfig, type RecoveryPath } from "./snappay-recovery-mode";

/**
 * Circuit breakers for automatic release.
 *
 * Both read `payment_attempt_evidence`, never `provider_response`: §10 proves
 * the attempt JSON is overwritable by any later observation, so a breaker that
 * counted from it could be talked out of tripping by the very runaway it exists
 * to stop.
 *
 * A tripped breaker parks the attempt exactly as today. Stock and wallet are
 * then still freed by the reservation sweep at its usual TTL, so tripping costs
 * latency, never money.
 */

const COUNT_WINDOW_MS = 15 * 60 * 1000;
const VALUE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type BreakerVerdict =
  | { open: false }
  | { open: true; decision: Extract<
      EvidenceDecision,
      "refused_breaker_count" | "refused_breaker_value" | "refused_single_cap"
    >; reason: string };

const CLOSED: BreakerVerdict = { open: false };

export async function evaluateReleaseBreakers(
  strapi: Strapi,
  params: {
    path: RecoveryPath;
    kinds: EvidenceKind[];
    walletAmountIrr: number;
    now?: Date;
    env?: NodeJS.ProcessEnv;
    mode?: "shadow" | "enforce" | "off";
  },
): Promise<BreakerVerdict> {
  const config = recoveryConfig(params.env ?? process.env);
  const walletAmountIrr = Math.max(0, Number(params.walletAmountIrr) || 0);

  // Fail closed on wallet money whose limits were never configured. An attempt
  // that holds no wallet credit is unaffected: its automatic release frees only
  // stock, which the sweep would free anyway.
  if (walletAmountIrr > 0) {
    if (config.maxSingleWalletIrr === null || config.maxWalletIrrPer24h === null) {
      return trip(strapi, params.path, {
        open: true,
        decision: "refused_breaker_value",
        reason: "wallet_value_limits_unset",
      }, params.mode);
    }
    if (walletAmountIrr > config.maxSingleWalletIrr) {
      return trip(strapi, params.path, {
        open: true,
        decision: "refused_single_cap",
        reason: `wallet_amount_${walletAmountIrr}_over_cap_${config.maxSingleWalletIrr}`,
      }, params.mode);
    }
  }

  const recentCount = await countRecentTerminalDecisions(strapi, {
    kinds: params.kinds,
    windowMs: COUNT_WINDOW_MS,
    now: params.now,
  });
  if (recentCount >= config.maxAutoReleasePer15m) {
    return trip(strapi, params.path, {
      open: true,
      decision: "refused_breaker_count",
      reason: `${recentCount}_releases_in_15m_over_${config.maxAutoReleasePer15m}`,
    }, params.mode);
  }

  if (walletAmountIrr > 0 && config.maxWalletIrrPer24h !== null) {
    const released = await sumRecentReleasedWalletIrr(strapi, {
      windowMs: VALUE_WINDOW_MS,
      now: params.now,
    });
    if (released + walletAmountIrr > config.maxWalletIrrPer24h) {
      return trip(strapi, params.path, {
        open: true,
        decision: "refused_breaker_value",
        reason: `${released + walletAmountIrr}_irr_in_24h_over_${config.maxWalletIrrPer24h}`,
      }, params.mode);
    }
  }

  return CLOSED;
}

function trip(
  strapi: Strapi,
  path: RecoveryPath,
  verdict: Extract<BreakerVerdict, { open: true }>,
  mode: "shadow" | "enforce" | "off" = "enforce",
): BreakerVerdict {
  strapi.log.error(
    `SnappPay automatic release breaker open for ${path}: ${verdict.decision} (${verdict.reason})`,
  );
  if (mode !== "enforce" && routeExpectedDiagnostic("snappay.recovery.breaker_open", { path, breaker: verdict.decision, mode })) return verdict;
  try { Sentry.captureMessage("snappay.recovery.breaker_open", {
    level: "warning",
    tags: { path, breaker: verdict.decision, mode },
    extra: { reason: verdict.reason },
  }); } catch { /* Reporting cannot change the fail-closed verdict. */ }
  return verdict;
}

export const __private = { COUNT_WINDOW_MS, VALUE_WINDOW_MS };
