const parseBoolean = (value: string | undefined, fallback: boolean) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
};

const parseRolloutPercent = (value: string | undefined) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(100, Math.max(0, parsed));
};

export const ADAPTIVE_QUALITY_SCHEMA = 1 as const;
export const ADAPTIVE_QUALITY_POLICY_VERSION = "1.1.0";
export const ADAPTIVE_QUALITY_STORAGE_KEY = "infinity:adaptive-quality:v1";
export const ADAPTIVE_QUALITY_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export const ADAPTIVE_QUALITY_FLAGS = Object.freeze({
  enabled: parseBoolean(process.env.NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ENABLED, true),
  runtimeDowngrade: parseBoolean(
    process.env.NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_RUNTIME_DOWNGRADE,
    true,
  ),
  promotion: parseBoolean(process.env.NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_PROMOTION, true),
  telemetry: parseBoolean(process.env.NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_TELEMETRY, true),
  forceSafe: parseBoolean(process.env.NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_FORCE_SAFE, false),
  rolloutPercent: parseRolloutPercent(
    process.env.NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_ROLLOUT_PERCENT,
  ),
  e2e: parseBoolean(process.env.NEXT_PUBLIC_INFINITY_ADAPTIVE_QUALITY_E2E, false),
});

export const ADAPTIVE_QUALITY_BUILD_VERSION = process.env.NEXT_PUBLIC_BUILD_VERSION || "dev";

export const ADAPTIVE_QUALITY_EVENT = "infinity:adaptive-quality-change";
export const ADAPTIVE_QUALITY_PROMOTION_EVENT = "infinity:adaptive-quality-promotion-eligible";
