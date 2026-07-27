import {
  ADAPTIVE_QUALITY_BUILD_VERSION,
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_SCHEMA,
  ADAPTIVE_QUALITY_SESSION_TTL_MS,
  ADAPTIVE_QUALITY_STORAGE_KEY,
} from "./config";
import { isAdaptiveConstraint, isAdaptiveReason } from "./policy";
import type {
  AdaptiveQualityConstraint,
  AdaptiveQualityReason,
  AdaptiveQualitySessionRecord,
} from "./types";

function isValidRolloutBucket(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 9999;
}

export function readAdaptiveQualitySession(
  now = Date.now(),
  storage: Storage | null =
    typeof window === "undefined" ? null : window.sessionStorage,
): AdaptiveQualitySessionRecord | null {
  if (!storage) return null;

  try {
    const raw = storage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AdaptiveQualitySessionRecord>;
    if (
      value.schema !== ADAPTIVE_QUALITY_SCHEMA ||
      value.policyVersion !== ADAPTIVE_QUALITY_POLICY_VERSION ||
      value.buildVersion !== ADAPTIVE_QUALITY_BUILD_VERSION ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= now ||
      !isValidRolloutBucket(value.rolloutBucket) ||
      !isAdaptiveConstraint(value.constraint)
    ) {
      return null;
    }

    const reasons = Array.isArray(value.reasons)
      ? value.reasons.filter(isAdaptiveReason).slice(0, 8)
      : [];

    return {
      schema: ADAPTIVE_QUALITY_SCHEMA,
      policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
      buildVersion: ADAPTIVE_QUALITY_BUILD_VERSION,
      expiresAt: value.expiresAt,
      rolloutBucket: value.rolloutBucket,
      constraint: value.constraint,
      reasons: reasons.length ? reasons : ["default"],
      smoothWindows: normalizeCounter(value.smoothWindows),
      smoothRouteGenerations: normalizeCounter(value.smoothRouteGenerations),
      lastSmoothRouteGeneration: normalizeCounter(value.lastSmoothRouteGeneration),
      sessionHadDowngrade: value.sessionHadDowngrade === true,
      sessionHadSevereEvent: value.sessionHadSevereEvent === true,
    };
  } catch {
    return null;
  }
}

export function writeAdaptiveQualitySession(
  record: AdaptiveQualitySessionRecord,
  storage: Storage | null =
    typeof window === "undefined" ? null : window.sessionStorage,
): boolean {
  if (!storage) return false;

  try {
    storage.setItem(ADAPTIVE_QUALITY_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function createAdaptiveQualitySessionRecord(options: {
  constraint: AdaptiveQualityConstraint;
  rolloutBucket: number;
  reasons?: AdaptiveQualityReason[];
  now?: number;
  previous?: AdaptiveQualitySessionRecord | null;
}): AdaptiveQualitySessionRecord {
  const now = options.now ?? Date.now();
  const previous = options.previous;
  const reasons: AdaptiveQualityReason[] =
    options.reasons?.filter(isAdaptiveReason) ?? ["default"];

  return {
    schema: ADAPTIVE_QUALITY_SCHEMA,
    policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
    buildVersion: ADAPTIVE_QUALITY_BUILD_VERSION,
    expiresAt: now + ADAPTIVE_QUALITY_SESSION_TTL_MS,
    rolloutBucket: normalizeRolloutBucket(options.rolloutBucket),
    constraint: options.constraint,
    reasons: Array.from(new Set(reasons)).slice(0, 8),
    smoothWindows: previous?.smoothWindows ?? 0,
    smoothRouteGenerations: previous?.smoothRouteGenerations ?? 0,
    lastSmoothRouteGeneration: previous?.lastSmoothRouteGeneration ?? 0,
    sessionHadDowngrade: previous?.sessionHadDowngrade ?? false,
    sessionHadSevereEvent: previous?.sessionHadSevereEvent ?? false,
  };
}

export function createRolloutBucket(): number {
  try {
    const values = new Uint32Array(1);
    globalThis.crypto?.getRandomValues(values);
    if (values[0] !== undefined) return values[0] % 10000;
  } catch {
    // Use the non-identifying fallback below.
  }
  return Math.floor(Math.random() * 10000);
}

function normalizeCounter(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0
    ? Math.min(Number(value), 1_000_000)
    : 0;
}

function normalizeRolloutBucket(value: number): number {
  if (!Number.isFinite(value)) return createRolloutBucket();
  return Math.min(9999, Math.max(0, Math.floor(value)));
}
