import {
  __requestAdaptiveDowngradeForTesting,
  __resetAdaptiveQualityForTesting,
  getSnapshot,
  notifyAdaptiveRoute,
  startAdaptiveQualityController,
} from "../controller";
import {
  ADAPTIVE_QUALITY_BUILD_VERSION,
  ADAPTIVE_QUALITY_PROMOTION_EVENT,
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_STORAGE_KEY,
} from "../config";
import { createAdaptiveQualitySessionRecord, writeAdaptiveQualitySession } from "../storage";

const originalPerformanceObserver = globalThis.PerformanceObserver;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;
const originalMatchMedia = window.matchMedia;
const originalConnectionDescriptor = Object.getOwnPropertyDescriptor(navigator, "connection");
const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, "userAgent");
const originalUserAgentDataDescriptor = Object.getOwnPropertyDescriptor(navigator, "userAgentData");
const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");

class FakePerformanceObserver {
  static supportedEntryTypes: string[] = [];
  static instances: FakePerformanceObserver[] = [];

  disconnected = false;

  constructor(
    private readonly callback: (list: Pick<PerformanceObserverEntryList, "getEntries">) => void,
  ) {
    FakePerformanceObserver.instances.push(this);
  }

  observe() {}

  disconnect() {
    this.disconnected = true;
  }

  emit(entries: Array<Partial<PerformanceEntry> & { duration: number }>) {
    this.callback({
      getEntries: () => entries as PerformanceEntry[],
    });
  }
}

function installBootstrap() {
  window.__INFINITY_AQ_BOOTSTRAP__ = {
    schema: 1,
    policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
    buildVersion: ADAPTIVE_QUALITY_BUILD_VERSION,
    expiresAt: Date.now() + 10_000,
    rolloutBucket: 10,
    reasons: ["default"],
    constraint: {
      rendering: "standard",
      media: "standard",
      motion: "standard",
    },
    enabled: true,
    rendering: "standard",
    media: "standard",
    motion: "standard",
    reducedTransparency: false,
    reason: "default",
    routeGeneration: 0,
  };
}

describe("adaptive quality controller", () => {
  beforeEach(() => {
    sessionStorage.clear();
    installBootstrap();
    __resetAdaptiveQualityForTesting();
    FakePerformanceObserver.instances = [];
    FakePerformanceObserver.supportedEntryTypes = [];
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
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: originalCancelAnimationFrame,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    if (originalConnectionDescriptor) {
      Object.defineProperty(navigator, "connection", originalConnectionDescriptor);
    } else {
      delete (navigator as Navigator & { connection?: unknown }).connection;
    }
    if (originalUserAgentDescriptor) {
      Object.defineProperty(navigator, "userAgent", originalUserAgentDescriptor);
    } else {
      delete (navigator as Navigator & { userAgent?: string }).userAgent;
    }
    if (originalUserAgentDataDescriptor) {
      Object.defineProperty(navigator, "userAgentData", originalUserAgentDataDescriptor);
    } else {
      delete (navigator as Navigator & { userAgentData?: unknown }).userAgentData;
    }
    if (originalVisibilityDescriptor) {
      Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
    }
    jest.useRealTimers();
  });

  it("uses the exact bootstrap snapshot and advances route generations", () => {
    expect(getSnapshot()).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "standard",
      routeGeneration: 0,
    });
    notifyAdaptiveRoute();
    expect(getSnapshot().routeGeneration).toBe(1);
  });

  it("rejects an expired bootstrap and restores the valid session constraint", () => {
    writeAdaptiveQualitySession(
      createAdaptiveQualitySessionRecord({
        constraint: {
          rendering: "safe",
          media: "economy",
          motion: "minimal",
        },
        rolloutBucket: 77,
      }),
    );
    window.__INFINITY_AQ_BOOTSTRAP__ = {
      ...window.__INFINITY_AQ_BOOTSTRAP__!,
      expiresAt: Date.now() - 1,
    };
    __resetAdaptiveQualityForTesting();

    expect(getSnapshot()).toMatchObject({
      rendering: "safe",
      media: "economy",
      motion: "minimal",
      reason: "session-constraint",
    });
  });

  it("downgrades one step per trigger in the required order", () => {
    __requestAdaptiveDowngradeForTesting("repeated-long-task");
    expect(getSnapshot()).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "minimal",
    });
    __requestAdaptiveDowngradeForTesting("raf-jank");
    expect(getSnapshot()).toMatchObject({
      rendering: "standard",
      media: "economy",
      motion: "minimal",
    });
    __requestAdaptiveDowngradeForTesting("severe-loaf", true);
    expect(getSnapshot()).toMatchObject({
      rendering: "safe",
      media: "economy",
      motion: "minimal",
    });
  });

  it("carries the constrained state into the next route", () => {
    __requestAdaptiveDowngradeForTesting("raf-jank");
    notifyAdaptiveRoute();
    expect(getSnapshot()).toMatchObject({
      motion: "minimal",
      routeGeneration: 1,
    });
  });

  it("does not classify or read storage when a global consumer renders in admin", () => {
    delete window.__INFINITY_AQ_BOOTSTRAP__;
    window.history.replaceState({}, "", "/super-admin/products");
    __resetAdaptiveQualityForTesting();
    const storageSpy = jest.spyOn(Storage.prototype, "getItem");

    expect(getSnapshot()).toMatchObject({
      enabled: false,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    });
    expect(storageSpy).not.toHaveBeenCalled();

    storageSpy.mockRestore();
    window.history.replaceState({}, "", "/");
  });

  it("uses LoAF repeated and severe thresholds", () => {
    FakePerformanceObserver.supportedEntryTypes = ["long-animation-frame", "longtask"];
    const cleanup = startAdaptiveQualityController();
    const observer = FakePerformanceObserver.instances[0];

    observer.emit([{ duration: 120 }, { duration: 121 }, { duration: 122 }]);
    expect(getSnapshot()).toMatchObject({
      motion: "minimal",
      reason: "repeated-loaf",
    });

    cleanup();
    __resetAdaptiveQualityForTesting();
    installBootstrap();
    FakePerformanceObserver.instances = [];
    const severeCleanup = startAdaptiveQualityController();
    FakePerformanceObserver.instances[0].emit([{ duration: 300 }]);
    expect(getSnapshot()).toMatchObject({
      motion: "minimal",
      reason: "severe-loaf",
    });
    severeCleanup();
  });

  it("falls back to Long Tasks and enforces the cooldown", () => {
    FakePerformanceObserver.supportedEntryTypes = ["longtask"];
    const cleanup = startAdaptiveQualityController();
    const observer = FakePerformanceObserver.instances[0];

    observer.emit([{ duration: 80 }, { duration: 81 }, { duration: 82 }]);
    expect(getSnapshot()).toMatchObject({
      motion: "minimal",
      reason: "repeated-long-task",
    });

    observer.emit([{ duration: 90 }, { duration: 90 }, { duration: 90 }]);
    expect(getSnapshot()).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "minimal",
    });
    cleanup();
  });

  it("records severe events even when the cooldown prevents another downgrade", () => {
    FakePerformanceObserver.supportedEntryTypes = ["longtask"];
    const cleanup = startAdaptiveQualityController();
    const observer = FakePerformanceObserver.instances[0];

    observer.emit([{ duration: 80 }, { duration: 81 }, { duration: 82 }]);
    observer.emit([{ duration: 300 }]);

    expect(getSnapshot()).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "minimal",
    });
    expect(JSON.parse(sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY) || "{}")).toMatchObject({
      sessionHadDowngrade: true,
      sessionHadSevereEvent: true,
    });
    cleanup();
  });

  it("does not admit a generic desktop UA to promotion", async () => {
    jest.useFakeTimers();
    FakePerformanceObserver.supportedEntryTypes = ["longtask"];
    const promotionListener = jest.fn();
    window.addEventListener(ADAPTIVE_QUALITY_PROMOTION_EVENT, promotionListener);
    const cleanup = startAdaptiveQualityController();
    await Promise.resolve();

    jest.advanceTimersByTime(8_000);
    notifyAdaptiveRoute();
    jest.advanceTimersByTime(8_000);
    notifyAdaptiveRoute();
    jest.advanceTimersByTime(8_000);
    notifyAdaptiveRoute();

    expect(promotionListener).not.toHaveBeenCalled();
    expect(getSnapshot()).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "standard",
      routeGeneration: 3,
    });
    expect(JSON.parse(sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY) || "{}")).toMatchObject({
      smoothWindows: 3,
      smoothRouteGenerations: 2,
      sessionHadDowngrade: false,
      sessionHadSevereEvent: false,
    });

    window.removeEventListener(ADAPTIVE_QUALITY_PROMOTION_EVENT, promotionListener);
    cleanup();
  });

  it("promotes an allowlisted iPhone to peak one axis per route after smooth proof", async () => {
    jest.useFakeTimers();
    FakePerformanceObserver.supportedEntryTypes = ["longtask"];
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    });
    const promotionListener = jest.fn();
    window.addEventListener(ADAPTIVE_QUALITY_PROMOTION_EVENT, promotionListener);
    const cleanup = startAdaptiveQualityController();
    await Promise.resolve();

    jest.advanceTimersByTime(8_000);
    notifyAdaptiveRoute();
    jest.advanceTimersByTime(8_000);
    notifyAdaptiveRoute();
    jest.advanceTimersByTime(8_000);
    expect(getSnapshot()).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });

    notifyAdaptiveRoute();
    expect(getSnapshot()).toMatchObject({
      rendering: "enhanced",
      media: "standard",
      motion: "standard",
      reason: "promotion",
    });

    jest.advanceTimersByTime(8_000);
    notifyAdaptiveRoute();
    expect(getSnapshot()).toMatchObject({
      rendering: "enhanced",
      media: "high",
      motion: "standard",
      reason: "promotion",
    });

    jest.advanceTimersByTime(8_000);
    notifyAdaptiveRoute();
    expect(getSnapshot()).toMatchObject({
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
      reason: "promotion",
    });
    expect(promotionListener).toHaveBeenCalledTimes(1);
    const persisted = sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY) || "";
    expect(persisted).not.toMatch(/iPhone|Safari|apple-iphone|userAgent/i);

    window.removeEventListener(ADAPTIVE_QUALITY_PROMOTION_EVENT, promotionListener);
    cleanup();
  });

  it("never promotes an admitted UA after a runtime downgrade", async () => {
    jest.useFakeTimers();
    FakePerformanceObserver.supportedEntryTypes = ["longtask"];
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    });
    const promotionListener = jest.fn();
    window.addEventListener(ADAPTIVE_QUALITY_PROMOTION_EVENT, promotionListener);
    const cleanup = startAdaptiveQualityController();
    await Promise.resolve();
    __requestAdaptiveDowngradeForTesting("repeated-long-task");

    for (let route = 0; route < 4; route += 1) {
      jest.advanceTimersByTime(8_000);
      notifyAdaptiveRoute();
    }

    expect(promotionListener).not.toHaveBeenCalled();
    expect(getSnapshot()).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "minimal",
    });

    window.removeEventListener(ADAPTIVE_QUALITY_PROMOTION_EVENT, promotionListener);
    cleanup();
  });

  it("applies preference changes immediately and never enriches on removal", () => {
    FakePerformanceObserver.supportedEntryTypes = ["longtask"];
    const mediaListeners = new Set<() => void>();
    const reducedMotion = {
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
    } as MediaQueryList;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: jest.fn((query: string) =>
        query.includes("reduced-motion")
          ? reducedMotion
          : {
              ...reducedMotion,
              matches: false,
              media: query,
            },
      ),
    });
    const connection = new EventTarget() as EventTarget & {
      saveData: boolean;
      effectiveType: string;
    };
    connection.saveData = false;
    connection.effectiveType = "4g";
    Object.defineProperty(navigator, "connection", {
      configurable: true,
      value: connection,
    });
    const cleanup = startAdaptiveQualityController();

    Object.defineProperty(reducedMotion, "matches", {
      configurable: true,
      value: true,
    });
    mediaListeners.forEach((listener) => listener());
    expect(getSnapshot().motion).toBe("minimal");

    Object.defineProperty(reducedMotion, "matches", {
      configurable: true,
      value: false,
    });
    mediaListeners.forEach((listener) => listener());
    expect(getSnapshot().motion).toBe("minimal");

    connection.saveData = true;
    connection.dispatchEvent(new Event("change"));
    expect(getSnapshot().media).toBe("economy");
    connection.saveData = false;
    connection.dispatchEvent(new Event("change"));
    expect(getSnapshot().media).toBe("economy");
    cleanup();
  });

  it("does not observe while hidden and starts a fresh window when visible", () => {
    FakePerformanceObserver.supportedEntryTypes = ["longtask"];
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    const cleanup = startAdaptiveQualityController();
    expect(FakePerformanceObserver.instances).toHaveLength(0);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakePerformanceObserver.instances).toHaveLength(1);
    cleanup();
  });

  it("uses bounded rAF sampling when performance observers are unavailable", () => {
    jest.useFakeTimers();
    let frameCallback: FrameRequestCallback | undefined;
    let frameId = 0;
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: jest.fn((callback: FrameRequestCallback) => {
        frameCallback = callback;
        frameId += 1;
        return frameId;
      }),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: jest.fn(),
    });

    const cleanup = startAdaptiveQualityController();
    let time = 0;
    for (let index = 0; index < 32; index += 1) {
      const callback = frameCallback;
      expect(callback).toBeDefined();
      time += index >= 26 ? 60 : 16;
      callback?.(time);
    }
    jest.advanceTimersByTime(8_000);

    expect(getSnapshot()).toMatchObject({
      motion: "minimal",
      reason: "raf-jank",
    });
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(33);
    cleanup();
  });

  it("reference-counts Strict Mode mounts and replaces stale route observers", () => {
    FakePerformanceObserver.supportedEntryTypes = ["longtask"];
    const firstCleanup = startAdaptiveQualityController();
    const secondCleanup = startAdaptiveQualityController();

    expect(FakePerformanceObserver.instances).toHaveLength(1);
    firstCleanup();
    expect(FakePerformanceObserver.instances[0].disconnected).toBe(false);

    notifyAdaptiveRoute();
    expect(FakePerformanceObserver.instances[0].disconnected).toBe(true);
    expect(FakePerformanceObserver.instances).toHaveLength(2);

    secondCleanup();
    expect(FakePerformanceObserver.instances[1].disconnected).toBe(true);
  });
});
