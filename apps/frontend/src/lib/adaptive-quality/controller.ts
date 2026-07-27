import {
  ADAPTIVE_QUALITY_BUILD_VERSION,
  ADAPTIVE_QUALITY_EVENT,
  ADAPTIVE_QUALITY_FLAGS,
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_PROMOTION_EVENT,
  ADAPTIVE_QUALITY_SCHEMA,
} from "./config";
import { getNetworkConnection, readAdaptiveCapabilities, safeMediaQuery } from "./capabilities";
import {
  applyCurrentPreferences,
  clampConstraint,
  classifyAdaptiveQuality,
  COMPATIBILITY_CONSTRAINT,
  downgradeConstraint,
  getAdaptiveCapabilityMaximum,
  isAdaptiveConstraint,
  isAdaptiveReason,
  promoteConstraint,
  SAFE_CONSTRAINT,
  STANDARD_CONSTRAINT,
} from "./policy";
import {
  createAdaptiveQualitySessionRecord,
  createRolloutBucket,
  readAdaptiveQualitySession,
  writeAdaptiveQualitySession,
} from "./storage";
import { applyAdaptiveQualityAttributes, clearAdaptiveQualityAttributes } from "./dom";
import { resolveHighEndUserAgentAdmission } from "./high-end-user-agent";
import type {
  AdaptiveQualityBootstrap,
  AdaptiveQualityChange,
  AdaptiveQualityConstraint,
  AdaptiveQualityReason,
  AdaptiveQualitySessionRecord,
  AdaptiveQualitySnapshot,
  AdaptiveObservationSummary,
  AdaptiveObserverKind,
  EnhancementFamily,
  MediaTier,
  MotionTier,
  RenderingTier,
} from "./types";

const DEFAULT_OBSERVATION_WINDOW_MS = 8_000;
const ENHANCEMENT_OBSERVATION_WINDOW_MS = 5_000;
const DOWNGRADE_COOLDOWN_MS = 15_000;
const MAX_RAF_SAMPLES = 240;
const RAF_WARMUP_SAMPLES = 10;

const SERVER_SNAPSHOT: AdaptiveQualitySnapshot = Object.freeze({
  enabled: true,
  ...STANDARD_CONSTRAINT,
  reducedTransparency: false,
  reason: "default",
  routeGeneration: 0,
});

type Listener = () => void;
type PerformanceEntryWithBlocking = PerformanceEntry & {
  blockingDuration?: number;
};

let snapshot: AdaptiveQualitySnapshot = SERVER_SNAPSHOT;
let didResolveBootstrap = false;
let subscribers = new Set<Listener>();
let controllerReferences = 0;
let controllerCleanups: Array<() => void> = [];
let observationCleanup: (() => void) | null = null;
let observationFinalize: (() => void) | null = null;
let observationTimeout = 0;
let currentWindowHadIssue = false;
let lastDowngradeAt = Number.NEGATIVE_INFINITY;
let sessionConstraint: AdaptiveQualityConstraint = { ...STANDARD_CONSTRAINT };
let sessionRecord: AdaptiveQualitySessionRecord | null = null;
let rolloutBucket = 0;
let pendingPromotion = false;
let promotionEventSent = false;
let promotionAdmission: "pending" | "eligible" | "ineligible" = "pending";
let promotionAdmissionGeneration = 0;
let loadedEnhancements = new Set<EnhancementFamily>();
let observationSummary: AdaptiveObservationSummary = {
  observer: "none",
  sampleCount: 0,
  issueCount: 0,
  severeCount: 0,
};

export function getSnapshot(): AdaptiveQualitySnapshot {
  resolveBootstrapSnapshot();
  return snapshot;
}

export function getServerSnapshot(): AdaptiveQualitySnapshot {
  return SERVER_SNAPSHOT;
}

export function subscribe(listener: Listener): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function startAdaptiveQualityController(): () => void {
  resolveBootstrapSnapshot();
  controllerReferences += 1;
  if (controllerReferences > 1) {
    return releaseControllerReference;
  }

  if (!snapshot.enabled) return releaseControllerReference;

  applyAdaptiveQualityAttributes(snapshot);
  controllerCleanups = installPreferenceListeners();
  installE2EAdapter();
  resolvePromotionAdmission();

  if (ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade) {
    startAdaptiveObservationWindow(DEFAULT_OBSERVATION_WINDOW_MS);
  }

  return releaseControllerReference;
}

export function notifyAdaptiveRoute(): void {
  resolveBootstrapSnapshot();
  if (!snapshot.enabled) return;

  finishObservationWindow(false);
  loadedEnhancements = new Set();
  observationSummary = {
    observer: "none",
    sampleCount: 0,
    issueCount: 0,
    severeCount: 0,
  };
  const capabilities = readAdaptiveCapabilities();
  const maximum = getAdaptiveCapabilityMaximum(capabilities);
  let reason: AdaptiveQualityReason = snapshot.reason;

  if (pendingPromotion && ADAPTIVE_QUALITY_FLAGS.promotion) {
    const promoted = promoteConstraint(sessionConstraint, maximum);
    if (promoted) {
      sessionConstraint = promoted;
      reason = "promotion";
    }
    pendingPromotion = false;
  }

  sessionConstraint = clampConstraint(sessionConstraint, maximum);
  const next = applyCurrentPreferences(
    {
      enabled: true,
      ...sessionConstraint,
      reducedTransparency: false,
      reason,
      routeGeneration: snapshot.routeGeneration + 1,
    },
    capabilities,
  );

  updateSnapshot(next, next.reason);
  persistSession([next.reason]);

  if (ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade) {
    startAdaptiveObservationWindow(DEFAULT_OBSERVATION_WINDOW_MS);
  }
}

export function startAdaptiveObservationWindow(durationMs = DEFAULT_OBSERVATION_WINDOW_MS): void {
  resolveBootstrapSnapshot();
  if (
    !snapshot.enabled ||
    !ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade ||
    typeof window === "undefined" ||
    document.visibilityState === "hidden"
  ) {
    return;
  }

  finishObservationWindow(false);
  currentWindowHadIssue = false;
  const duration = Math.max(1_000, Math.min(10_000, durationMs));
  const supported =
    typeof PerformanceObserver !== "undefined" ? PerformanceObserver.supportedEntryTypes || [] : [];

  if (supported.includes("long-animation-frame")) {
    observationCleanup = observeLongAnimationFrames();
  } else if (supported.includes("longtask")) {
    observationCleanup = observeLongTasks();
  } else {
    observationCleanup = observeAnimationFrames();
  }

  observationTimeout = window.setTimeout(() => {
    finishObservationWindow(true);
  }, duration);
}

export function startEnhancementObservationWindow(): void {
  startAdaptiveObservationWindow(ENHANCEMENT_OBSERVATION_WINDOW_MS);
}

export function noteEnhancementLoaded(family: EnhancementFamily): void {
  if (loadedEnhancements.has(family)) return;
  loadedEnhancements.add(family);
  startEnhancementObservationWindow();
}

export function getLoadedEnhancements(): ReadonlySet<EnhancementFamily> {
  return new Set(loadedEnhancements);
}

export function getAdaptiveObservationSummary(): AdaptiveObservationSummary {
  return { ...observationSummary };
}

export function getAdaptiveRolloutBucket(): number {
  resolveBootstrapSnapshot();
  return rolloutBucket;
}

export function clearLoadedEnhancements(): void {
  loadedEnhancements = new Set();
}

export function isEnhancementEligible(
  requirement: Partial<AdaptiveQualityConstraint>,
  value: AdaptiveQualitySnapshot = getSnapshot(),
): boolean {
  if (!value.enabled) return true;

  return (
    (requirement.rendering === undefined ||
      isTierAtLeast(value.rendering, requirement.rendering, ["safe", "standard", "enhanced"])) &&
    (requirement.media === undefined ||
      isTierAtLeast(value.media, requirement.media, ["economy", "standard", "high"])) &&
    (requirement.motion === undefined ||
      isTierAtLeast(value.motion, requirement.motion, ["minimal", "standard", "enhanced"]))
  );
}

function resolveBootstrapSnapshot(): void {
  if (didResolveBootstrap || typeof window === "undefined") return;
  didResolveBootstrap = true;

  const path = window.location.pathname;
  const excludedFromAdaptiveQuality = path === "/super-admin" || path.startsWith("/super-admin/");

  if (!ADAPTIVE_QUALITY_FLAGS.enabled || excludedFromAdaptiveQuality) {
    snapshot = {
      enabled: false,
      ...COMPATIBILITY_CONSTRAINT,
      reducedTransparency: false,
      reason: "default",
      routeGeneration: 0,
    };
    return;
  }

  const bootstrap = window.__INFINITY_AQ_BOOTSTRAP__;
  if (isValidBootstrap(bootstrap)) {
    snapshot = {
      enabled: bootstrap.enabled,
      rendering: bootstrap.rendering,
      media: bootstrap.media,
      motion: bootstrap.motion,
      reducedTransparency: bootstrap.reducedTransparency,
      reason: bootstrap.reason,
      routeGeneration: bootstrap.routeGeneration,
    };
    sessionConstraint = bootstrap.constraint;
    rolloutBucket = bootstrap.rolloutBucket;
    sessionRecord = readAdaptiveQualitySession();
    return;
  }

  sessionRecord = readAdaptiveQualitySession();
  const capabilities = readAdaptiveCapabilities();
  const classification = classifyAdaptiveQuality(capabilities, sessionRecord?.constraint);
  rolloutBucket = sessionRecord?.rolloutBucket ?? createRolloutBucket();
  const inCohort =
    ADAPTIVE_QUALITY_FLAGS.forceSafe || rolloutBucket < ADAPTIVE_QUALITY_FLAGS.rolloutPercent * 100;

  if (!inCohort) {
    snapshot = {
      enabled: false,
      ...COMPATIBILITY_CONSTRAINT,
      reducedTransparency: false,
      reason: "default",
      routeGeneration: 0,
    };
    return;
  }

  sessionConstraint = ADAPTIVE_QUALITY_FLAGS.forceSafe
    ? { ...SAFE_CONSTRAINT }
    : classification.constraint;
  snapshot = ADAPTIVE_QUALITY_FLAGS.forceSafe
    ? {
        enabled: true,
        ...SAFE_CONSTRAINT,
        reducedTransparency: classification.snapshot.reducedTransparency,
        reason: "force-safe",
        routeGeneration: 0,
      }
    : classification.snapshot;
  persistSession(classification.reasons);
  applyAdaptiveQualityAttributes(snapshot);
}

function isValidBootstrap(
  value: AdaptiveQualityBootstrap | undefined,
): value is AdaptiveQualityBootstrap {
  return Boolean(
    value &&
      value.schema === ADAPTIVE_QUALITY_SCHEMA &&
      value.policyVersion === ADAPTIVE_QUALITY_POLICY_VERSION &&
      value.buildVersion === ADAPTIVE_QUALITY_BUILD_VERSION &&
      typeof value.expiresAt === "number" &&
      value.expiresAt > Date.now() &&
      Number.isInteger(value.rolloutBucket) &&
      value.rolloutBucket >= 0 &&
      value.rolloutBucket <= 9999 &&
      typeof value.enabled === "boolean" &&
      typeof value.reducedTransparency === "boolean" &&
      Number.isInteger(value.routeGeneration) &&
      value.routeGeneration >= 0 &&
      isAdaptiveConstraint(value) &&
      isAdaptiveConstraint(value.constraint) &&
      isAdaptiveReason(value.reason) &&
      Array.isArray(value.reasons) &&
      value.reasons.every(isAdaptiveReason),
  );
}

function releaseControllerReference(): void {
  controllerReferences = Math.max(0, controllerReferences - 1);
  if (controllerReferences > 0) return;

  finishObservationWindow(false);
  promotionAdmissionGeneration += 1;
  for (const cleanup of controllerCleanups.splice(0)) cleanup();
  if (typeof window !== "undefined") {
    delete window.__INFINITY_AQ_E2E__;
  }
  clearAdaptiveQualityAttributes();
}

function installPreferenceListeners(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  const reducedMotion = safeMediaQuery("(prefers-reduced-motion: reduce)");
  const reducedTransparency = safeMediaQuery("(prefers-reduced-transparency: reduce)");

  if (reducedMotion) {
    cleanups.push(
      listenToMediaQuery(reducedMotion, () => {
        if (!reducedMotion.matches || snapshot.motion === "minimal") return;
        sessionConstraint = {
          ...sessionConstraint,
          motion: "minimal",
        };
        updateSnapshot(
          { ...snapshot, motion: "minimal", reason: "reduced-motion" },
          "reduced-motion",
        );
        persistSession(["reduced-motion"]);
      }),
    );
  }

  if (reducedTransparency) {
    cleanups.push(
      listenToMediaQuery(reducedTransparency, () => {
        if (!reducedTransparency.matches || snapshot.reducedTransparency) return;
        updateSnapshot(
          {
            ...snapshot,
            reducedTransparency: true,
            reason: "reduced-transparency",
          },
          "reduced-transparency",
        );
        persistSession(["reduced-transparency"]);
      }),
    );
  }

  const connection = getNetworkConnection();
  if (connection) {
    const handleConnectionChange = () => {
      const capabilities = readAdaptiveCapabilities();
      if (
        (capabilities.saveData ||
          capabilities.effectiveType === "slow-2g" ||
          capabilities.effectiveType === "2g" ||
          capabilities.effectiveType === "3g") &&
        snapshot.media !== "economy"
      ) {
        const reason = capabilities.saveData ? "save-data" : "slow-connection";
        sessionConstraint = {
          ...sessionConstraint,
          media: "economy",
        };
        updateSnapshot({ ...snapshot, media: "economy", reason }, reason);
        persistSession([reason]);
      }
    };
    connection.addEventListener?.("change", handleConnectionChange);
    cleanups.push(() => connection.removeEventListener?.("change", handleConnectionChange));
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      finishObservationWindow(false);
    } else if (ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade) {
      startAdaptiveObservationWindow(DEFAULT_OBSERVATION_WINDOW_MS);
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  cleanups.push(() => document.removeEventListener("visibilitychange", handleVisibilityChange));

  return cleanups;
}

function listenToMediaQuery(mediaQuery: MediaQueryList, listener: () => void): () => void {
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }

  const legacy = mediaQuery as MediaQueryList & {
    addListener?: (listener: () => void) => void;
    removeListener?: (listener: () => void) => void;
  };
  legacy.addListener?.(listener);
  return () => legacy.removeListener?.(listener);
}

function observeLongAnimationFrames(): () => void {
  observationFinalize = null;
  let repeated = 0;
  const observer = new PerformanceObserver((list) => {
    if (document.visibilityState === "hidden") return;
    const entries = list.getEntries() as PerformanceEntryWithBlocking[];
    observationSummary.sampleCount += entries.length;
    for (const entry of entries) {
      const blockingDuration = entry.blockingDuration || 0;
      if (entry.duration >= 300 || blockingDuration >= 150) {
        observationSummary.issueCount += 1;
        observationSummary.severeCount += 1;
        currentWindowHadIssue = true;
        requestDowngrade("severe-loaf", true);
        continue;
      }
      if (entry.duration >= 120 || blockingDuration >= 50) {
        observationSummary.issueCount += 1;
        repeated += 1;
      }
    }
    if (repeated >= 3) {
      currentWindowHadIssue = true;
      requestDowngrade("repeated-loaf", false);
      repeated = 0;
    }
  });

  try {
    observer.observe({ type: "long-animation-frame", buffered: false });
    setObservationKind("loaf");
    return () => observer.disconnect();
  } catch {
    observer.disconnect();
    return observeAnimationFrames();
  }
}

function observeLongTasks(): () => void {
  observationFinalize = null;
  let repeated = 0;
  const observer = new PerformanceObserver((list) => {
    if (document.visibilityState === "hidden") return;
    const entries = list.getEntries();
    observationSummary.sampleCount += entries.length;
    for (const entry of entries) {
      if (entry.duration >= 300) {
        observationSummary.issueCount += 1;
        observationSummary.severeCount += 1;
        currentWindowHadIssue = true;
        requestDowngrade("severe-long-task", true);
        continue;
      }
      if (entry.duration >= 80) {
        observationSummary.issueCount += 1;
        repeated += 1;
      }
    }
    if (repeated >= 3) {
      currentWindowHadIssue = true;
      requestDowngrade("repeated-long-task", false);
      repeated = 0;
    }
  });

  try {
    observer.observe({ type: "longtask", buffered: false });
    setObservationKind("long-task");
    return () => observer.disconnect();
  } catch {
    observer.disconnect();
    return observeAnimationFrames();
  }
}

function observeAnimationFrames(): () => void {
  setObservationKind("raf");
  let frameId = 0;
  let previousTime: number | null = null;
  const deltas: number[] = [];

  const sample = (time: number) => {
    if (document.visibilityState === "hidden") return;
    if (previousTime !== null) deltas.push(time - previousTime);
    previousTime = time;

    if (deltas.length >= MAX_RAF_SAMPLES) {
      evaluateAnimationFrames(deltas);
      observationFinalize = null;
      return;
    }
    frameId = window.requestAnimationFrame(sample);
  };

  frameId = window.requestAnimationFrame(sample);
  observationFinalize = () => evaluateAnimationFrames(deltas);
  return () => {
    window.cancelAnimationFrame(frameId);
  };
}

function evaluateAnimationFrames(allDeltas: number[]): void {
  const deltas = allDeltas.slice(RAF_WARMUP_SAMPLES);
  if (deltas.length < 20) return;
  const slowFrames = deltas.filter((delta) => delta > 50).length;
  observationSummary.sampleCount += deltas.length;
  observationSummary.issueCount += slowFrames;
  const sorted = [...deltas].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];

  if (slowFrames >= 5 && p95 > 40) {
    currentWindowHadIssue = true;
    requestDowngrade("raf-jank", false);
  }
}

function setObservationKind(kind: AdaptiveObserverKind): void {
  if (observationSummary.observer === "none") {
    observationSummary.observer = kind;
  }
}

function requestDowngrade(
  reason: AdaptiveQualityReason,
  severe: boolean,
  ignoreCooldown = false,
): void {
  if (!snapshot.enabled) return;
  if (severe) {
    sessionRecord =
      sessionRecord ||
      createAdaptiveQualitySessionRecord({
        constraint: sessionConstraint,
        rolloutBucket,
      });
    sessionRecord.sessionHadSevereEvent = true;
    persistSession([reason]);
  }

  const now = performance.now();
  if (!ignoreCooldown && now - lastDowngradeAt < DOWNGRADE_COOLDOWN_MS) return;
  const downgraded = downgradeConstraint(snapshot);
  if (!downgraded) return;

  lastDowngradeAt = now;
  sessionConstraint = clampConstraint(sessionConstraint, downgraded);
  sessionRecord = {
    ...(sessionRecord ||
      createAdaptiveQualitySessionRecord({
        constraint: sessionConstraint,
        rolloutBucket,
      })),
    constraint: sessionConstraint,
    smoothWindows: 0,
    smoothRouteGenerations: 0,
    sessionHadDowngrade: true,
    sessionHadSevereEvent: severe || sessionRecord?.sessionHadSevereEvent === true,
  };

  updateSnapshot(
    {
      ...snapshot,
      ...downgraded,
      reason,
    },
    reason,
  );
  persistSession([reason]);
}

function updateSnapshot(next: AdaptiveQualitySnapshot, reason: AdaptiveQualityReason): void {
  if (
    snapshot.enabled === next.enabled &&
    snapshot.rendering === next.rendering &&
    snapshot.media === next.media &&
    snapshot.motion === next.motion &&
    snapshot.reducedTransparency === next.reducedTransparency &&
    snapshot.reason === next.reason &&
    snapshot.routeGeneration === next.routeGeneration
  ) {
    applyAdaptiveQualityAttributes(next);
    return;
  }

  const previous = snapshot;
  snapshot = Object.freeze({ ...next });
  applyAdaptiveQualityAttributes(snapshot);
  subscribers.forEach((listener) => listener());

  if (typeof window !== "undefined") {
    const detail: AdaptiveQualityChange = { previous, current: snapshot, reason };
    window.dispatchEvent(
      new CustomEvent<AdaptiveQualityChange>(ADAPTIVE_QUALITY_EVENT, { detail }),
    );
  }
}

function finishObservationWindow(recordSmoothWindow: boolean): void {
  if (typeof window !== "undefined" && observationTimeout) {
    window.clearTimeout(observationTimeout);
  }
  observationTimeout = 0;
  const finalize = observationFinalize;
  observationFinalize = null;
  if (recordSmoothWindow) finalize?.();
  const cleanup = observationCleanup;
  observationCleanup = null;
  cleanup?.();

  if (!recordSmoothWindow || !snapshot.enabled) return;
  sessionRecord =
    sessionRecord ||
    createAdaptiveQualitySessionRecord({
      constraint: sessionConstraint,
      rolloutBucket,
    });
  if (currentWindowHadIssue) {
    sessionRecord.smoothWindows = 0;
    sessionRecord.smoothRouteGenerations = 0;
    sessionRecord.lastSmoothRouteGeneration = 0;
    persistSession();
    return;
  }

  sessionRecord.smoothWindows += 1;
  if (sessionRecord.lastSmoothRouteGeneration !== snapshot.routeGeneration) {
    sessionRecord.smoothRouteGenerations += 1;
    sessionRecord.lastSmoothRouteGeneration = snapshot.routeGeneration;
  }
  persistSession();

  queuePromotionIfEligible();
}

function resolvePromotionAdmission(): void {
  if (!ADAPTIVE_QUALITY_FLAGS.promotion || typeof window === "undefined") {
    promotionAdmission = "ineligible";
    return;
  }

  promotionAdmission = "pending";
  const generation = ++promotionAdmissionGeneration;
  void resolveHighEndUserAgentAdmission(window.navigator).then((decision) => {
    if (generation !== promotionAdmissionGeneration || controllerReferences === 0) {
      return;
    }
    promotionAdmission = decision.eligible ? "eligible" : "ineligible";
    if (promotionAdmission === "eligible") {
      queuePromotionIfEligible();
    }
  });
}

function queuePromotionIfEligible(): void {
  if (
    !sessionRecord ||
    sessionRecord.smoothWindows < 3 ||
    sessionRecord.smoothRouteGenerations < 2 ||
    sessionRecord.sessionHadDowngrade ||
    sessionRecord.sessionHadSevereEvent ||
    promotionAdmission !== "eligible"
  ) {
    return;
  }

  pendingPromotion = true;
  if (!promotionEventSent && typeof window !== "undefined") {
    promotionEventSent = true;
    window.dispatchEvent(new Event(ADAPTIVE_QUALITY_PROMOTION_EVENT));
  }
}

function persistSession(reasons: AdaptiveQualityReason[] = []): void {
  if (typeof window === "undefined" || !snapshot.enabled) return;
  const previous =
    sessionRecord ||
    readAdaptiveQualitySession() ||
    createAdaptiveQualitySessionRecord({
      constraint: sessionConstraint,
      rolloutBucket: rolloutBucket || createRolloutBucket(),
    });

  rolloutBucket = previous.rolloutBucket;
  const persistedReasons = reasons.length
    ? Array.from(new Set([...previous.reasons, ...reasons]))
    : previous.reasons;
  sessionRecord = {
    ...createAdaptiveQualitySessionRecord({
      constraint: sessionConstraint,
      rolloutBucket,
      reasons: persistedReasons,
      previous,
    }),
    smoothWindows: previous.smoothWindows,
    smoothRouteGenerations: previous.smoothRouteGenerations,
    lastSmoothRouteGeneration: previous.lastSmoothRouteGeneration,
    sessionHadDowngrade: previous.sessionHadDowngrade,
    sessionHadSevereEvent: previous.sessionHadSevereEvent,
  };
  writeAdaptiveQualitySession(sessionRecord);
}

function installE2EAdapter(): void {
  if (!ADAPTIVE_QUALITY_FLAGS.e2e || typeof window === "undefined") return;
  window.__INFINITY_AQ_E2E__ = {
    downgrade: (reason = "raf-jank") => {
      requestDowngrade(reason, reason.startsWith("severe-"), true);
    },
    setTier: (constraint) => {
      if (!isAdaptiveConstraint(constraint)) return;
      sessionConstraint = { ...constraint };
      updateSnapshot(
        {
          ...snapshot,
          ...constraint,
          enabled: true,
          reason: "default",
        },
        "default",
      );
    },
    startObservationWindow: (durationMs) => startAdaptiveObservationWindow(durationMs),
    route: notifyAdaptiveRoute,
    snapshot: () => getSnapshot(),
  };
}

function isTierAtLeast<T extends RenderingTier | MediaTier | MotionTier>(
  current: T,
  required: T,
  order: readonly T[],
): boolean {
  return order.indexOf(current) >= order.indexOf(required);
}

export function __resetAdaptiveQualityForTesting(): void {
  if (process.env.NODE_ENV === "production") return;
  finishObservationWindow(false);
  for (const cleanup of controllerCleanups.splice(0)) cleanup();
  subscribers = new Set();
  snapshot = SERVER_SNAPSHOT;
  didResolveBootstrap = false;
  controllerReferences = 0;
  currentWindowHadIssue = false;
  lastDowngradeAt = Number.NEGATIVE_INFINITY;
  sessionConstraint = { ...STANDARD_CONSTRAINT };
  sessionRecord = null;
  rolloutBucket = 0;
  pendingPromotion = false;
  promotionEventSent = false;
  promotionAdmission = "pending";
  promotionAdmissionGeneration += 1;
  loadedEnhancements = new Set();
  observationSummary = {
    observer: "none",
    sampleCount: 0,
    issueCount: 0,
    severeCount: 0,
  };
  if (typeof document !== "undefined") clearAdaptiveQualityAttributes();
}

export function __requestAdaptiveDowngradeForTesting(
  reason: AdaptiveQualityReason = "raf-jank",
  severe = false,
): void {
  if (process.env.NODE_ENV === "production") return;
  resolveBootstrapSnapshot();
  requestDowngrade(reason, severe, true);
}
