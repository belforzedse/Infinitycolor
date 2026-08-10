"use strict";

/**
 * Slug handling for the catalog importer.
 *
 * Canonical form is decoded Unicode. WooCommerce remains the source of truth,
 * but its percent-encoding is URL transport syntax rather than catalog data.
 * Empty source slugs remain empty: the importer never derives or invents one.
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
 * Decode percent-encoding so Persian slugs are persisted in canonical Unicode.
 * The prefix is retained for call-site compatibility but is intentionally unused.
 *
 * @param {{ slug?: string, name?: string, id?: number|string }} entity
 * @param {string} prefix e.g. "product" or "category"
 * @returns {string}
 */
function resolveSlug(entity, prefix) {
  void prefix;
  return entity?.slug === null || entity?.slug === undefined ? "" : safeDecode(String(entity.slug));
}

module.exports = { resolveSlug, safeDecode };
