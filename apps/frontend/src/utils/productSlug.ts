/**
 * Storefront helpers for product slug canonicalization.
 *
 * Canonical form is the decoded Persian (or ASCII) slug. Percent-encoded
 * historical imports and other prior forms should 301 here.
 */

export function safeDecodeProductSlug(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/**
 * Canonical slug stored after repair / new imports: decode-once of whatever
 * Strapi currently has on the product.
 */
export function canonicalProductSlug(storedSlug: string | null | undefined): string {
  if (!storedSlug) return "";
  return safeDecodeProductSlug(String(storedSlug));
}

/**
 * True when the inbound route param is a non-canonical form of the same
 * product and the request should permanently redirect to `canonical`.
 *
 * Numeric ID URLs are handled separately by `proxy.ts`.
 */
export function shouldRedirectToCanonicalSlug(
  routeSlug: string,
  storedSlug: string | null | undefined,
): boolean {
  const canonical = canonicalProductSlug(storedSlug);
  if (!canonical) return false;
  const decodedRouteSlug = safeDecodeProductSlug(routeSlug);
  if (/^\d+$/.test(routeSlug) || /^\d+$/.test(decodedRouteSlug)) {
    return false;
  }
  // Next.js can expose an encoded route segment even when the browser is
  // already at the canonical Persian URL. Compare decoded values so we do not
  // redirect that request back to the exact same URL forever.
  return decodedRouteSlug !== canonical;
}

export function buildCanonicalPdpPath(storedSlug: string | null | undefined): string {
  const canonical = canonicalProductSlug(storedSlug);
  return `/pdp/${encodeURIComponent(canonical)}`;
}
