/**
 * Build the safe spellings that may identify the same product slug.
 *
 * Historical WooCommerce imports stored Persian slugs as literal lowercase
 * percent-encoded strings. Routers decode URL path segments before lookup, so
 * both the decoded Unicode form and the stored URI spelling must be queried.
 *
 * ZWNJ is preserved. Arabic yeh/kaf folding is lookup-only and is never written
 * back to the catalog.
 */

const ARABIC_YEH = /\u064A/g;
const ARABIC_KAF = /\u0643/g;

export function safeDecodeSlug(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function encodeSlugLower(value: string): string {
  return encodeURIComponent(value).replace(/%[0-9A-Fa-f]{2}/g, (match) => match.toLowerCase());
}

export function foldArabicToPersian(value: string): string {
  return value.replace(ARABIC_YEH, "\u06CC").replace(ARABIC_KAF, "\u06A9");
}

export function buildProductSlugCandidates(rawSlug: string): string[] {
  const candidates = new Set<string>();

  const addForms = (value: string) => {
    if (!value) return;

    const decoded = safeDecodeSlug(value);
    const normalized = decoded.normalize("NFC");
    const folded = foldArabicToPersian(normalized);

    for (const candidate of [value, decoded, normalized, folded]) {
      if (!candidate) continue;
      candidates.add(candidate);
      candidates.add(encodeURIComponent(candidate));
      candidates.add(encodeSlugLower(candidate));
    }
  };

  const raw = String(rawSlug ?? "");
  addForms(raw);

  const decoded = safeDecodeSlug(raw);
  if (decoded !== raw) {
    addForms(decoded);
    addForms(safeDecodeSlug(decoded));
  }

  return Array.from(candidates);
}
