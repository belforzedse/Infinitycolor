"use strict";

/**
 * Slug handling for the catalog importer.
 *
 * Design decision: the WooCommerce slug is the source of truth and is imported
 * **verbatim**, including percent-encoding and whitespace. WooCommerce slugs are
 * already URL-safe, stable across runs, and preserve existing SEO URLs. Empty
 * source slugs remain empty: the importer must never decode, normalize, derive,
 * suffix, or otherwise generate product slugs.
 */

/**
 * URL-decode a value without throwing. WooCommerce percent-encodes Persian slugs
 * (e.g. "%da%a9%db%8c%d9%81" → "کیف").
 * @param {string|undefined|null} value
 * @returns {string}
 */
function safeDecode(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const str = value.toString();
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/**
 * Resolve the Strapi slug for a WooCommerce entity.
 * WooCommerce is the only source of truth. The prefix is retained in the public
 * signature for compatibility but is intentionally unused.
 *
 * @param {{ slug?: string, name?: string, id?: number|string }} entity
 * @param {string} prefix e.g. "product" or "category"
 * @returns {string}
 */
function resolveSlug(entity, prefix) {
  void prefix;
  return entity?.slug === null || entity?.slug === undefined
    ? ""
    : String(entity.slug);
}

module.exports = { resolveSlug, safeDecode };
