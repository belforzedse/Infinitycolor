/**
 * Product codes are stored inside the product Title with a space between the
 * letter prefix and the digits ("بامبر جیب نما W 00288"), while the code the
 * customer knows from the legacy storefront — and the one printed on labels,
 * slugs and image captions — has no space ("W00288"). A plain substring match
 * therefore misses the product whichever form the shopper types.
 *
 * Expanding the term into both spellings keeps the match a substring match (no
 * per-row normalization in SQL) and is an identity for terms that hold no
 * letter/digit boundary, so ordinary text searches emit exactly the same query
 * as before.
 */

const PERSIAN_ARABIC_DIGITS = /[۰-۹٠-٩]/g;

/** Convert Persian (U+06F0–U+06F9) and Arabic-Indic (U+0660–U+0669) digits to ASCII. */
const normalizeDigits = (input: string): string =>
  input.replace(PERSIAN_ARABIC_DIGITS, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x0660 && code <= 0x0669 ? 0x0660 : 0x06f0;
    return String(code - base);
  });

const LETTER_DIGIT_BOUNDARY = /([A-Za-z]+)[\s\u200c]*(\d)/g;

/**
 * Expand a raw search term into the spellings that should be matched.
 *
 * Returns the original term first so callers that only use the head keep the
 * current behaviour, and returns an empty list for a blank term.
 */
export const expandSearchTermVariants = (raw: unknown): string[] => {
  if (typeof raw !== "string") return [];
  const term = raw.trim();
  if (term === "") return [];

  const normalized = normalizeDigits(term);
  const variants = [
    term,
    normalized,
    normalized.replace(LETTER_DIGIT_BOUNDARY, "$1 $2"),
    normalized.replace(LETTER_DIGIT_BOUNDARY, "$1$2"),
  ];

  return [...new Set(variants)];
};

export default expandSearchTermVariants;
