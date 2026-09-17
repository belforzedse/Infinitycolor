/**
 * Storefront release probe.
 *
 * `/build-version.json` is the live origin's build id. The JS bundle's
 * `BUILD_VERSION` is whatever HTML the visitor actually loaded. Those two
 * diverge after a frontend deploy for as long as the edge (s-maxage=300 plus
 * stale-while-revalidate=600) still holds the previous document — and a
 * normal `location.reload()` asks that same edge for the same URL, so the
 * banner's "به‌روزرسانی" button appeared to do nothing.
 */

export const VERSION_RELOAD_STORAGE_KEY = "infinity:version-reload-attempt";
export const VERSION_RELOAD_QUERY = "_icv";

/** Homepage/PLP cache keys include the query string; a unique value is a miss. */
export const VERSION_RELOAD_SUPPRESS_MS = 15 * 60 * 1000;

export type VersionReloadAttempt = {
  version: string;
  at: number;
};

export function buildCacheBustingReloadUrl(href: string, version: string): string {
  const url = new URL(href);
  url.searchParams.set(VERSION_RELOAD_QUERY, version);
  return url.toString();
}

export function stripCacheBustingReloadParam(href: string): string {
  const url = new URL(href);
  if (!url.searchParams.has(VERSION_RELOAD_QUERY)) {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  url.searchParams.delete(VERSION_RELOAD_QUERY);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function parseVersionReloadAttempt(raw: string | null): VersionReloadAttempt | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      !("at" in parsed)
    ) {
      return null;
    }
    const version = parsed.version;
    const at = parsed.at;
    if (
      typeof version !== "string" ||
      version.length === 0 ||
      typeof at !== "number" ||
      !Number.isFinite(at)
    ) {
      return null;
    }
    return { version, at };
  } catch {
    return null;
  }
}

/**
 * After the visitor already asked for this origin version, hide the banner
 * until the edge TTL has elapsed. Re-show if a newer origin version appears.
 */
export function shouldHideStaleBanner(
  serverVersion: string,
  attempt: VersionReloadAttempt | null,
  now: number,
): boolean {
  if (!attempt || attempt.version !== serverVersion) return false;
  return now - attempt.at < VERSION_RELOAD_SUPPRESS_MS;
}
