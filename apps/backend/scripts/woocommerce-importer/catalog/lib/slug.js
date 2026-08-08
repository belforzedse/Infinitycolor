"use strict";

/**
 * Slug handling for the catalog importer.
 *
 * Canonical form is the **decoded** Unicode slug (Persian characters, not
 * percent-encoding). WooCommerce sometimes ships percent-encoded slugs in its
 * API; storing those verbatim made ~half the catalog unreachable from every
 * URL form because the storefront / Koa decode path segments before lookup.
 *
 * Empty source slugs remain empty: the importer must never derive, suffix, or
 * otherwise invent a product slug.
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
 *
 * Decodes percent-encoding so the stored canonical form matches the human URL.
 * The prefix argument is retained for call-site compatibility but unused.
 *
 * @param {{ slug?: string, name?: string, id?: number|string }} entity
 * @param {string} prefix e.g. "product" or "category"
 * @returns {string}
 */
function resolveSlug(entity, prefix) {
  void prefix;
  if (entity?.slug === null || entity?.slug === undefined) {
    return "";
  }
  return safeDecode(String(entity.slug));
}

module.exports = { resolveSlug, safeDecode };
