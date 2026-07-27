import {
  applyCurrentPreferences,
  classifyAdaptiveQuality,
  downgradeConstraint,
  getAdaptiveCapabilityMaximum,
  promoteConstraint,
} from "../policy";

describe("adaptive quality policy", () => {
  it("keeps missing and invalid hints neutral", () => {
    expect(
      classifyAdaptiveQuality({
        deviceMemory: Number.NaN,
        hardwareConcurrency: 0,
      }).snapshot,
    ).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "standard",
      reason: "default",
    });
    expect(
      classifyAdaptiveQuality({
        deviceMemory: 1_000,
        hardwareConcurrency: 2.5,
        effectiveType: "unknown",
      }).snapshot,
    ).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
  });

  it.each([
    [{ deviceMemory: 2 }, "low-memory"],
    [{ hardwareConcurrency: 2 }, "low-cores"],
    [{ deviceMemory: 4, hardwareConcurrency: 4 }, "combined-capacity"],
  ] as const)("selects Safe and Minimal for constrained capacity", (hints, reason) => {
    const result = classifyAdaptiveQuality(hints);
    expect(result.constraint).toEqual({
      rendering: "safe",
      media: "standard",
      motion: "minimal",
    });
    expect(result.reasons).toContain(reason);
  });

  it("applies accessibility and network preferences without enriching", () => {
    const result = classifyAdaptiveQuality({
      reducedMotion: true,
      reducedTransparency: true,
      saveData: true,
    });
    expect(result.snapshot).toMatchObject({
      rendering: "standard",
      media: "economy",
      motion: "minimal",
      reducedTransparency: true,
    });
    expect(result.constraint).toEqual({
      rendering: "standard",
      media: "economy",
      motion: "minimal",
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "reduced-motion",
        "reduced-transparency",
        "save-data",
      ]),
    );
  });

  it("treats 3g as Economy but ignores unknown connection labels", () => {
    expect(
      applyCurrentPreferences(
        {
          enabled: true,
          rendering: "standard",
          media: "standard",
          motion: "standard",
          reducedTransparency: false,
          reason: "default",
          routeGeneration: 0,
        },
        { effectiveType: "3g" },
      ).media,
    ).toBe("economy");
    expect(
      classifyAdaptiveQuality({ effectiveType: "satellite" }).snapshot.media,
    ).toBe("standard");
  });

  it.each(["slow-2g", "2g", "3g"])(
    "classifies %s as Economy",
    (effectiveType) => {
      expect(
        classifyAdaptiveQuality({ effectiveType }).snapshot.media,
      ).toBe("economy");
    },
  );

  it("component-wise clamps every axis to a persisted session maximum", () => {
    const result = classifyAdaptiveQuality(
      {
        deviceMemory: 8,
        hardwareConcurrency: 8,
      },
      {
        rendering: "safe",
        media: "economy",
        motion: "minimal",
      },
    );
    expect(result.constraint).toEqual({
      rendering: "safe",
      media: "economy",
      motion: "minimal",
    });
    expect(result.reasons).toContain("session-constraint");
  });

  it("keeps accessibility and network constraints in the promotion maximum", () => {
    expect(
      getAdaptiveCapabilityMaximum({
        reducedMotion: true,
        saveData: true,
        deviceMemory: 8,
        hardwareConcurrency: 8,
      }),
    ).toEqual({
      rendering: "enhanced",
      media: "economy",
      motion: "minimal",
    });
  });

  it("downgrades one axis at a time in motion, media, rendering order", () => {
    const first = downgradeConstraint({
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
    expect(first).toEqual({
      rendering: "standard",
      media: "standard",
      motion: "minimal",
    });
    const second = downgradeConstraint(first!);
    expect(second).toEqual({
      rendering: "standard",
      media: "economy",
      motion: "minimal",
    });
    expect(downgradeConstraint(second!)).toEqual({
      rendering: "safe",
      media: "economy",
      motion: "minimal",
    });
  });

  it("promotes one axis at a time and respects a capacity maximum", () => {
    expect(
      promoteConstraint(
        { rendering: "safe", media: "economy", motion: "minimal" },
        { rendering: "standard", media: "standard", motion: "minimal" },
      ),
    ).toEqual({
      rendering: "standard",
      media: "economy",
      motion: "minimal",
    });
  });
});
