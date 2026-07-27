import { getAdaptiveQualityBootstrapScript } from "../bootstrap-script";
import {
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_STORAGE_KEY,
} from "../config";

type HintOverrides = {
  memory?: number;
  cores?: number;
  reducedMotion?: boolean;
  reducedTransparency?: boolean;
  saveData?: boolean;
  effectiveType?: string;
};

function installHints(overrides: HintOverrides = {}) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches:
        query.includes("reduced-motion")
          ? Boolean(overrides.reducedMotion)
          : query.includes("reduced-transparency")
            ? Boolean(overrides.reducedTransparency)
            : false,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }),
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
}

function runBootstrap() {
  Function(getAdaptiveQualityBootstrapScript())();
}

describe("adaptive quality pre-hydration bootstrap", () => {
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

  it("classifies and writes root attributes synchronously", () => {
    installHints({
      memory: 2,
      cores: 2,
      reducedTransparency: true,
      saveData: true,
    });
    runBootstrap();
    expect(document.documentElement.dataset).toMatchObject({
      aqScope: "storefront",
      aqRendering: "safe",
      aqMedia: "economy",
      aqMotion: "minimal",
      aqTransparency: "reduced",
    });
    expect(window.__INFINITY_AQ_BOOTSTRAP__).toMatchObject({
      rendering: "safe",
      media: "economy",
      motion: "minimal",
      reducedTransparency: true,
      policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
    });
    expect(sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY)).toBeTruthy();
  });

  it("keeps unsupported hints at Standard", () => {
    runBootstrap();
    expect(window.__INFINITY_AQ_BOOTSTRAP__).toMatchObject({
      rendering: "standard",
      media: "standard",
      motion: "standard",
    });
  });

  it("contains no browser import or fetch path", () => {
    const source = getAdaptiveQualityBootstrapScript();
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it("reuses one anonymous bucket and persists no raw capability values", () => {
    installHints({
      memory: 2,
      cores: 2,
      saveData: true,
      effectiveType: "3g",
    });
    runBootstrap();
    const firstBucket = window.__INFINITY_AQ_BOOTSTRAP__?.rolloutBucket;
    const persisted = sessionStorage.getItem(ADAPTIVE_QUALITY_STORAGE_KEY) || "";
    expect(firstBucket).toEqual(expect.any(Number));
    expect(persisted).not.toMatch(
      /deviceMemory|hardwareConcurrency|effectiveType|pathname|url|frame|task/i,
    );

    delete window.__INFINITY_AQ_BOOTSTRAP__;
    runBootstrap();
    expect(window.__INFINITY_AQ_BOOTSTRAP__?.rolloutBucket).toBe(firstBucket);
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
