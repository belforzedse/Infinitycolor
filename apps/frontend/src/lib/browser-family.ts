/**
 * Coarse browser family plus major version, e.g. `samsung-internet-21`.
 *
 * The storefront rules forbid emitting raw User-Agent values, and a family is
 * what a browser-specific bug actually needs. Samsung Internet is matched before
 * Chrome because its User-Agent contains both tokens.
 */
const MATCHERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/SamsungBrowser\/(\d+)/i, "samsung-internet"],
  [/\bFBAN|\bFBAV|Instagram/i, "meta-webview"],
  [/\bEdgA?\/(\d+)/i, "edge"],
  [/OPR\/(\d+)|Opera/i, "opera"],
  [/\bFirefox\/(\d+)/i, "firefox"],
  [/CriOS\/(\d+)/i, "chrome-ios"],
  [/\bChrome\/(\d+)/i, "chrome"],
  [/Version\/(\d+).*Safari/i, "safari"],
];

export function browserFamily(userAgent: string | null | undefined): string {
  if (!userAgent) return "unknown";
  for (const [pattern, name] of MATCHERS) {
    const found = pattern.exec(userAgent);
    if (found) return found[1] ? `${name}-${found[1]}` : name;
  }
  return "other";
}

/** Browser family of the current tab; `unknown` during server rendering. */
export function currentBrowserFamily(): string {
  if (typeof navigator === "undefined") return "unknown";
  try {
    return browserFamily(navigator.userAgent);
  } catch {
    return "unknown";
  }
}
