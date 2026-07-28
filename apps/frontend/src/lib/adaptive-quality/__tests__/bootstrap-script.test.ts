import { getAdaptiveQualityBootstrapScript } from "../bootstrap-script";
import {
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_SCHEMA,
  ADAPTIVE_QUALITY_STORAGE_KEY,
} from "../config";
import { classifyAdaptiveQuality } from "../policy";
import type { AdaptiveCapabilities } from "../types";

type HintOverrides = {
  memory?: number;
  cores?: number;
  finePointer?: boolean;
  hover?: boolean;
  reducedMotion?: boolean;
  reducedTransparency?: boolean;
  saveData?: boolean;
  effectiveType?: string;
  userAgent?: string;
};

const DEFAULT_USER_AGENT = navigator.userAgent;
const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

function installHints(overrides: HintOverrides = {}) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      const matches =
        query === "(prefers-reduced-motion: reduce)"
          ? Boolean(overrides.reducedMotion)
          : query === "(prefers-reduced-transparency: reduce)"
            ? Boolean(overrides.reducedTransparency)
            : query === "(pointer: fine)"
              ? Boolean(overrides.finePointer)
              : query === "(hover: hover)"
                ? Boolean(overrides.hover)
                : false;
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      };
    },
  });
  Object.defineProperty(navigator, "deviceMemory", {
    configurable: true,
    value: overrides.memory,
  });
  Object.defineProperty(navigator, "hardwareConcurrency", {
    configurable: true,
    value: overrides.cores,
  });
  Object.defineProperty(navigator, "connection", {
    configurable: true,
    value: {
      saveData: overrides.saveData,
      effectiveType: overrides.effectiveType,
    },
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: overrides.userAgent ?? DEFAULT_USER_AGENT,
  });
}

function runBootstrap() {
  Function(getAdaptiveQualityBootstrapScript())();
}

describe("adaptive quality v2 pre-hydration bootstrap", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    sessionStorage.clear();
    delete window.__INFINITY_AQ_BOOTSTRAP__;
    document.documentElement.removeAttribute("data-aq-scope");
    document.documentElement.removeAttribute("data-aq-rendering");
    document.documentElement.removeAttribute("data-aq-media");
    document.documentElement.removeAttribute("data-aq-motion");
    document.documentElement.removeAttribute("data-aq-transparency");
    installHints();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("starts a capable desktop at peak before hydration without UA spoofing", () => {
    installHints({
      memory: 8,
      cores: 8,
      finePointer: true,
      hover: true,
    });
    runBootstrap();

    expect(window.__INFINITY_AQ_BOOTSTRAP__).toMatchObject({
      schema: ADAPTIVE_QUALITY_SCHEMA,
      policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
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
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    });
    expect(document.documentElement.dataset).toMatchObject({
      aqScope: "storefront",
      aqRendering: "enhanced",
      aqMedia: "high",
      aqMotion: "enhanced",
    });
  });

  it.each([
    { memory: 4, cores: 8, finePointer: true, hover: true },
    { memory: 8, cores: 7, finePointer: true, hover: true },
    { memory: 8, cores: 8, finePointer: false, hover: true },
    { memory: 8, cores: 8, finePointer: true, hover: false },
    {},
  ])("keeps weak, touch-primary, and unknown devices Standard", (hints) => {
    installHints(hints);
    runBootstrap();
    expect(window.__INFINITY_AQ_BOOTSTRAP__).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
  });

  it("uses 3g as a reversible Standard media cap, not Economy", () => {
    installHints({
      memory: 8,
      cores: 8,
      finePointer: true,
      hover: true,
      effectiveType: "3g",
    });
    runBootstrap();
    expect(window.__INFINITY_AQ_BOOTSTRAP__).toMatchObject({
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
      rendering: "enhanced",
      media: "standard",
      motion: "enhanced",
    });
  });

  it("keeps Save Data, Reduced Motion, and Reduced Transparency live", () => {
    installHints({
      memory: 8,
      cores: 8,
      finePointer: true,
      hover: true,
      saveData: true,
      reducedMotion: true,
      reducedTransparency: true,
    });
    runBootstrap();
    expect(window.__INFINITY_AQ_BOOTSTRAP__).toMatchObject({
      runtimeConstraint: {
        rendering: "enhanced",
        media: "high",
        motion: "enhanced",
      },
      rendering: "enhanced",
      media: "economy",
      motion: "minimal",
      reducedTransparency: true,
    });
  });

  it("preserves researched iPhone admission", () => {
    installHints({ userAgent: IPHONE_USER_AGENT });
    runBootstrap();
    expect(window.__INFINITY_AQ_BOOTSTRAP__).toMatchObject({
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    });
  });

  it("discards the exact supplied v1.2 Safe record and removes the old key", () => {
    sessionStorage.setItem(
      "infinity:adaptive-quality:v1",
      JSON.stringify({
        schema: 1,
        policyVersion: "1.2.0",
        buildVersion: "8a03fc7-1785240384007",
        expiresAt: 1785263452859,
        constraint: {
          rendering: "safe",
          media: "economy",
          motion: "minimal",
        },
        lastSmoothRouteGeneration: 17,
        reasons: ["default", "slow-connection", "severe-loaf"],
        rolloutBucket: 7396,
        sessionHadDowngrade: true,
        sessionHadSevereEvent: true,
        smoothRouteGenerations: 1,
        smoothWindows: 1,
      }),
    );
    installHints({
      memory: 8,
      cores: 8,
      finePointer: true,
      hover: true,
    });

    runBootstrap();

    expect(sessionStorage.getItem("infinity:adaptive-quality:v1")).toBeNull();
    expect(sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY)).toBeTruthy();
    expect(window.__INFINITY_AQ_BOOTSTRAP__).toMatchObject({
      schema: 2,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    });
  });

  it("keeps the six-hour record expiry fixed across bootstrap writes", () => {
    const dateSpy = jest.spyOn(Date, "now").mockReturnValue(1_000);
    runBootstrap();
    const first = JSON.parse(
      sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY) || "{}",
    );

    dateSpy.mockReturnValue(10_000);
    delete window.__INFINITY_AQ_BOOTSTRAP__;
    runBootstrap();
    const second = JSON.parse(
      sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY) || "{}",
    );

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.expiresAt).toBe(first.expiresAt);
  });

  it.each([
    {
      hints: {
        memory: 8,
        cores: 8,
        finePointer: true,
        hover: true,
        effectiveType: "4g",
      },
      capabilities: {
        deviceMemory: 8,
        hardwareConcurrency: 8,
        finePointer: true,
        hover: true,
        effectiveType: "4g",
      },
      admittedHighEndMobile: false,
    },
    {
      hints: {
        memory: 4,
        cores: 4,
        finePointer: true,
        hover: true,
        saveData: true,
      },
      capabilities: {
        deviceMemory: 4,
        hardwareConcurrency: 4,
        finePointer: true,
        hover: true,
        saveData: true,
      },
      admittedHighEndMobile: false,
    },
    {
      hints: {
        userAgent: IPHONE_USER_AGENT,
        reducedMotion: true,
        effectiveType: "3g",
      },
      capabilities: {
        reducedMotion: true,
        effectiveType: "3g",
      },
      admittedHighEndMobile: true,
    },
  ] as Array<{
    hints: HintOverrides;
    capabilities: AdaptiveCapabilities;
    admittedHighEndMobile: boolean;
  }>)(
    "matches the hydrated policy matrix %#",
    ({ hints, capabilities, admittedHighEndMobile }) => {
      installHints(hints);
      runBootstrap();
      const expected = classifyAdaptiveQuality(capabilities, {
        admittedHighEndMobile,
      });
      expect(window.__INFINITY_AQ_BOOTSTRAP__).toMatchObject({
        baselineConstraint: expected.baselineConstraint,
        runtimeConstraint: expected.runtimeConstraint,
        rendering: expected.snapshot.rendering,
        media: expected.snapshot.media,
        motion: expected.snapshot.motion,
        reducedTransparency: expected.snapshot.reducedTransparency,
      });
    },
  );

  it("persists no raw capability or identity values", () => {
    installHints({
      memory: 8,
      cores: 16,
      finePointer: true,
      hover: true,
      saveData: true,
      effectiveType: "3g",
    });
    runBootstrap();
    const persisted = sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY) || "";
    expect(persisted).not.toMatch(
      /deviceMemory|hardwareConcurrency|effectiveType|userAgent|model|pointer|pathname|url|frame|task/i,
    );
  });

  it("contains no browser import or fetch path", () => {
    const source = getAdaptiveQualityBootstrapScript();
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it("remains synchronous and usable when session storage is blocked", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });

    runBootstrap();
    expect(window.__INFINITY_AQ_BOOTSTRAP__).toMatchObject({
      enabled: true,
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
    expect(document.documentElement.dataset.aqScope).toBe("storefront");
  });

  it("does not touch storage, globals, or attributes on super-admin", () => {
    window.history.replaceState({}, "", "/super-admin/products");
    const storageSpy = jest.spyOn(Storage.prototype, "getItem");
    runBootstrap();
    expect(storageSpy).not.toHaveBeenCalled();
    expect(window.__INFINITY_AQ_BOOTSTRAP__).toBeUndefined();
    expect(document.documentElement.dataset.aqScope).toBeUndefined();
  });
});
