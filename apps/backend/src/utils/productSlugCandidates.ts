/**
 * Build the set of slug strings that might identify the same product.
 *
 * Why this exists: 1402 production products were imported with WooCommerce's
 * percent-encoded slug stored verbatim (e.g. `%d8%b3%d8%aa-…-y00574`). The
 * storefront and Koa both decode URL path segments, so a request for the
 * human Persian URL never matched the stored literal — and a request for the
 * encoded form was decoded before the lookup, so that missed too. Every form
 * 404'd.
 *
 * Candidates cover:
 * - the raw inbound value (already-decoded OR still-encoded)
 * - decode-once
 * - re-encode (JS's uppercase hex AND lowercase hex matching WooCommerce)
 * - NFC normalization
 * - Arabic ي/ك → Persian ی/ک folding (lookup only — never persisted)
 *
 * ZWNJ is preserved; we do not strip it.
 */

const ARABIC_YEH = /\u064A/g; // ي
const ARABIC_KAF = /\u0643/g; // ك
const PERSIAN_YEH = "\u06CC"; // ی
const PERSIAN_KAF = "\u06A9"; // ک

export function safeDecodeSlug(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** encodeURIComponent, then force hex escapes to lowercase to match WooCommerce. */
export function encodeSlugLower(value: string): string {
  return encodeURIComponent(value).replace(/%[0-9A-Fa-f]{2}/g, (m) => m.toLowerCase());
}

export function foldArabicToPersian(value: string): string {
  return value.replace(ARABIC_YEH, PERSIAN_YEH).replace(ARABIC_KAF, PERSIAN_KAF);
}

/**
 * Ordered, deduplicated candidate list for a product-slug lookup.
 */
export function buildProductSlugCandidates(rawSlug: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (value: string | null | undefined) => {
    if (!value) return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  const raw = String(rawSlug ?? "");
  add(raw);

  const decoded = safeDecodeSlug(raw);
  add(decoded);

  const nfc = decoded.normalize("NFC");
  add(nfc);

  add(encodeURIComponent(decoded));
  add(encodeSlugLower(decoded));
  add(encodeURIComponent(nfc));
  add(encodeSlugLower(nfc));

  const folded = foldArabicToPersian(nfc);
  add(folded);
  add(encodeURIComponent(folded));
  add(encodeSlugLower(folded));

  // If the inbound value was itself percent-encoded Persian text stored as a
  // literal, decoding once yields the canonical form; encoding that again is
  // already covered. Also try decoding twice for double-encoded inbound URLs.
  if (decoded !== raw) {
    const decodedTwice = safeDecodeSlug(decoded);
    add(decodedTwice);
    add(decodedTwice.normalize("NFC"));
  }

  return out;
}
