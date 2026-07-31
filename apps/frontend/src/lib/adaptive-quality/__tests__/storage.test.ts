import {
  ADAPTIVE_QUALITY_BUILD_VERSION,
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_SCHEMA,
  ADAPTIVE_QUALITY_SESSION_TTL_MS,
  ADAPTIVE_QUALITY_STORAGE_KEY,
} from "../config";
import {
  createAdaptiveQualitySessionRecord,
  readAdaptiveQualitySession,
  removeLegacyAdaptiveQualitySessions,
  writeAdaptiveQualitySession,
} from "../storage";

describe("adaptive quality v2 session persistence", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips only the coarse runtime record", () => {
    const record = createAdaptiveQualitySessionRecord({
      runtimeConstraint: {
        rendering: "safe",
        media: "economy",
        motion: "minimal",
      },
      rolloutBucket: 42,
      now: 1_000,
      penaltyExpiresAt: 10_000,
      consecutiveSmoothWindows: 1,
      lastBadAt: 900,
      lastReason: "severe-loaf",
    });
    expect(writeAdaptiveQualitySession(record)).toBe(true);
    expect(readAdaptiveQualitySession(1_001)).toEqual(record);

    const persisted = sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY) || "";
    expect(persisted).not.toMatch(
      /deviceMemory|hardwareConcurrency|effectiveType|userAgent|model|pointer|pathname|url|frame|task/i,
    );
  });

  it("keeps createdAt and expiry fixed across ordinary writes", () => {
    const first = createAdaptiveQualitySessionRecord({
      runtimeConstraint: {
        rendering: "standard",
        media: "standard",
        motion: "standard",
      },
      rolloutBucket: 7,
      now: 1_000,
    });
    const second = createAdaptiveQualitySessionRecord({
      runtimeConstraint: {
        rendering: "standard",
        media: "standard",
        motion: "minimal",
      },
      rolloutBucket: 7,
      now: 20_000,
      previous: first,
      lastBadAt: 20_000,
      lastReason: "raf-jank",
    });

    expect(second.createdAt).toBe(1_000);
    expect(second.expiresAt).toBe(1_000 + ADAPTIVE_QUALITY_SESSION_TTL_MS);
  });

  it("rejects expired, stale, malformed, and invalid-tier records", () => {
    sessionStorage.setItem(
      ADAPTIVE_QUALITY_STORAGE_KEY,
      JSON.stringify({
        schema: ADAPTIVE_QUALITY_SCHEMA,
        policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
        buildVersion: ADAPTIVE_QUALITY_BUILD_VERSION,
        createdAt: 1,
        expiresAt: 10,
        rolloutBucket: 2,
        runtimeConstraint: {
          rendering: "ultra",
          media: "standard",
          motion: "standard",
        },
        penaltyExpiresAt: null,
        consecutiveSmoothWindows: 0,
        lastBadAt: null,
        lastReason: "default",
      }),
    );
    expect(readAdaptiveQualitySession(11)).toBeNull();
    sessionStorage.setItem(ADAPTIVE_QUALITY_STORAGE_KEY, "{");
    expect(readAdaptiveQualitySession()).toBeNull();
  });

  it.each([
    { policyVersion: "stale-policy" },
    { buildVersion: "stale-build" },
    { schema: 1 },
    { rolloutBucket: 10_000 },
  ])("rejects version or rollout mismatch %#", (override) => {
    const record = {
      ...createAdaptiveQualitySessionRecord({
        runtimeConstraint: {
          rendering: "standard",
          media: "standard",
          motion: "standard",
        },
        rolloutBucket: 24,
      }),
      ...override,
    };
    sessionStorage.setItem(ADAPTIVE_QUALITY_STORAGE_KEY, JSON.stringify(record));
    expect(readAdaptiveQualitySession()).toBeNull();
  });

  it("removes the legacy key without disturbing v2", () => {
    sessionStorage.setItem("infinity:adaptive-quality:v1", "{}");
    sessionStorage.setItem(ADAPTIVE_QUALITY_STORAGE_KEY, "{}");
    removeLegacyAdaptiveQualitySessions();
    expect(sessionStorage.getItem("infinity:adaptive-quality:v1")).toBeNull();
    expect(sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY)).toBe("{}");
  });

  it("is non-fatal when storage access is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("blocked");
      },
      setItem: () => {
        throw new DOMException("blocked");
      },
      removeItem: () => {
        throw new DOMException("blocked");
      },
    } as unknown as Storage;
    const record = createAdaptiveQualitySessionRecord({
      runtimeConstraint: {
        rendering: "standard",
        media: "standard",
        motion: "standard",
      },
      rolloutBucket: 1,
    });
    expect(readAdaptiveQualitySession(Date.now(), blocked)).toBeNull();
    expect(writeAdaptiveQualitySession(record, blocked)).toBe(false);
    expect(() => removeLegacyAdaptiveQualitySessions(blocked)).not.toThrow();
  });
});
