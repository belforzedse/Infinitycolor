import {
  ADAPTIVE_QUALITY_BUILD_VERSION,
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_STORAGE_KEY,
} from "../config";
import {
  createAdaptiveQualitySessionRecord,
  readAdaptiveQualitySession,
  writeAdaptiveQualitySession,
} from "../storage";

describe("adaptive quality session persistence", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips only the coarse versioned record", () => {
    const record = createAdaptiveQualitySessionRecord({
      constraint: {
        rendering: "safe",
        media: "economy",
        motion: "minimal",
      },
      rolloutBucket: 42,
      reasons: ["low-memory"],
      now: 1_000,
    });
    expect(writeAdaptiveQualitySession(record)).toBe(true);
    expect(readAdaptiveQualitySession(1_001)).toEqual(record);

    const persisted = sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY) || "";
    expect(persisted).not.toMatch(
      /deviceMemory|hardwareConcurrency|effectiveType|pathname|frame|task/i,
    );
  });

  it("rejects expired, stale, malformed, and invalid-tier records", () => {
    sessionStorage.setItem(
      ADAPTIVE_QUALITY_STORAGE_KEY,
      JSON.stringify({
        schema: 1,
        policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
        buildVersion: ADAPTIVE_QUALITY_BUILD_VERSION,
        expiresAt: 10,
        rolloutBucket: 2,
        constraint: {
          rendering: "ultra",
          media: "standard",
          motion: "standard",
        },
      }),
    );
    expect(readAdaptiveQualitySession(11)).toBeNull();
    sessionStorage.setItem(ADAPTIVE_QUALITY_STORAGE_KEY, "{");
    expect(readAdaptiveQualitySession()).toBeNull();
  });

  it.each([
    { policyVersion: "stale-policy" },
    { buildVersion: "stale-build" },
    { schema: 2 },
    { rolloutBucket: 10_000 },
  ])("rejects version or rollout mismatch %#", (override) => {
    const record = {
      ...createAdaptiveQualitySessionRecord({
        constraint: {
          rendering: "standard",
          media: "standard",
          motion: "standard",
        },
        rolloutBucket: 24,
      }),
      ...override,
    };
    sessionStorage.setItem(
      ADAPTIVE_QUALITY_STORAGE_KEY,
      JSON.stringify(record),
    );
    expect(readAdaptiveQualitySession()).toBeNull();
  });

  it("is non-fatal when storage access is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new DOMException("blocked");
      },
      setItem: () => {
        throw new DOMException("blocked");
      },
    } as unknown as Storage;
    const record = createAdaptiveQualitySessionRecord({
      constraint: {
        rendering: "standard",
        media: "standard",
        motion: "standard",
      },
      rolloutBucket: 1,
    });
    expect(readAdaptiveQualitySession(Date.now(), blocked)).toBeNull();
    expect(writeAdaptiveQualitySession(record, blocked)).toBe(false);
  });
});
