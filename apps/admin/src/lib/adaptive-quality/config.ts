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

export const ADAPTIVE_QUALITY_SCHEMA = 2 as const;
export const ADAPTIVE_QUALITY_POLICY_VERSION = "2.0.0";
export const ADAPTIVE_QUALITY_STORAGE_KEY = "infinity:adaptive-quality:v2";
export const ADAPTIVE_QUALITY_LEGACY_STORAGE_KEYS = [
  "infinity:adaptive-quality:v1",
] as const;
export const ADAPTIVE_QUALITY_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
export const ADAPTIVE_QUALITY_PENALTY_TTL_MS = 30 * 60 * 1000;

/**
 * Keep policy thresholds in one serializable object. The pre-hydration script
 * embeds this object and the hydrated controller imports the same values.
 */
export const ADAPTIVE_QUALITY_POLICY_CONFIG = Object.freeze({
  desktop: Object.freeze({
    minimumHardwareConcurrency: 8,
    minimumDeviceMemory: 8,
  }),
  observation: Object.freeze({
    initialWindowMs: 8_000,
    enhancementExtensionMs: 5_000,
    maximumWindowMs: 15_000,
    downgradeCooldownMs: 15_000,
    recoveryWindows: 2,
    minimumRecoveryDelayMs: 15_000,
  }),
  loaf: Object.freeze({
    severeBlockingDurationMs: 150,
    diagnosticDurationMs: 300,
    repeatedDurationMs: 120,
    repeatedBlockingDurationMs: 50,
    repeatedCount: 3,
  }),
});

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
