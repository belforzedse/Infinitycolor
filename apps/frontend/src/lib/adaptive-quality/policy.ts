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
      MEDIA_ORDER[Math.min(MEDIA_ORDER.indexOf(value.media), MEDIA_ORDER.indexOf(maximum.media))],
    motion:
      MOTION_ORDER[
        Math.min(MOTION_ORDER.indexOf(value.motion), MOTION_ORDER.indexOf(maximum.motion))
      ],
  };
}

export function getAdaptiveCapabilityMaximum(
  capabilities: AdaptiveCapabilities,
): AdaptiveQualityConstraint {
  const maximum: AdaptiveQualityConstraint = { ...COMPATIBILITY_CONSTRAINT };

  if (capabilities.saveData || isSlowConnection(capabilities.effectiveType)) {
    maximum.media = "economy";
  }

  if (capabilities.reducedMotion) maximum.motion = "minimal";

  return maximum;
}

export function classifyAdaptiveQuality(
  capabilities: AdaptiveCapabilities,
  persistedConstraint?: AdaptiveQualityConstraint,
  routeGeneration = 0,
): InitialAdaptiveClassification {
  let constraint: AdaptiveQualityConstraint = { ...STANDARD_CONSTRAINT };
  const reasons: AdaptiveQualityReason[] = [];

  if (persistedConstraint) {
    const clamped = clampConstraint(constraint, persistedConstraint);
    if (
      clamped.rendering !== constraint.rendering ||
      clamped.media !== constraint.media ||
      clamped.motion !== constraint.motion
    ) {
      reasons.push("session-constraint");
    }
    constraint = clamped;
  }

  const snapshot = applyCurrentPreferences(
    {
      enabled: true,
      ...constraint,
      reducedTransparency: false,
      reason: reasons[0] || "default",
      routeGeneration,
    },
    capabilities,
  );

  if (capabilities.reducedMotion) reasons.push("reduced-motion");
  if (capabilities.reducedTransparency) reasons.push("reduced-transparency");
  if (capabilities.saveData) reasons.push("save-data");
  if (isSlowConnection(capabilities.effectiveType)) reasons.push("slow-connection");

  const uniqueReasons = Array.from(new Set(reasons));
  const persistedConstraintForSession = clampConstraint(constraint, snapshot);

  return {
    constraint: persistedConstraintForSession,
    snapshot: {
      ...snapshot,
      reason: uniqueReasons[0] || "default",
    },
    reasons: uniqueReasons.length ? uniqueReasons : ["default"],
  };
}

export function applyCurrentPreferences(
  snapshot: AdaptiveQualitySnapshot,
  capabilities: AdaptiveCapabilities,
): AdaptiveQualitySnapshot {
  let next = snapshot;
  let reason = snapshot.reason;

  if (capabilities.reducedMotion) {
    next = { ...next, motion: "minimal" };
    reason = "reduced-motion";
  }

  if (capabilities.saveData) {
    next = { ...next, media: "economy" };
    reason = "save-data";
  } else if (isSlowConnection(capabilities.effectiveType)) {
    next = { ...next, media: "economy" };
    reason = "slow-connection";
  }

  if (capabilities.reducedTransparency) {
    reason = "reduced-transparency";
  }

  return {
    ...next,
    reducedTransparency: Boolean(capabilities.reducedTransparency),
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

export function isSlowConnection(effectiveType?: string): boolean {
  return effectiveType === "slow-2g" || effectiveType === "2g" || effectiveType === "3g";
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
