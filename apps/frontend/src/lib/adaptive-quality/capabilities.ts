import type { AdaptiveCapabilities } from "./types";

type NavigatorWithHints = Navigator & {
  deviceMemory?: unknown;
  connection?: EventTarget & {
    saveData?: boolean;
    effectiveType?: string;
  };
  mozConnection?: EventTarget & {
    saveData?: boolean;
    effectiveType?: string;
  };
  webkitConnection?: EventTarget & {
    saveData?: boolean;
    effectiveType?: string;
  };
};

export function readAdaptiveCapabilities(): AdaptiveCapabilities {
  if (typeof window === "undefined" || typeof navigator === "undefined") return {};
  const nav = navigator as NavigatorWithHints;
  const connection = getNetworkConnection(nav);
  const deviceMemory = safeNavigatorValue(() => nav.deviceMemory);
  const hardwareConcurrency = safeNavigatorValue(
    () => nav.hardwareConcurrency,
  );

  return {
    reducedMotion: safeMediaMatch("(prefers-reduced-motion: reduce)"),
    reducedTransparency: safeMediaMatch("(prefers-reduced-transparency: reduce)"),
    saveData: connection?.saveData === true,
    effectiveType:
      typeof connection?.effectiveType === "string" ? connection.effectiveType : undefined,
    deviceMemory: normalizeReportedNumber(deviceMemory),
    hardwareConcurrency: normalizeReportedNumber(hardwareConcurrency),
    finePointer: safeMediaMatch("(pointer: fine)"),
    hover: safeMediaMatch("(hover: hover)"),
  };
}

export function getNetworkConnection(
  nav: NavigatorWithHints = typeof navigator === "undefined"
    ? ({} as NavigatorWithHints)
    : (navigator as NavigatorWithHints),
) {
  try {
    return nav.connection || nav.mozConnection || nav.webkitConnection;
  } catch {
    return undefined;
  }
}

export function safeMediaQuery(query: string): MediaQueryList | null {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query)
      : null;
  } catch {
    return null;
  }
}

function safeMediaMatch(query: string): boolean | undefined {
  const mediaQuery = safeMediaQuery(query);
  return mediaQuery ? mediaQuery.matches : undefined;
}

function normalizeReportedNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : Number.NaN;
}

function safeNavigatorValue(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return Number.NaN;
  }
}
