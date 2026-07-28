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
};

export type InitialAdaptiveClassification = {
  constraint: AdaptiveQualityConstraint;
  snapshot: AdaptiveQualitySnapshot;
  reasons: AdaptiveQualityReason[];
};

export type AdaptiveQualityBootstrap = AdaptiveQualitySnapshot & {
  schema: 1;
  policyVersion: string;
  buildVersion: string;
  expiresAt: number;
  rolloutBucket: number;
  reasons: AdaptiveQualityReason[];
  constraint: AdaptiveQualityConstraint;
};

export type AdaptiveQualitySessionRecord = {
  schema: 1;
  policyVersion: string;
  buildVersion: string;
  expiresAt: number;
  rolloutBucket: number;
  constraint: AdaptiveQualityConstraint;
  reasons: AdaptiveQualityReason[];
  smoothWindows: number;
  smoothRouteGenerations: number;
  lastSmoothRouteGeneration: number;
  sessionHadDowngrade: boolean;
  sessionHadSevereEvent: boolean;
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
      route: () => void;
      snapshot: () => AdaptiveQualitySnapshot;
    };
  }
}
