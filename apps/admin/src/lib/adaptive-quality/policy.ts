import { ADAPTIVE_QUALITY_POLICY_CONFIG } from "./config";
import type {
  AdaptiveCapabilities,
  AdaptiveQualityConstraint,
  AdaptiveQualityReason,
  AdaptiveQualitySnapshot,
  InitialAdaptiveClassification,
  MediaTier,
  MotionTier,
  RenderingTier,
} from "./types";

export const STANDARD_CONSTRAINT: AdaptiveQualityConstraint = Object.freeze({
  rendering: "standard",
  media: "standard",
  motion: "standard",
});

export const COMPATIBILITY_CONSTRAINT: AdaptiveQualityConstraint = Object.freeze({
  rendering: "enhanced",
  media: "high",
  motion: "enhanced",
});

export const SAFE_CONSTRAINT: AdaptiveQualityConstraint = Object.freeze({
  rendering: "safe",
  media: "economy",
  motion: "minimal",
});

const RENDERING_ORDER: RenderingTier[] = ["safe", "standard", "enhanced"];
const MEDIA_ORDER: MediaTier[] = ["economy", "standard", "high"];
const MOTION_ORDER: MotionTier[] = ["minimal", "standard", "enhanced"];

export function clampConstraint(
  value: AdaptiveQualityConstraint,
  maximum: AdaptiveQualityConstraint,
): AdaptiveQualityConstraint {
  return {
    rendering:
      RENDERING_ORDER[
        Math.min(
          RENDERING_ORDER.indexOf(value.rendering),
          RENDERING_ORDER.indexOf(maximum.rendering),
        )
      ],
    media:
      MEDIA_ORDER[
        Math.min(
          MEDIA_ORDER.indexOf(value.media),
          MEDIA_ORDER.indexOf(maximum.media),
        )
      ],
    motion:
      MOTION_ORDER[
        Math.min(
          MOTION_ORDER.indexOf(value.motion),
          MOTION_ORDER.indexOf(maximum.motion),
        )
      ],
  };
}

/**
 * Device admission is deliberately deterministic. A desktop reaches peak only
 * when it has a fine primary pointer, hover, at least eight logical processors,
 * and either an unavailable memory hint or a hint of at least 8 GiB.
 */
export function getAdaptiveDeviceBaseline(
  capabilities: AdaptiveCapabilities,
  admittedHighEndMobile = false,
): AdaptiveQualityConstraint {
  return isCapableDesktop(capabilities) || admittedHighEndMobile
    ? { ...COMPATIBILITY_CONSTRAINT }
    : { ...STANDARD_CONSTRAINT };
}

export function isCapableDesktop(capabilities: AdaptiveCapabilities): boolean {
  const { minimumHardwareConcurrency, minimumDeviceMemory } =
    ADAPTIVE_QUALITY_POLICY_CONFIG.desktop;
  const cores = capabilities.hardwareConcurrency;
  const memory = capabilities.deviceMemory;

  return Boolean(
    capabilities.finePointer === true &&
      capabilities.hover === true &&
      typeof cores === "number" &&
      Number.isInteger(cores) &&
      cores >= minimumHardwareConcurrency &&
      (memory === undefined ||
        (typeof memory === "number" &&
          Number.isFinite(memory) &&
          memory >= minimumDeviceMemory)),
  );
}

/**
 * This is the live preference/network overlay only. It is never persisted as
 * the runtime constraint.
 */
export function getAdaptiveCapabilityMaximum(
  capabilities: AdaptiveCapabilities,
): AdaptiveQualityConstraint {
  const maximum: AdaptiveQualityConstraint = { ...COMPATIBILITY_CONSTRAINT };

  if (capabilities.saveData || isVerySlowConnection(capabilities.effectiveType)) {
    maximum.media = "economy";
  } else if (capabilities.effectiveType === "3g") {
    maximum.media = "standard";
  }

  if (capabilities.reducedMotion) maximum.motion = "minimal";
  return maximum;
}

export function classifyAdaptiveQuality(
  capabilities: AdaptiveCapabilities,
  options: {
    persistedRuntimeConstraint?: AdaptiveQualityConstraint;
    admittedHighEndMobile?: boolean;
    routeGeneration?: number;
  } = {},
): InitialAdaptiveClassification {
  const baselineConstraint = getAdaptiveDeviceBaseline(
    capabilities,
    options.admittedHighEndMobile,
  );
  const runtimeConstraint = options.persistedRuntimeConstraint
    ? clampConstraint(baselineConstraint, options.persistedRuntimeConstraint)
    : { ...baselineConstraint };
  const runtimeConstrained = !areConstraintsEqual(
    runtimeConstraint,
    baselineConstraint,
  );
  const snapshot = applyCurrentPreferences(
    {
      enabled: true,
      ...runtimeConstraint,
      reducedTransparency: false,
      reason: runtimeConstrained ? "session-constraint" : "default",
      routeGeneration: options.routeGeneration ?? 0,
    },
    capabilities,
  );

  return {
    baselineConstraint,
    runtimeConstraint,
    snapshot,
  };
}

export function applyCurrentPreferences(
  snapshot: AdaptiveQualitySnapshot,
  capabilities: AdaptiveCapabilities,
): AdaptiveQualitySnapshot {
  const next = { ...snapshot };
  let reason = snapshot.reason;

  if (capabilities.reducedMotion) {
    next.motion = "minimal";
    reason = "reduced-motion";
  }

  if (capabilities.saveData) {
    next.media = "economy";
    reason = "save-data";
  } else if (isVerySlowConnection(capabilities.effectiveType)) {
    next.media = "economy";
    reason = "slow-connection";
  } else if (capabilities.effectiveType === "3g") {
    next.media =
      MEDIA_ORDER[
        Math.min(
          MEDIA_ORDER.indexOf(next.media),
          MEDIA_ORDER.indexOf("standard"),
        )
      ];
    reason = "slow-connection";
  }

  if (capabilities.reducedTransparency) {
    reason = "reduced-transparency";
  }

  return {
    ...next,
    reducedTransparency: capabilities.reducedTransparency === true,
    reason,
  };
}

export function downgradeConstraint(
  current: AdaptiveQualityConstraint,
): AdaptiveQualityConstraint | null {
  const motionIndex = MOTION_ORDER.indexOf(current.motion);
  if (motionIndex > 0) {
    return { ...current, motion: MOTION_ORDER[motionIndex - 1] };
  }

  const mediaIndex = MEDIA_ORDER.indexOf(current.media);
  if (mediaIndex > 0) {
    return { ...current, media: MEDIA_ORDER[mediaIndex - 1] };
  }

  const renderingIndex = RENDERING_ORDER.indexOf(current.rendering);
  if (renderingIndex > 0) {
    return { ...current, rendering: RENDERING_ORDER[renderingIndex - 1] };
  }

  return null;
}

export function promoteConstraint(
  current: AdaptiveQualityConstraint,
  maximum: AdaptiveQualityConstraint = COMPATIBILITY_CONSTRAINT,
): AdaptiveQualityConstraint | null {
  const renderingIndex = RENDERING_ORDER.indexOf(current.rendering);
  const maximumRenderingIndex = RENDERING_ORDER.indexOf(maximum.rendering);
  if (renderingIndex < maximumRenderingIndex) {
    return { ...current, rendering: RENDERING_ORDER[renderingIndex + 1] };
  }

  const mediaIndex = MEDIA_ORDER.indexOf(current.media);
  const maximumMediaIndex = MEDIA_ORDER.indexOf(maximum.media);
  if (mediaIndex < maximumMediaIndex) {
    return { ...current, media: MEDIA_ORDER[mediaIndex + 1] };
  }

  const motionIndex = MOTION_ORDER.indexOf(current.motion);
  const maximumMotionIndex = MOTION_ORDER.indexOf(maximum.motion);
  if (motionIndex < maximumMotionIndex) {
    return { ...current, motion: MOTION_ORDER[motionIndex + 1] };
  }

  return null;
}

export function isVerySlowConnection(effectiveType?: string): boolean {
  return effectiveType === "slow-2g" || effectiveType === "2g";
}

export function areConstraintsEqual(
  left: AdaptiveQualityConstraint,
  right: AdaptiveQualityConstraint,
): boolean {
  return (
    left.rendering === right.rendering &&
    left.media === right.media &&
    left.motion === right.motion
  );
}

export function isConstraintBelow(
  current: AdaptiveQualityConstraint,
  maximum: AdaptiveQualityConstraint,
): boolean {
  return !areConstraintsEqual(clampConstraint(maximum, current), maximum);
}

export function isAdaptiveConstraint(value: unknown): value is AdaptiveQualityConstraint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AdaptiveQualityConstraint>;
  return (
    RENDERING_ORDER.includes(candidate.rendering as RenderingTier) &&
    MEDIA_ORDER.includes(candidate.media as MediaTier) &&
    MOTION_ORDER.includes(candidate.motion as MotionTier)
  );
}

export function isAdaptiveReason(value: unknown): value is AdaptiveQualityReason {
  return (
    typeof value === "string" &&
    [
      "default",
      "reduced-motion",
      "reduced-transparency",
      "save-data",
      "slow-connection",
      "low-memory",
      "low-cores",
      "combined-capacity",
      "repeated-loaf",
      "severe-loaf",
      "repeated-long-task",
      "severe-long-task",
      "raf-jank",
      "session-constraint",
      "force-safe",
      "promotion",
    ].includes(value)
  );
}
