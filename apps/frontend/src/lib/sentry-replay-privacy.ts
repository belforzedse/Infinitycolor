const PUBLIC_REPLAY_PATHS = new Set([
  "/",
  "/about",
  "/blog",
  "/categories",
  "/contact",
  "/faq",
  "/pdp",
  "/plp",
  "/returns",
]);

const PUBLIC_REPLAY_PREFIXES = ["/blog/", "/pdp/", "/plp/"];

function pathnameFromUrl(value: string): string | null {
  try {
    return new URL(value, "https://infinitycolor.invalid").pathname;
  } catch {
    return null;
  }
}

/**
 * Replay is opt-in by public storefront route. Unknown, authenticated,
 * transactional, callback, and administrative routes are denied by default.
 */
export function isReplayAllowedUrl(value: string): boolean {
  const pathname = pathnameFromUrl(value);

  if (!pathname) {
    return false;
  }

  if (PUBLIC_REPLAY_PATHS.has(pathname)) {
    return true;
  }

  return PUBLIC_REPLAY_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function replaySampleRate(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
}
