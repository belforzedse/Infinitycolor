/**
 * Pre-paint analytics-consent state.
 *
 * The consent choice lives in `localStorage`, which a server render cannot read —
 * and it must not become a cookie, because the gateway page cache is keyed on
 * `$scheme$host$request_uri` with no cookie in the key (`deploy/production/gateway.conf`)
 * and ArvanCloud page-caches PLP/PDP HTML for 120-300s. Per-visitor HTML would be
 * served to the wrong visitors.
 *
 * So the banner is always in the server HTML and this script, running synchronously
 * in the head, writes the known choice onto `<html>` before first paint so CSS can
 * hide it. Before this, `ConsentManager` rendered `null` until a hydration-time
 * effect read storage, which made its paragraph paint at ~5.0s on a throttled
 * mobile PDP and take LCP from the product hero (done at ~1.6s).
 *
 * This module is deliberately free of the `"use client"` directive and of imports,
 * so the server layout can pull in the generator, and owns the storage key that
 * `lib/analytics` re-exports.
 */

export const ANALYTICS_CONSENT_STORAGE_KEY = "analytics-consent";

/** Attribute on `<html>`: the stored choice, or `unknown` when none was made. */
export const ANALYTICS_CONSENT_ATTRIBUTE = "data-analytics-consent";

export type AnalyticsConsentAttributeValue = "granted" | "denied" | "unknown";

/**
 * Mirrors the stored choice onto `<html>`. Called by the bootstrap script before
 * paint and again by `setAnalyticsConsent` so the attribute can never drift from
 * storage. Every browser API here is treated as fallible: a private window can
 * throw on `localStorage`, and the attribute is then simply left at `unknown`.
 */
export function applyAnalyticsConsentAttribute(value: AnalyticsConsentAttributeValue): void {
  if (typeof document === "undefined") return;
  try {
    document.documentElement.setAttribute(ANALYTICS_CONSENT_ATTRIBUTE, value);
  } catch {
    // A detached or restricted document is not worth failing a render over.
  }
}

/**
 * Runs synchronously in the document head. The returned browser source has no
 * imports, no fetches, and treats storage as fallible.
 */
export function getAnalyticsConsentBootstrapScript(): string {
  return `;(() => {
    try {
      var stored = null;
      try {
        stored = localStorage.getItem(${JSON.stringify(ANALYTICS_CONSENT_STORAGE_KEY)});
      } catch {}
      document.documentElement.setAttribute(
        ${JSON.stringify(ANALYTICS_CONSENT_ATTRIBUTE)},
        stored === "granted" || stored === "denied" ? stored : "unknown"
      );
    } catch {}
  })();`;
}
