"use strict";

/**
 * One deterministic answer to "which WooCommerce field holds this product's
 * description?".
 *
 * WooCommerce gives a product two body fields and the shop's editors used them
 * inconsistently over the years: of 3,400 live products 3,374 have text only in
 * `short_description`, 2 only in `description`, and a handful carry leftovers in
 * one field and the real copy in the other. The importer used to read
 * `description || short_description`, so any non-empty markup in `description`
 * won — including an editing leftover like `<p><del>my</del></p>`, which is what
 * two production PDPs show today instead of their real copy.
 *
 * The rules below are pure, side-effect free and total: every pair of inputs
 * produces exactly one `{ html, source, reason }`, and the reason is reported by
 * the importer so an operator can see *why* a field was chosen rather than
 * having to diff WooCommerce by hand.
 */

const NAMED_ENTITIES = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  zwnj: "‌",
  zwj: "‍",
  laquo: "«",
  raquo: "»",
  hellip: "…",
  ndash: "–",
  mdash: "—",
};

/** Text long enough, or structured enough, to be a real description. */
const TRIVIAL_MAX_CHARS = 24;
const TRIVIAL_MAX_WORDS = 4;
/** Share of the shorter text's words that must also appear in the longer one
 *  before the two are treated as saying the same thing. */
const REDUNDANT_TOKEN_RATIO = 0.8;
const STRUCTURE_PATTERN = /<(?:ul|ol|table|h[1-4])\b/i;

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const codePoint = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 1 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** What a reader actually sees: no markup, no entities, no runs of whitespace. */
function visibleText(html) {
  if (!html || typeof html !== "string") return "";
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " "),
  )
    // A non-breaking space is whitespace to a reader even though \s misses it
    // in older engines; normalise it before collapsing.
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Text reduced to what two Persian strings must share to count as the same
 * copy: no zero-width joiners, no Arabic/Persian letter-shape differences, no
 * punctuation, no case.
 */
function comparableText(html) {
  return visibleText(html)
    .normalize("NFC")
    // A zero-width non-joiner separates the visual forms of what is, to a
    // reader, the same two words written with a space — so it becomes one.
    .replace(/[​-‍]/g, " ")
    .replace(/[‎‏ـ]/g, "")
    .replace(/ي/g, "ی")
    .replace(/ى/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when the markup renders to nothing: `<p></p>`, `<br>`, `&nbsp;`, … */
function isEffectivelyEmpty(html) {
  return visibleText(html) === "";
}

function wordCount(text) {
  return text ? text.split(" ").filter(Boolean).length : 0;
}

/**
 * An editing leftover rather than a description: a few characters, a few words,
 * and no list, table or heading that would make it structured content.
 */
function isTrivial(html) {
  const text = visibleText(html);
  if (text === "") return true;
  if (STRUCTURE_PATTERN.test(String(html))) return false;
  return text.length < TRIVIAL_MAX_CHARS && wordCount(text) < TRIVIAL_MAX_WORDS;
}

/** Share of the shorter text's distinct words that also occur in the longer. */
function tokenOverlapRatio(shorter, longer) {
  const shorterTokens = new Set(shorter.split(" ").filter(Boolean));
  if (shorterTokens.size === 0) return 1;
  const longerTokens = new Set(longer.split(" ").filter(Boolean));
  let shared = 0;
  for (const token of shorterTokens) {
    if (longerTokens.has(token)) shared += 1;
  }
  return shared / shorterTokens.size;
}

function richerOf(main, short) {
  // Ties go to `description`: it is WooCommerce's own primary body field.
  return visibleText(short).length > visibleText(main).length
    ? { html: short, source: "short_description" }
    : { html: main, source: "description" };
}

/**
 * Choose the description to import for one WooCommerce product.
 *
 * @param {{ description?: string, short_description?: string }} wcProduct
 * @returns {{ html: string, source: "description"|"short_description"|"both"|"none", reason: string }}
 */
function resolveProductDescription(wcProduct) {
  const main = typeof wcProduct?.description === "string" ? wcProduct.description : "";
  const short = typeof wcProduct?.short_description === "string" ? wcProduct.short_description : "";

  const mainEmpty = isEffectivelyEmpty(main);
  const shortEmpty = isEffectivelyEmpty(short);
  if (mainEmpty && shortEmpty) return { html: "", source: "none", reason: "BOTH_EMPTY" };
  if (mainEmpty) return { html: short, source: "short_description", reason: "MAIN_EMPTY" };
  if (shortEmpty) return { html: main, source: "description", reason: "SHORT_EMPTY" };

  const mainTrivial = isTrivial(main);
  const shortTrivial = isTrivial(short);
  // The reported defect: a leftover in `description` outranking the real copy.
  if (mainTrivial && !shortTrivial) return { html: short, source: "short_description", reason: "MAIN_TRIVIAL" };
  if (shortTrivial && !mainTrivial) return { html: main, source: "description", reason: "SHORT_TRIVIAL" };
  if (mainTrivial && shortTrivial) {
    return { ...richerOf(main, short), reason: "BOTH_TRIVIAL" };
  }

  const mainText = comparableText(main);
  const shortText = comparableText(short);
  if (mainText === shortText) {
    return { ...richerOf(main, short), reason: "IDENTICAL" };
  }
  const [shorterText, longerText] = mainText.length <= shortText.length
    ? [mainText, shortText]
    : [shortText, mainText];
  if (longerText.includes(shorterText)) {
    return { ...richerOf(main, short), reason: "CONTAINED" };
  }
  if (tokenOverlapRatio(shorterText, longerText) >= REDUNDANT_TOKEN_RATIO) {
    return { ...richerOf(main, short), reason: "REDUNDANT" };
  }

  // Two substantial, genuinely different texts: keeping only one would lose
  // copy the shop wrote. WooCommerce renders the main body first, so does this.
  return {
    html: `${main.trim()}\n${short.trim()}`,
    source: "both",
    reason: "COMPLEMENTARY",
  };
}

module.exports = {
  decodeEntities,
  visibleText,
  comparableText,
  isEffectivelyEmpty,
  isTrivial,
  tokenOverlapRatio,
  resolveProductDescription,
};
