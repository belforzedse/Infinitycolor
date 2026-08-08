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
  if (/^\d+$/.test(routeSlug) || /^\d+$/.test(safeDecodeProductSlug(routeSlug))) {
    return false;
  }
  // Redirect whenever the raw route segment is not already the canonical
  // string. Includes: literal percent-encoded historical slugs, and any
  // case where Strapi still stores the encoded form (pre-repair).
  return routeSlug !== canonical;
}

export function buildCanonicalPdpPath(storedSlug: string | null | undefined): string {
  const canonical = canonicalProductSlug(storedSlug);
  return `/pdp/${encodeURIComponent(canonical)}`;
}
