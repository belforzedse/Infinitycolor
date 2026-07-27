import type { AdaptiveCapabilities } from "./types";

type NavigatorWithHints = Navigator & {
  deviceMemory?: number;
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

  return {
    reducedMotion: safeMediaMatch("(prefers-reduced-motion: reduce)"),
    reducedTransparency: safeMediaMatch(
      "(prefers-reduced-transparency: reduce)",
    ),
    saveData: connection?.saveData === true,
    effectiveType:
      typeof connection?.effectiveType === "string"
        ? connection.effectiveType
        : undefined,
    deviceMemory:
      typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
    hardwareConcurrency:
      typeof nav.hardwareConcurrency === "number"
        ? nav.hardwareConcurrency
        : undefined,
  };
}

export function getNetworkConnection(
  nav: NavigatorWithHints =
    typeof navigator === "undefined" ? ({} as NavigatorWithHints) : (navigator as NavigatorWithHints),
) {
  return nav.connection || nav.mozConnection || nav.webkitConnection;
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

