import {
  ADAPTIVE_QUALITY_BUILD_VERSION,
  ADAPTIVE_QUALITY_EVENT,
  ADAPTIVE_QUALITY_FLAGS,
  ADAPTIVE_QUALITY_PENALTY_TTL_MS,
  ADAPTIVE_QUALITY_POLICY_CONFIG,
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_PROMOTION_EVENT,
  ADAPTIVE_QUALITY_SCHEMA,
  ADAPTIVE_QUALITY_SESSION_TTL_MS,
} from "./config";
import {
  getNetworkConnection,
  readAdaptiveCapabilities,
  safeMediaQuery,
} from "./capabilities";
import {
  applyCurrentPreferences,
  areConstraintsEqual,
  classifyAdaptiveQuality,
  clampConstraint,
  COMPATIBILITY_CONSTRAINT,
  downgradeConstraint,
  isAdaptiveConstraint,
  isAdaptiveReason,
  isConstraintBelow,
  promoteConstraint,
  SAFE_CONSTRAINT,
  STANDARD_CONSTRAINT,
} from "./policy";
import {
  createAdaptiveQualitySessionRecord,
  createRolloutBucket,
  readAdaptiveQualitySession,
  removeLegacyAdaptiveQualitySessions,
  writeAdaptiveQualitySession,
} from "./storage";
import {
  applyAdaptiveQualityAttributes,
  clearAdaptiveQualityAttributes,
} from "./dom";
import {
  classifyHighEndUserAgent,
  resolveHighEndUserAgentAdmission,
} from "./high-end-user-agent";
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

const {
  initialWindowMs: DEFAULT_OBSERVATION_WINDOW_MS,
  enhancementExtensionMs: ENHANCEMENT_OBSERVATION_WINDOW_MS,
  maximumWindowMs: MAXIMUM_OBSERVATION_WINDOW_MS,
  downgradeCooldownMs: DOWNGRADE_COOLDOWN_MS,
  recoveryWindows: RECOVERY_WINDOWS,
  minimumRecoveryDelayMs: MINIMUM_RECOVERY_DELAY_MS,
} = ADAPTIVE_QUALITY_POLICY_CONFIG.observation;
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
let observationWindowStartedAt = 0;
let observationDeadlineAt = 0;
let currentWindowHadIssue = false;
let lastDowngradeAt = Number.NEGATIVE_INFINITY;
let deviceBaseline: AdaptiveQualityConstraint = { ...STANDARD_CONSTRAINT };
let runtimeConstraint: AdaptiveQualityConstraint = { ...STANDARD_CONSTRAINT };
let sessionRecord: AdaptiveQualitySessionRecord | null = null;
let rolloutBucket = 0;
let mobileAdmissionEligible = false;
let admissionGeneration = 0;
let penaltyExpiryTimeout = 0;
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
  if (controllerReferences > 1) return releaseControllerReference;
  if (!snapshot.enabled) return releaseControllerReference;

  applyAdaptiveQualityAttributes(snapshot);
  controllerCleanups = installPreferenceListeners();
  installE2EAdapter();
  resolveMobileAdmission();
  schedulePenaltyExpiry();

  if (ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade) {
    startAdaptiveObservationWindow(DEFAULT_OBSERVATION_WINDOW_MS);
  }

  return releaseControllerReference;
}

export function notifyAdaptiveRoute(): void {
  resolveBootstrapSnapshot();
  if (!snapshot.enabled) return;

  cancelObservationWindow(true);
  loadedEnhancements = new Set();
  observationSummary = {
    observer: "none",
    sampleCount: 0,
    issueCount: 0,
    severeCount: 0,
  };
  expireRuntimePenaltyIfNeeded();
  recomputeEffectiveSnapshot(snapshot.routeGeneration + 1);
  persistSession();

  if (ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade) {
    startAdaptiveObservationWindow(DEFAULT_OBSERVATION_WINDOW_MS);
  }
}

export function startAdaptiveObservationWindow(
  durationMs: number = DEFAULT_OBSERVATION_WINDOW_MS,
): void {
  resolveBootstrapSnapshot();
  if (
    !snapshot.enabled ||
    !ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade ||
    typeof window === "undefined" ||
    document.visibilityState === "hidden"
  ) {
    return;
  }

  const duration = normalizeObservationDuration(durationMs);
  if (observationCleanup) {
    extendObservationDeadline(duration);
    return;
  }

  currentWindowHadIssue = false;
  observationWindowStartedAt = Date.now();
  observationDeadlineAt = Math.min(
    observationWindowStartedAt + duration,
    observationWindowStartedAt + MAXIMUM_OBSERVATION_WINDOW_MS,
  );
  const supported =
    typeof PerformanceObserver !== "undefined"
      ? PerformanceObserver.supportedEntryTypes || []
      : [];

  if (supported.includes("long-animation-frame")) {
    observationCleanup = observeLongAnimationFrames();
  } else if (supported.includes("longtask")) {
    observationCleanup = observeLongTasks();
  } else {
    observationCleanup = observeAnimationFrames();
  }

  scheduleObservationCompletion();
}

export function startEnhancementObservationWindow(): void {
  if (observationCleanup) {
    extendObservationDeadline(ENHANCEMENT_OBSERVATION_WINDOW_MS);
    return;
  }
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
      isTierAtLeast(value.rendering, requirement.rendering, [
        "safe",
        "standard",
        "enhanced",
      ])) &&
    (requirement.media === undefined ||
      isTierAtLeast(value.media, requirement.media, [
        "economy",
        "standard",
        "high",
      ])) &&
    (requirement.motion === undefined ||
      isTierAtLeast(value.motion, requirement.motion, [
        "minimal",
        "standard",
        "enhanced",
      ]))
  );
}

function resolveBootstrapSnapshot(): void {
  if (didResolveBootstrap || typeof window === "undefined") return;
  didResolveBootstrap = true;

  const path = window.location.pathname;
  const excludedFromAdaptiveQuality =
    path === "/super-admin" || path.startsWith("/super-admin/");

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
    deviceBaseline = { ...bootstrap.baselineConstraint };
    runtimeConstraint = { ...bootstrap.runtimeConstraint };
    rolloutBucket = bootstrap.rolloutBucket;
    sessionRecord =
      readAdaptiveQualitySession() || sessionRecordFromBootstrap(bootstrap);
    mobileAdmissionEligible = readLegacyMobileAdmission();
    expireRuntimePenaltyIfNeeded();
    return;
  }

  sessionRecord = readAdaptiveQualitySession();
  const now = Date.now();
  const capabilities = readAdaptiveCapabilities();
  mobileAdmissionEligible = readLegacyMobileAdmission();
  const persistedRuntimeConstraint =
    sessionRecord?.penaltyExpiresAt &&
    sessionRecord.penaltyExpiresAt > now
      ? sessionRecord.runtimeConstraint
      : undefined;
  const classification = classifyAdaptiveQuality(capabilities, {
    persistedRuntimeConstraint,
    admittedHighEndMobile: mobileAdmissionEligible,
  });
  rolloutBucket = sessionRecord?.rolloutBucket ?? createRolloutBucket();
  const inCohort =
    ADAPTIVE_QUALITY_FLAGS.forceSafe ||
    rolloutBucket < ADAPTIVE_QUALITY_FLAGS.rolloutPercent * 100;

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

  deviceBaseline = ADAPTIVE_QUALITY_FLAGS.forceSafe
    ? { ...SAFE_CONSTRAINT }
    : classification.baselineConstraint;
  runtimeConstraint = ADAPTIVE_QUALITY_FLAGS.forceSafe
    ? { ...SAFE_CONSTRAINT }
    : classification.runtimeConstraint;
  snapshot = ADAPTIVE_QUALITY_FLAGS.forceSafe
    ? {
        enabled: true,
        ...SAFE_CONSTRAINT,
        reducedTransparency: classification.snapshot.reducedTransparency,
        reason: "force-safe",
        routeGeneration: 0,
      }
    : classification.snapshot;
  persistSession();
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
      typeof value.createdAt === "number" &&
      Number.isFinite(value.createdAt) &&
      typeof value.expiresAt === "number" &&
      Number.isFinite(value.expiresAt) &&
      value.createdAt <= value.expiresAt &&
      value.expiresAt ===
        value.createdAt + ADAPTIVE_QUALITY_SESSION_TTL_MS &&
      value.expiresAt > Date.now() &&
      Number.isInteger(value.rolloutBucket) &&
      value.rolloutBucket >= 0 &&
      value.rolloutBucket <= 9999 &&
      typeof value.enabled === "boolean" &&
      typeof value.reducedTransparency === "boolean" &&
      Number.isInteger(value.routeGeneration) &&
      value.routeGeneration >= 0 &&
      isAdaptiveConstraint(value) &&
      isAdaptiveConstraint(value.baselineConstraint) &&
      isAdaptiveConstraint(value.runtimeConstraint) &&
      isNullableTimestamp(value.penaltyExpiresAt) &&
      Number.isInteger(value.consecutiveSmoothWindows) &&
      value.consecutiveSmoothWindows >= 0 &&
      isNullableTimestamp(value.lastBadAt) &&
      isAdaptiveReason(value.lastReason) &&
      isAdaptiveReason(value.reason),
  );
}

function sessionRecordFromBootstrap(
  bootstrap: AdaptiveQualityBootstrap,
): AdaptiveQualitySessionRecord {
  return {
    schema: ADAPTIVE_QUALITY_SCHEMA,
    policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
    buildVersion: ADAPTIVE_QUALITY_BUILD_VERSION,
    createdAt: bootstrap.createdAt,
    expiresAt: bootstrap.expiresAt,
    rolloutBucket: bootstrap.rolloutBucket,
    runtimeConstraint: { ...bootstrap.runtimeConstraint },
    penaltyExpiresAt: bootstrap.penaltyExpiresAt,
    consecutiveSmoothWindows: bootstrap.consecutiveSmoothWindows,
    lastBadAt: bootstrap.lastBadAt,
    lastReason: bootstrap.lastReason,
  };
}

function releaseControllerReference(): void {
  controllerReferences = Math.max(0, controllerReferences - 1);
  if (controllerReferences > 0) return;

  cancelObservationWindow(true);
  admissionGeneration += 1;
  clearPenaltyExpiryTimer();
  for (const cleanup of controllerCleanups.splice(0)) cleanup();
  if (typeof window !== "undefined") delete window.__INFINITY_AQ_E2E__;
  clearAdaptiveQualityAttributes();
}

function installPreferenceListeners(): Array<() => void> {
  const cleanups: Array<() => void> = [];
  const queries = [
    safeMediaQuery("(prefers-reduced-motion: reduce)"),
    safeMediaQuery("(prefers-reduced-transparency: reduce)"),
  ];

  for (const query of queries) {
    if (query) {
      cleanups.push(
        listenToMediaQuery(query, () => {
          recomputeEffectiveSnapshot(snapshot.routeGeneration);
        }),
      );
    }
  }

  const connection = getNetworkConnection();
  if (connection) {
    const handleConnectionChange = () => {
      recomputeEffectiveSnapshot(snapshot.routeGeneration);
    };
    connection.addEventListener?.("change", handleConnectionChange);
    cleanups.push(() =>
      connection.removeEventListener?.("change", handleConnectionChange),
    );
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      cancelObservationWindow(true);
    } else if (ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade) {
      startAdaptiveObservationWindow(DEFAULT_OBSERVATION_WINDOW_MS);
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  cleanups.push(() =>
    document.removeEventListener("visibilitychange", handleVisibilityChange),
  );

  return cleanups;
}

function listenToMediaQuery(
  mediaQuery: MediaQueryList,
  listener: () => void,
): () => void {
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
      if (
        blockingDuration >=
        ADAPTIVE_QUALITY_POLICY_CONFIG.loaf.severeBlockingDurationMs
      ) {
        observationSummary.issueCount += 1;
        observationSummary.severeCount += 1;
        currentWindowHadIssue =
          requestDowngrade("severe-loaf", true) || currentWindowHadIssue;
        continue;
      }
      if (
        entry.duration >=
        ADAPTIVE_QUALITY_POLICY_CONFIG.loaf.diagnosticDurationMs
      ) {
        observationSummary.issueCount += 1;
      }
      if (
        entry.duration >=
          ADAPTIVE_QUALITY_POLICY_CONFIG.loaf.repeatedDurationMs ||
        blockingDuration >=
          ADAPTIVE_QUALITY_POLICY_CONFIG.loaf.repeatedBlockingDurationMs
      ) {
        repeated += 1;
      }
    }
    if (repeated >= ADAPTIVE_QUALITY_POLICY_CONFIG.loaf.repeatedCount) {
      currentWindowHadIssue =
        requestDowngrade("repeated-loaf", false) || currentWindowHadIssue;
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
        currentWindowHadIssue =
          requestDowngrade("severe-long-task", true) || currentWindowHadIssue;
        continue;
      }
      if (entry.duration >= 80) {
        observationSummary.issueCount += 1;
        repeated += 1;
      }
    }
    if (repeated >= 3) {
      currentWindowHadIssue =
        requestDowngrade("repeated-long-task", false) || currentWindowHadIssue;
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
  let deltas: number[] = [];

  const sample = (time: number) => {
    if (document.visibilityState !== "hidden") {
      if (previousTime !== null) {
        deltas.push(time - previousTime);
        if (deltas.length > MAX_RAF_SAMPLES) {
          deltas = deltas.slice(-MAX_RAF_SAMPLES);
        }
      }
      previousTime = time;
    } else {
      previousTime = null;
    }
    frameId = window.requestAnimationFrame(sample);
  };

  frameId = window.requestAnimationFrame(sample);
  observationFinalize = () => {
    evaluateAnimationFrames(deltas);
    deltas = [];
    previousTime = null;
  };
  return () => window.cancelAnimationFrame(frameId);
}

function evaluateAnimationFrames(allDeltas: number[]): void {
  const deltas = allDeltas.slice(RAF_WARMUP_SAMPLES);
  if (deltas.length < 20) return;
  const slowFrames = deltas.filter((delta) => delta > 50).length;
  observationSummary.sampleCount += deltas.length;
  observationSummary.issueCount += slowFrames;
  const sorted = [...deltas].sort((a, b) => a - b);
  const p95 =
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];

  if (slowFrames >= 5 && p95 > 40) {
    currentWindowHadIssue =
      requestDowngrade("raf-jank", false) || currentWindowHadIssue;
  }
}

function setObservationKind(kind: AdaptiveObserverKind): void {
  if (observationSummary.observer === "none") {
    observationSummary.observer = kind;
  }
}

function requestDowngrade(
  reason: AdaptiveQualityReason,
  _severe: boolean,
  ignoreCooldown = false,
): boolean {
  if (!snapshot.enabled || ADAPTIVE_QUALITY_FLAGS.forceSafe) return false;

  const performanceNow =
    typeof performance === "undefined" ? Date.now() : performance.now();
  if (
    !ignoreCooldown &&
    performanceNow - lastDowngradeAt < DOWNGRADE_COOLDOWN_MS
  ) {
    return false;
  }

  const downgraded = downgradeConstraint(runtimeConstraint);
  if (!downgraded) return false;

  const now = Date.now();
  lastDowngradeAt = performanceNow;
  runtimeConstraint = clampConstraint(deviceBaseline, downgraded);
  sessionRecord = createAdaptiveQualitySessionRecord({
    runtimeConstraint,
    rolloutBucket,
    previous: sessionRecord,
    penaltyExpiresAt: now + ADAPTIVE_QUALITY_PENALTY_TTL_MS,
    consecutiveSmoothWindows: 0,
    lastBadAt: now,
    lastReason: reason,
  });
  currentWindowHadIssue = true;
  recomputeEffectiveSnapshot(snapshot.routeGeneration, reason);
  persistSession();
  schedulePenaltyExpiry();

  if (!observationCleanup && ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade) {
    startAdaptiveObservationWindow(DEFAULT_OBSERVATION_WINDOW_MS);
  }
  return true;
}

function recomputeEffectiveSnapshot(
  routeGeneration = snapshot.routeGeneration,
  reasonOverride?: AdaptiveQualityReason,
): void {
  const capabilities = readAdaptiveCapabilities();
  const reason =
    reasonOverride ||
    (isConstraintBelow(runtimeConstraint, deviceBaseline)
      ? sessionRecord?.lastReason || "session-constraint"
      : "default");
  const next = ADAPTIVE_QUALITY_FLAGS.forceSafe
    ? {
        enabled: true,
        ...SAFE_CONSTRAINT,
        reducedTransparency: capabilities.reducedTransparency === true,
        reason: "force-safe" as const,
        routeGeneration,
      }
    : applyCurrentPreferences(
        {
          enabled: true,
          ...runtimeConstraint,
          reducedTransparency: false,
          reason,
          routeGeneration,
        },
        capabilities,
      );
  updateSnapshot(next, next.reason);
}

function updateSnapshot(
  next: AdaptiveQualitySnapshot,
  reason: AdaptiveQualityReason,
): void {
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
    const detail: AdaptiveQualityChange = {
      previous,
      current: snapshot,
      reason,
    };
    window.dispatchEvent(
      new CustomEvent<AdaptiveQualityChange>(ADAPTIVE_QUALITY_EVENT, {
        detail,
      }),
    );
  }
}

function completeObservationWindow(): void {
  if (!observationCleanup || !snapshot.enabled) return;
  clearObservationCompletionTimer();
  observationFinalize?.();

  sessionRecord =
    sessionRecord ||
    createAdaptiveQualitySessionRecord({
      runtimeConstraint,
      rolloutBucket,
    });

  if (currentWindowHadIssue) {
    sessionRecord = createAdaptiveQualitySessionRecord({
      runtimeConstraint,
      rolloutBucket,
      previous: sessionRecord,
      consecutiveSmoothWindows: 0,
    });
  } else if (isConstraintBelow(runtimeConstraint, deviceBaseline)) {
    const consecutiveSmoothWindows =
      sessionRecord.consecutiveSmoothWindows + 1;
    sessionRecord = createAdaptiveQualitySessionRecord({
      runtimeConstraint,
      rolloutBucket,
      previous: sessionRecord,
      consecutiveSmoothWindows,
    });
    maybeRecoverRuntimeConstraint();
  } else {
    sessionRecord = createAdaptiveQualitySessionRecord({
      runtimeConstraint,
      rolloutBucket,
      previous: sessionRecord,
      consecutiveSmoothWindows: 0,
      penaltyExpiresAt: null,
    });
  }

  persistSession();
  currentWindowHadIssue = false;

  if (
    isConstraintBelow(runtimeConstraint, deviceBaseline) &&
    ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade &&
    document.visibilityState !== "hidden"
  ) {
    beginNextLogicalObservationWindow();
  } else {
    cancelObservationWindow();
  }
}

function maybeRecoverRuntimeConstraint(): void {
  if (
    !ADAPTIVE_QUALITY_FLAGS.promotion ||
    !sessionRecord ||
    sessionRecord.consecutiveSmoothWindows < RECOVERY_WINDOWS
  ) {
    return;
  }
  const now = Date.now();
  if (
    sessionRecord.lastBadAt !== null &&
    now - sessionRecord.lastBadAt < MINIMUM_RECOVERY_DELAY_MS
  ) {
    return;
  }

  const promoted = promoteConstraint(runtimeConstraint, deviceBaseline);
  if (!promoted) return;

  runtimeConstraint = promoted;
  const fullyRecovered = areConstraintsEqual(runtimeConstraint, deviceBaseline);
  sessionRecord = createAdaptiveQualitySessionRecord({
    runtimeConstraint,
    rolloutBucket,
    previous: sessionRecord,
    penaltyExpiresAt: fullyRecovered
      ? null
      : sessionRecord.penaltyExpiresAt,
    consecutiveSmoothWindows: 0,
    lastReason: "promotion",
  });
  recomputeEffectiveSnapshot(snapshot.routeGeneration, "promotion");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ADAPTIVE_QUALITY_PROMOTION_EVENT));
  }
}

function beginNextLogicalObservationWindow(): void {
  currentWindowHadIssue = false;
  observationWindowStartedAt = Date.now();
  observationDeadlineAt =
    observationWindowStartedAt + DEFAULT_OBSERVATION_WINDOW_MS;
  scheduleObservationCompletion();
}

function cancelObservationWindow(resetRecoveryEvidence = false): void {
  clearObservationCompletionTimer();
  const cleanup = observationCleanup;
  observationCleanup = null;
  observationFinalize = null;
  cleanup?.();
  observationWindowStartedAt = 0;
  observationDeadlineAt = 0;
  currentWindowHadIssue = false;
  if (
    resetRecoveryEvidence &&
    sessionRecord &&
    sessionRecord.consecutiveSmoothWindows > 0 &&
    isConstraintBelow(runtimeConstraint, deviceBaseline)
  ) {
    sessionRecord = createAdaptiveQualitySessionRecord({
      runtimeConstraint,
      rolloutBucket,
      previous: sessionRecord,
      consecutiveSmoothWindows: 0,
    });
    persistSession();
  }
}

function extendObservationDeadline(extensionMs: number): void {
  if (!observationCleanup) return;
  const maximumDeadline =
    observationWindowStartedAt + MAXIMUM_OBSERVATION_WINDOW_MS;
  observationDeadlineAt = Math.min(
    maximumDeadline,
    Math.max(observationDeadlineAt, Date.now() + extensionMs),
  );
  scheduleObservationCompletion();
}

function scheduleObservationCompletion(): void {
  if (typeof window === "undefined" || !observationCleanup) return;
  clearObservationCompletionTimer();
  observationTimeout = window.setTimeout(
    completeObservationWindow,
    Math.max(0, observationDeadlineAt - Date.now()),
  );
}

function clearObservationCompletionTimer(): void {
  if (typeof window !== "undefined" && observationTimeout) {
    window.clearTimeout(observationTimeout);
  }
  observationTimeout = 0;
}

function normalizeObservationDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs)) return DEFAULT_OBSERVATION_WINDOW_MS;
  return Math.max(1_000, Math.min(MAXIMUM_OBSERVATION_WINDOW_MS, durationMs));
}

function resolveMobileAdmission(): void {
  if (
    !ADAPTIVE_QUALITY_FLAGS.promotion ||
    ADAPTIVE_QUALITY_FLAGS.forceSafe ||
    typeof window === "undefined"
  ) {
    return;
  }

  const generation = ++admissionGeneration;
  void resolveHighEndUserAgentAdmission(window.navigator).then((decision) => {
    if (
      generation !== admissionGeneration ||
      controllerReferences === 0 ||
      !decision.eligible
    ) {
      return;
    }
    mobileAdmissionEligible = true;
    const classification = classifyAdaptiveQuality(readAdaptiveCapabilities(), {
      admittedHighEndMobile: true,
    });
    if (areConstraintsEqual(deviceBaseline, classification.baselineConstraint)) {
      return;
    }
    deviceBaseline = classification.baselineConstraint;
    runtimeConstraint = clampConstraint(deviceBaseline, runtimeConstraint);
    persistSession();
    if (!observationCleanup && ADAPTIVE_QUALITY_FLAGS.runtimeDowngrade) {
      startAdaptiveObservationWindow(DEFAULT_OBSERVATION_WINDOW_MS);
    }
  });
}

function readLegacyMobileAdmission(): boolean {
  try {
    return classifyHighEndUserAgent({
      userAgent: window.navigator.userAgent,
    }).eligible;
  } catch {
    return false;
  }
}

function expireRuntimePenaltyIfNeeded(now = Date.now()): void {
  if (
    !sessionRecord ||
    sessionRecord.penaltyExpiresAt === null ||
    sessionRecord.penaltyExpiresAt > now
  ) {
    return;
  }

  runtimeConstraint = { ...deviceBaseline };
  sessionRecord = createAdaptiveQualitySessionRecord({
    runtimeConstraint,
    rolloutBucket,
    previous: sessionRecord,
    penaltyExpiresAt: null,
    consecutiveSmoothWindows: 0,
    lastReason: "promotion",
  });
  if (snapshot.enabled) {
    recomputeEffectiveSnapshot(snapshot.routeGeneration, "promotion");
  }
  persistSession();
  clearPenaltyExpiryTimer();
}

function schedulePenaltyExpiry(): void {
  clearPenaltyExpiryTimer();
  if (
    typeof window === "undefined" ||
    controllerReferences === 0 ||
    !sessionRecord?.penaltyExpiresAt
  ) {
    return;
  }
  penaltyExpiryTimeout = window.setTimeout(
    () => expireRuntimePenaltyIfNeeded(),
    Math.max(0, sessionRecord.penaltyExpiresAt - Date.now()),
  );
}

function clearPenaltyExpiryTimer(): void {
  if (typeof window !== "undefined" && penaltyExpiryTimeout) {
    window.clearTimeout(penaltyExpiryTimeout);
  }
  penaltyExpiryTimeout = 0;
}

function persistSession(): void {
  if (typeof window === "undefined" || !snapshot.enabled) return;
  const now = Date.now();
  const previous =
    sessionRecord && sessionRecord.expiresAt > now
      ? sessionRecord
      : readAdaptiveQualitySession(now);
  sessionRecord = createAdaptiveQualitySessionRecord({
    runtimeConstraint,
    rolloutBucket,
    previous,
  });
  rolloutBucket = sessionRecord.rolloutBucket;
  if (writeAdaptiveQualitySession(sessionRecord)) {
    removeLegacyAdaptiveQualitySessions();
  }
}

function installE2EAdapter(): void {
  if (!ADAPTIVE_QUALITY_FLAGS.e2e || typeof window === "undefined") return;
  window.__INFINITY_AQ_E2E__ = {
    downgrade: (reason = "raf-jank") => {
      requestDowngrade(reason, reason.startsWith("severe-"), true);
    },
    setTier: (constraint) => {
      if (!isAdaptiveConstraint(constraint)) return;
      runtimeConstraint = { ...constraint };
      deviceBaseline = { ...COMPATIBILITY_CONSTRAINT };
      recomputeEffectiveSnapshot(snapshot.routeGeneration, "default");
      persistSession();
    },
    startObservationWindow: (durationMs) =>
      startAdaptiveObservationWindow(durationMs),
    completeObservationWindow,
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

function isNullableTimestamp(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

export function __resetAdaptiveQualityForTesting(): void {
  if (process.env.NODE_ENV === "production") return;
  cancelObservationWindow();
  clearPenaltyExpiryTimer();
  for (const cleanup of controllerCleanups.splice(0)) cleanup();
  subscribers = new Set();
  snapshot = SERVER_SNAPSHOT;
  didResolveBootstrap = false;
  controllerReferences = 0;
  lastDowngradeAt = Number.NEGATIVE_INFINITY;
  deviceBaseline = { ...STANDARD_CONSTRAINT };
  runtimeConstraint = { ...STANDARD_CONSTRAINT };
  sessionRecord = null;
  rolloutBucket = 0;
  mobileAdmissionEligible = false;
  admissionGeneration += 1;
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
