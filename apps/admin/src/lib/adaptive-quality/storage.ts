import {
  ADAPTIVE_QUALITY_BUILD_VERSION,
  ADAPTIVE_QUALITY_LEGACY_STORAGE_KEYS,
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
  storage?: Storage | null,
): AdaptiveQualitySessionRecord | null {
  try {
    const target = storage === undefined ? getSessionStorage() : storage;
    if (!target) return null;
    const raw = target.getItem(ADAPTIVE_QUALITY_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AdaptiveQualitySessionRecord>;
    if (
      value.schema !== ADAPTIVE_QUALITY_SCHEMA ||
      value.policyVersion !== ADAPTIVE_QUALITY_POLICY_VERSION ||
      value.buildVersion !== ADAPTIVE_QUALITY_BUILD_VERSION ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt) ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      value.createdAt > value.expiresAt ||
      value.expiresAt !== value.createdAt + ADAPTIVE_QUALITY_SESSION_TTL_MS ||
      value.expiresAt <= now ||
      !isValidRolloutBucket(value.rolloutBucket) ||
      !isAdaptiveConstraint(value.runtimeConstraint) ||
      !isNullableTimestamp(value.penaltyExpiresAt) ||
      !isNullableTimestamp(value.lastBadAt) ||
      !isAdaptiveReason(value.lastReason)
    ) {
      return null;
    }

    return {
      schema: ADAPTIVE_QUALITY_SCHEMA,
      policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
      buildVersion: ADAPTIVE_QUALITY_BUILD_VERSION,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      rolloutBucket: value.rolloutBucket,
      runtimeConstraint: value.runtimeConstraint,
      penaltyExpiresAt: value.penaltyExpiresAt,
      consecutiveSmoothWindows: normalizeCounter(
        value.consecutiveSmoothWindows,
      ),
      lastBadAt: value.lastBadAt,
      lastReason: value.lastReason,
    };
  } catch {
    return null;
  }
}

export function writeAdaptiveQualitySession(
  record: AdaptiveQualitySessionRecord,
  storage?: Storage | null,
): boolean {
  try {
    const target = storage === undefined ? getSessionStorage() : storage;
    if (!target) return false;
    target.setItem(ADAPTIVE_QUALITY_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function createAdaptiveQualitySessionRecord(options: {
  runtimeConstraint: AdaptiveQualityConstraint;
  rolloutBucket: number;
  now?: number;
  previous?: AdaptiveQualitySessionRecord | null;
  penaltyExpiresAt?: number | null;
  consecutiveSmoothWindows?: number;
  lastBadAt?: number | null;
  lastReason?: AdaptiveQualityReason;
}): AdaptiveQualitySessionRecord {
  const now = options.now ?? Date.now();
  const previous = options.previous;
  const createdAt = previous?.createdAt ?? now;

  return {
    schema: ADAPTIVE_QUALITY_SCHEMA,
    policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
    buildVersion: ADAPTIVE_QUALITY_BUILD_VERSION,
    createdAt,
    expiresAt: previous?.expiresAt ?? createdAt + ADAPTIVE_QUALITY_SESSION_TTL_MS,
    rolloutBucket: normalizeRolloutBucket(options.rolloutBucket),
    runtimeConstraint: options.runtimeConstraint,
    penaltyExpiresAt:
      options.penaltyExpiresAt === undefined
        ? previous?.penaltyExpiresAt ?? null
        : options.penaltyExpiresAt,
    consecutiveSmoothWindows: normalizeCounter(
      options.consecutiveSmoothWindows ??
        previous?.consecutiveSmoothWindows ??
        0,
    ),
    lastBadAt:
      options.lastBadAt === undefined
        ? previous?.lastBadAt ?? null
        : options.lastBadAt,
    lastReason:
      options.lastReason && isAdaptiveReason(options.lastReason)
        ? options.lastReason
        : previous?.lastReason ?? "default",
  };
}

export function removeLegacyAdaptiveQualitySessions(
  storage?: Storage | null,
): void {
  try {
    const target = storage === undefined ? getSessionStorage() : storage;
    if (!target) return;
    for (const key of ADAPTIVE_QUALITY_LEGACY_STORAGE_KEYS) {
      target.removeItem(key);
    }
  } catch {
    // Storage is optional; bootstrap and hydration must remain non-fatal.
  }
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

function isNullableTimestamp(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function getSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
