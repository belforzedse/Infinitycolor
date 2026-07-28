export type RenderingTier = "safe" | "standard" | "enhanced";
export type MediaTier = "economy" | "standard" | "high";
export type MotionTier = "minimal" | "standard" | "enhanced";

export type AdaptiveQualityReason =
  | "default"
  | "reduced-motion"
  | "reduced-transparency"
  | "save-data"
  | "slow-connection"
  | "low-memory"
  | "low-cores"
  | "combined-capacity"
  | "repeated-loaf"
  | "severe-loaf"
  | "repeated-long-task"
  | "severe-long-task"
  | "raf-jank"
  | "session-constraint"
  | "force-safe"
  | "promotion";

export type AdaptiveQualityConstraint = {
  rendering: RenderingTier;
  media: MediaTier;
  motion: MotionTier;
};

export interface AdaptiveQualitySnapshot extends AdaptiveQualityConstraint {
  enabled: boolean;
  reducedTransparency: boolean;
  reason: AdaptiveQualityReason;
  routeGeneration: number;
}

export type AdaptiveQualityChange = {
  previous: AdaptiveQualitySnapshot;
  current: AdaptiveQualitySnapshot;
  reason: AdaptiveQualityReason;
};

export type AdaptiveCapabilities = {
  reducedMotion?: boolean;
  reducedTransparency?: boolean;
  saveData?: boolean;
  effectiveType?: string;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  finePointer?: boolean;
  hover?: boolean;
};

export type InitialAdaptiveClassification = {
  baselineConstraint: AdaptiveQualityConstraint;
  runtimeConstraint: AdaptiveQualityConstraint;
  snapshot: AdaptiveQualitySnapshot;
};

export type AdaptiveQualityBootstrap = AdaptiveQualitySnapshot & {
  schema: 2;
  policyVersion: string;
  buildVersion: string;
  createdAt: number;
  expiresAt: number;
  rolloutBucket: number;
  baselineConstraint: AdaptiveQualityConstraint;
  runtimeConstraint: AdaptiveQualityConstraint;
  penaltyExpiresAt: number | null;
  consecutiveSmoothWindows: number;
  lastBadAt: number | null;
  lastReason: AdaptiveQualityReason;
};

export type AdaptiveQualitySessionRecord = {
  schema: 2;
  policyVersion: string;
  buildVersion: string;
  createdAt: number;
  expiresAt: number;
  rolloutBucket: number;
  runtimeConstraint: AdaptiveQualityConstraint;
  penaltyExpiresAt: number | null;
  consecutiveSmoothWindows: number;
  lastBadAt: number | null;
  lastReason: AdaptiveQualityReason;
};

export type EnhancementFamily =
  | "hero-motion"
  | "carousel-motion"
  | "lottie-loader"
  | "quick-view"
  | "share"
  | "glass-surface"
  | "optional-gif"
  | "optional-video"
  | "secondary-media"
  | "social-media";

export type AdaptiveObserverKind = "none" | "loaf" | "long-task" | "raf";

export type AdaptiveObservationSummary = {
  observer: AdaptiveObserverKind;
  sampleCount: number;
  issueCount: number;
  severeCount: number;
};

declare global {
  interface Window {
    __INFINITY_AQ_BOOTSTRAP__?: AdaptiveQualityBootstrap;
    __INFINITY_AQ_E2E__?: {
      downgrade: (reason?: AdaptiveQualityReason) => void;
      setTier: (constraint: AdaptiveQualityConstraint) => void;
      startObservationWindow: (durationMs?: number) => void;
      completeObservationWindow: () => void;
      route: () => void;
      snapshot: () => AdaptiveQualitySnapshot;
    };
  }
}
