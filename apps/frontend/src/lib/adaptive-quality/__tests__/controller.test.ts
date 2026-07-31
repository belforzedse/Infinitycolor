import {
  __requestAdaptiveDowngradeForTesting,
  __resetAdaptiveQualityForTesting,
  getSnapshot,
  noteEnhancementLoaded,
  notifyAdaptiveRoute,
  startAdaptiveQualityController,
} from "../controller";
import {
  ADAPTIVE_QUALITY_BUILD_VERSION,
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_SCHEMA,
  ADAPTIVE_QUALITY_STORAGE_KEY,
} from "../config";
import type {
  AdaptiveQualityConstraint,
  AdaptiveQualityReason,
} from "../types";

const originalPerformanceObserver = globalThis.PerformanceObserver;
const originalMatchMedia = window.matchMedia;
const originalConnectionDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  "connection",
);
const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

const PEAK: AdaptiveQualityConstraint = {
  rendering: "enhanced",
  media: "high",
  motion: "enhanced",
};
const STANDARD: AdaptiveQualityConstraint = {
  rendering: "standard",
  media: "standard",
  motion: "standard",
};
const SAFE: AdaptiveQualityConstraint = {
  rendering: "safe",
  media: "economy",
  motion: "minimal",
};

class FakePerformanceObserver {
  static supportedEntryTypes: string[] = [];
  static instances: FakePerformanceObserver[] = [];

  disconnected = false;

  constructor(
    private readonly callback: (
      list: Pick<PerformanceObserverEntryList, "getEntries">,
    ) => void,
  ) {
    FakePerformanceObserver.instances.push(this);
  }

  observe() {}

  disconnect() {
    this.disconnected = true;
  }

  emit(
    entries: Array<
      Partial<PerformanceEntry> & {
        duration: number;
        blockingDuration?: number;
      }
    >,
  ) {
    this.callback({
      getEntries: () => entries as PerformanceEntry[],
    });
  }
}

class TestConnection extends EventTarget {
  saveData = false;
  effectiveType = "4g";
}

class TestMediaQuery extends EventTarget {
  readonly media: string;
  matches: boolean;
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null =
    null;

  constructor(media: string, matches: boolean) {
    super();
    this.media = media;
    this.matches = matches;
  }

  addListener(listener: (event: MediaQueryListEvent) => void) {
    this.addEventListener("change", listener as EventListener);
  }

  removeListener(listener: (event: MediaQueryListEvent) => void) {
    this.removeEventListener("change", listener as EventListener);
  }

  setMatches(matches: boolean) {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

function installCapabilities(options: {
  saveData?: boolean;
  effectiveType?: string;
  reducedMotion?: boolean;
  reducedTransparency?: boolean;
} = {}) {
  const connection = new TestConnection();
  connection.saveData = options.saveData === true;
  connection.effectiveType = options.effectiveType || "4g";
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: connection,
  });

  const mediaQueries = new Map<string, TestMediaQuery>();
  const initial = (query: string) =>
    query === "(prefers-reduced-motion: reduce)"
      ? options.reducedMotion === true
      : query === "(prefers-reduced-transparency: reduce)"
        ? options.reducedTransparency === true
        : query === "(pointer: fine)" || query === "(hover: hover)";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      let mediaQuery = mediaQueries.get(query);
      if (!mediaQuery) {
        mediaQuery = new TestMediaQuery(query, initial(query));
        mediaQueries.set(query, mediaQuery);
      }
      return mediaQuery as unknown as MediaQueryList;
    },
  });

  return {
    connection,
    setReducedMotion(value: boolean) {
      mediaQueries
        .get("(prefers-reduced-motion: reduce)")
        ?.setMatches(value);
    },
    setReducedTransparency(value: boolean) {
      mediaQueries
        .get("(prefers-reduced-transparency: reduce)")
        ?.setMatches(value);
    },
  };
}

function installBootstrap(options: {
  baseline?: AdaptiveQualityConstraint;
  runtime?: AdaptiveQualityConstraint;
  snapshot?: AdaptiveQualityConstraint;
  penaltyExpiresAt?: number | null;
  lastBadAt?: number | null;
  lastReason?: AdaptiveQualityReason;
  smoothWindows?: number;
} = {}) {
  const now = Date.now();
  const baseline = options.baseline || STANDARD;
  const runtime = options.runtime || baseline;
  const effective = options.snapshot || runtime;
  const penaltyExpiresAt =
    options.penaltyExpiresAt === undefined
      ? runtime === baseline
        ? null
        : now + 30 * 60 * 1000
      : options.penaltyExpiresAt;
  const lastBadAt =
    options.lastBadAt === undefined
      ? penaltyExpiresAt
        ? now - 20_000
        : null
      : options.lastBadAt;
  const lastReason = options.lastReason || (penaltyExpiresAt ? "raf-jank" : "default");
  const createdAt = now - 1_000;
  const record = {
    schema: ADAPTIVE_QUALITY_SCHEMA,
    policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
    buildVersion: ADAPTIVE_QUALITY_BUILD_VERSION,
    createdAt,
    expiresAt: createdAt + 6 * 60 * 60 * 1000,
    rolloutBucket: 10,
    runtimeConstraint: { ...runtime },
    penaltyExpiresAt,
    consecutiveSmoothWindows: options.smoothWindows || 0,
    lastBadAt,
    lastReason,
  } as const;
  sessionStorage.setItem(ADAPTIVE_QUALITY_STORAGE_KEY, JSON.stringify(record));
  window.__INFINITY_AQ_BOOTSTRAP__ = {
    ...record,
    baselineConstraint: { ...baseline },
    enabled: true,
    ...effective,
    reducedTransparency: false,
    reason: lastReason,
    routeGeneration: 0,
  };
}

function persistedRecord() {
  return JSON.parse(
    sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY) || "{}",
  );
}

describe("adaptive quality v2 controller", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    installCapabilities();
    installBootstrap();
    __resetAdaptiveQualityForTesting();
    FakePerformanceObserver.instances = [];
    FakePerformanceObserver.supportedEntryTypes = ["longtask"];
    Object.defineProperty(globalThis, "PerformanceObserver", {
      configurable: true,
      value: FakePerformanceObserver,
    });
  });

  afterEach(() => {
    __resetAdaptiveQualityForTesting();
    delete window.__INFINITY_AQ_BOOTSTRAP__;
    Object.defineProperty(globalThis, "PerformanceObserver", {
      configurable: true,
      value: originalPerformanceObserver,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    if (originalConnectionDescriptor) {
      Object.defineProperty(
        navigator,
        "connection",
        originalConnectionDescriptor,
      );
    } else {
      delete (navigator as Navigator & { connection?: unknown }).connection;
    }
    if (originalVisibilityDescriptor) {
      Object.defineProperty(
        document,
        "visibilityState",
        originalVisibilityDescriptor,
      );
    }
    jest.useRealTimers();
  });

  it("uses the exact bootstrap snapshot and advances route generations", () => {
    expect(getSnapshot()).toMatchObject({
      ...STANDARD,
      routeGeneration: 0,
    });
    notifyAdaptiveRoute();
    expect(getSnapshot()).toMatchObject({
      ...STANDARD,
      routeGeneration: 1,
    });
  });

  it("downgrades runtime one axis at a time in Motion, Media, Rendering order", () => {
    installBootstrap({ baseline: PEAK, runtime: PEAK });
    __resetAdaptiveQualityForTesting();

    const expected = [
      { rendering: "enhanced", media: "high", motion: "standard" },
      { rendering: "enhanced", media: "high", motion: "minimal" },
      { rendering: "enhanced", media: "standard", motion: "minimal" },
      { rendering: "enhanced", media: "economy", motion: "minimal" },
      { rendering: "standard", media: "economy", motion: "minimal" },
      { rendering: "safe", media: "economy", motion: "minimal" },
    ];
    for (const tiers of expected) {
      __requestAdaptiveDowngradeForTesting("raf-jank");
      expect(getSnapshot()).toMatchObject(tiers);
    }

    expect(persistedRecord()).toMatchObject({
      runtimeConstraint: SAFE,
      consecutiveSmoothWindows: 0,
      lastReason: "raf-jank",
    });
    expect(persistedRecord()).not.toHaveProperty("sessionHadDowngrade");
    expect(persistedRecord()).not.toHaveProperty("sessionHadSevereEvent");
    expect(persistedRecord()).not.toHaveProperty("reasons");
  });

  it("treats duration-only 300ms LoAF as diagnostic, not an immediate downgrade", () => {
    FakePerformanceObserver.supportedEntryTypes = ["long-animation-frame"];
    startAdaptiveQualityController();
    FakePerformanceObserver.instances[0].emit([
      { duration: 300, blockingDuration: 0 },
    ]);

    expect(getSnapshot()).toMatchObject(STANDARD);
    expect(persistedRecord()).toMatchObject({
      runtimeConstraint: STANDARD,
      penaltyExpiresAt: null,
      lastBadAt: null,
    });
  });

  it("accepts severe blocking and repeated LoAF evidence", () => {
    FakePerformanceObserver.supportedEntryTypes = ["long-animation-frame"];
    startAdaptiveQualityController();
    const observer = FakePerformanceObserver.instances[0];
    observer.emit([{ duration: 160, blockingDuration: 150 }]);
    expect(getSnapshot()).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "minimal",
      reason: "severe-loaf",
    });

    __resetAdaptiveQualityForTesting();
    sessionStorage.clear();
    installBootstrap();
    FakePerformanceObserver.instances = [];
    startAdaptiveQualityController();
    FakePerformanceObserver.instances[0].emit([
      { duration: 120, blockingDuration: 0 },
      { duration: 121, blockingDuration: 0 },
      { duration: 122, blockingDuration: 0 },
    ]);
    expect(getSnapshot()).toMatchObject({
      motion: "minimal",
      reason: "repeated-loaf",
    });
  });

  it("restores 3g media immediately on 4g without changing runtime storage", () => {
    const controls = installCapabilities({ effectiveType: "3g" });
    installBootstrap({
      baseline: PEAK,
      runtime: PEAK,
      snapshot: { ...PEAK, media: "standard" },
      lastReason: "slow-connection",
    });
    __resetAdaptiveQualityForTesting();
    startAdaptiveQualityController();
    const before = persistedRecord();

    controls.connection.effectiveType = "4g";
    controls.connection.dispatchEvent(new Event("change"));
    expect(getSnapshot()).toMatchObject({
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    });
    expect(persistedRecord().runtimeConstraint).toEqual(PEAK);
    expect(persistedRecord().expiresAt).toBe(before.expiresAt);

    controls.connection.effectiveType = "3g";
    controls.connection.dispatchEvent(new Event("change"));
    expect(getSnapshot().media).toBe("standard");
    expect(persistedRecord().runtimeConstraint).toEqual(PEAK);
  });

  it("recovers one axis after two clean windows on the same route", () => {
    installBootstrap({ baseline: PEAK, runtime: SAFE });
    __resetAdaptiveQualityForTesting();
    startAdaptiveQualityController();

    jest.advanceTimersByTime(16_000);

    expect(getSnapshot()).toMatchObject({
      rendering: "standard",
      media: "economy",
      motion: "minimal",
      reason: "promotion",
      routeGeneration: 0,
    });
    expect(persistedRecord()).toMatchObject({
      runtimeConstraint: {
        rendering: "standard",
        media: "economy",
        motion: "minimal",
      },
      consecutiveSmoothWindows: 0,
    });
  });

  it("keeps Save Data and Reduced Motion capped through every promotion", () => {
    installCapabilities({ saveData: true, reducedMotion: true });
    installBootstrap({ baseline: PEAK, runtime: SAFE, snapshot: SAFE });
    __resetAdaptiveQualityForTesting();
    startAdaptiveQualityController();

    for (let promotion = 0; promotion < 6; promotion += 1) {
      jest.advanceTimersByTime(16_000);
      expect(getSnapshot()).toMatchObject({
        media: "economy",
        motion: "minimal",
      });
    }

    expect(persistedRecord().runtimeConstraint).toEqual(PEAK);
    expect(getSnapshot()).toMatchObject({
      rendering: "enhanced",
      media: "economy",
      motion: "minimal",
    });
  });

  it("does not count hidden time as clean recovery evidence", () => {
    installBootstrap({ baseline: PEAK, runtime: SAFE });
    __resetAdaptiveQualityForTesting();
    startAdaptiveQualityController();
    jest.advanceTimersByTime(8_000);
    expect(persistedRecord().consecutiveSmoothWindows).toBe(1);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(persistedRecord().consecutiveSmoothWindows).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(getSnapshot()).toMatchObject(SAFE);
    expect(persistedRecord().consecutiveSmoothWindows).toBe(0);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    jest.advanceTimersByTime(8_000);
    expect(getSnapshot()).toMatchObject(SAFE);
    jest.advanceTimersByTime(8_000);
    expect(getSnapshot().rendering).toBe("standard");
  });

  it("extends the active window after enhancement load without replacing its observer", () => {
    installBootstrap({ baseline: PEAK, runtime: SAFE });
    __resetAdaptiveQualityForTesting();
    startAdaptiveQualityController();
    expect(FakePerformanceObserver.instances).toHaveLength(1);

    jest.advanceTimersByTime(7_000);
    noteEnhancementLoaded("hero-motion");
    jest.advanceTimersByTime(1_100);
    expect(persistedRecord().consecutiveSmoothWindows).toBe(0);
    expect(FakePerformanceObserver.instances).toHaveLength(1);

    jest.advanceTimersByTime(3_900);
    expect(persistedRecord().consecutiveSmoothWindows).toBe(1);
    expect(FakePerformanceObserver.instances).toHaveLength(1);
  });

  it("expires a runtime penalty automatically after thirty minutes", () => {
    const now = Date.now();
    installBootstrap({
      baseline: PEAK,
      runtime: SAFE,
      penaltyExpiresAt: now + 1_000,
      lastBadAt: now - 1_000,
    });
    __resetAdaptiveQualityForTesting();
    startAdaptiveQualityController();

    jest.advanceTimersByTime(1_000);

    expect(getSnapshot()).toMatchObject(PEAK);
    expect(persistedRecord()).toMatchObject({
      runtimeConstraint: PEAK,
      penaltyExpiresAt: null,
    });
  });

  it("does not classify or read storage for super-admin", () => {
    delete window.__INFINITY_AQ_BOOTSTRAP__;
    window.history.replaceState({}, "", "/super-admin/products");
    __resetAdaptiveQualityForTesting();
    const storageSpy = jest.spyOn(Storage.prototype, "getItem");

    expect(getSnapshot()).toMatchObject({
      enabled: false,
      ...PEAK,
    });
    expect(storageSpy).not.toHaveBeenCalled();
  });
});
