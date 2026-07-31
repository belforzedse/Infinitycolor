import {
  applyCurrentPreferences,
  classifyAdaptiveQuality,
  downgradeConstraint,
  getAdaptiveCapabilityMaximum,
  getAdaptiveDeviceBaseline,
  promoteConstraint,
} from "../policy";

const capableDesktop = {
  finePointer: true,
  hover: true,
  hardwareConcurrency: 8,
  deviceMemory: 8,
} as const;

describe("adaptive quality v2 policy", () => {
  it.each([
    capableDesktop,
    { ...capableDesktop, deviceMemory: undefined },
    { ...capableDesktop, hardwareConcurrency: 16 },
  ])("admits a capable desktop to peak", (capabilities) => {
    expect(classifyAdaptiveQuality(capabilities)).toMatchObject({
      baselineConstraint: {
        rendering: "enhanced",
        media: "high",
        motion: "enhanced",
      },
      runtimeConstraint: {
        rendering: "enhanced",
        media: "high",
        motion: "enhanced",
      },
      snapshot: {
        rendering: "enhanced",
        media: "high",
        motion: "enhanced",
        reason: "default",
      },
    });
  });

  it.each([
    { ...capableDesktop, finePointer: false },
    { ...capableDesktop, hover: false },
    { ...capableDesktop, hardwareConcurrency: 7 },
    { ...capableDesktop, deviceMemory: 4 },
    { ...capableDesktop, hardwareConcurrency: Number.NaN },
    { ...capableDesktop, deviceMemory: Number.NaN },
    { finePointer: true, hover: true },
    {},
  ])("keeps weak, touch-primary, unknown, or invalid reports Standard", (capabilities) => {
    expect(getAdaptiveDeviceBaseline(capabilities)).toEqual({
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
  });

  it("preserves researched mobile admission independently of desktop hints", () => {
    expect(getAdaptiveDeviceBaseline({ finePointer: false, hover: false }, true)).toEqual({
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    });
  });

  it("keeps runtime penalties independent from live overlays", () => {
    const result = classifyAdaptiveQuality(
      {
        ...capableDesktop,
        effectiveType: "3g",
        reducedMotion: true,
      },
      {
        persistedRuntimeConstraint: {
          rendering: "standard",
          media: "standard",
          motion: "standard",
        },
      },
    );

    expect(result.runtimeConstraint).toEqual({
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
    expect(result.snapshot).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "minimal",
    });
  });

  it("applies reversible network media caps", () => {
    const peak = {
      enabled: true,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
      reducedTransparency: false,
      reason: "default",
      routeGeneration: 0,
    } as const;

    expect(applyCurrentPreferences(peak, { effectiveType: "slow-2g" }).media).toBe(
      "economy",
    );
    expect(applyCurrentPreferences(peak, { effectiveType: "2g" }).media).toBe(
      "economy",
    );
    expect(applyCurrentPreferences(peak, { effectiveType: "3g" }).media).toBe(
      "standard",
    );
    expect(applyCurrentPreferences(peak, { effectiveType: "4g" }).media).toBe(
      "high",
    );
    expect(applyCurrentPreferences(peak, { effectiveType: "satellite" }).media).toBe(
      "high",
    );
  });

  it("keeps Save Data and Reduced Motion authoritative", () => {
    expect(
      getAdaptiveCapabilityMaximum({
        saveData: true,
        reducedMotion: true,
        effectiveType: "4g",
      }),
    ).toEqual({
      rendering: "enhanced",
      media: "economy",
      motion: "minimal",
    });
  });

  it("downgrades Motion, Media, Rendering and recovers in reverse order", () => {
    const first = downgradeConstraint({
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    });
    expect(first).toEqual({
      rendering: "enhanced",
      media: "high",
      motion: "standard",
    });

    expect(
      promoteConstraint(
        { rendering: "safe", media: "economy", motion: "minimal" },
        { rendering: "enhanced", media: "high", motion: "enhanced" },
      ),
    ).toEqual({
      rendering: "standard",
      media: "economy",
      motion: "minimal",
    });
  });
});
