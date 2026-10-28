"use strict";

const PRODUCT_PATH_PREFIX = "/product/";
const WP_HOSTS = new Set(["infinitycolor.co", "www.infinitycolor.co"]);

/**
 * Decode a small set of HTML entities used in WP titles / CTA labels.
 * @param {string|null|undefined} text
 * @returns {string}
 */
function decodeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .trim();
}

/**
 * URL-decode without throwing.
 * @param {string|null|undefined} value
 * @returns {string}
 */
function safeDecode(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/**
 * Extract a JSON array starting at `startIndex` (must point at `[`).
 * @param {string} source
 * @param {number} startIndex
 * @returns {unknown}
 */
function parseJsonArrayAt(source, startIndex) {
  if (source[startIndex] !== "[") {
    throw new Error("Expected JSON array");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(source.slice(startIndex, i + 1));
      }
    }
  }

  throw new Error("Unterminated JSON array in homepage HTML");
}

/**
 * Parse WP Story Premium's `var wps… = […]` payload from homepage HTML.
 * @param {string} html
 * @returns {object[]}
 */
function parseHomepageStories(html) {
  if (typeof html !== "string" || !html) {
    throw new Error("Homepage HTML is empty");
  }

  const marker = /var\s+wps[a-f0-9]+\s*=/i;
  let searchFrom = 0;
  while (searchFrom < html.length) {
    const match = marker.exec(html.slice(searchFrom));
    if (!match) break;
    const abs = searchFrom + match.index + match[0].length;
    const start = html.indexOf("[", abs);
    if (start === -1) break;
    const parsed = parseJsonArrayAt(html, start);
    if (Array.isArray(parsed) && parsed.some((item) => item && Array.isArray(item.items))) {
      return parsed;
    }
    searchFrom = start + 1;
    marker.lastIndex = 0;
  }

  throw new Error("No WP Story Premium rail JSON found in homepage HTML");
}

/**
 * @param {object} circle
 * @param {object} item
 * @returns {number|null}
 */
function resolveWpStoryId(circle, item) {
  const boxId = Number(item?.box);
  if (Number.isFinite(boxId) && boxId > 0) return boxId;

  const itemId = String(item?.id || "");
  const itemMatch = itemId.match(/^story-(\d+)-\d+$/);
  if (itemMatch) return Number(itemMatch[1]);

  const circleId = String(circle?.id || "");
  const circleMatch = circleId.match(/^story-\d+-(\d+)$/);
  if (circleMatch) return Number(circleMatch[1]);

  return null;
}

/**
 * @param {unknown} type
 * @param {string} src
 * @returns {"image"|"video"|null}
 */
function resolveMediaType(type, src) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "video") return "video";
  if (normalized === "image" || normalized === "photo" || normalized === "picture") return "image";

  const url = String(src || "").toLowerCase();
  if (/\.(m3u8|mov|mp4|m4v|ogg|ogv|webm)(?:[?#].*)?$/i.test(url)) return "video";
  if (/\.(avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(url)) return "image";
  return null;
}

/**
 * WP `length` is seconds (string or number). Strapi stores milliseconds, min 1000.
 * @param {unknown} length
 * @returns {number}
 */
function durationMsFromLength(length) {
  const seconds = Number.parseFloat(String(length ?? ""));
  if (!Number.isFinite(seconds) || seconds <= 0) return 5000;
  return Math.max(1000, Math.round(seconds * 1000));
}

/**
 * Rewrite WordPress product permalinks to the storefront PDP path.
 * @param {string|null|undefined} link
 * @returns {string|undefined}
 */
function rewriteCtaUrl(link) {
  const raw = String(link || "").trim();
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, "");
    if (!WP_HOSTS.has(host) && host !== "infinitycolor.co") {
      return raw.length > 500 ? raw.slice(0, 500) : raw;
    }
    const path = url.pathname || "";
    if (!path.toLowerCase().startsWith(PRODUCT_PATH_PREFIX)) {
      return raw.length > 500 ? raw.slice(0, 500) : raw;
    }
    const rest = path.slice(PRODUCT_PATH_PREFIX.length).replace(/\/+$/, "");
    const slug = safeDecode(rest.split("/").filter(Boolean)[0] || "");
    if (!slug) return raw;
    const rewritten = `/pdp/${slug}`;
    return rewritten.length > 500 ? rewritten.slice(0, 500) : rewritten;
  } catch {
    if (raw.startsWith("/product/")) {
      const slug = safeDecode(raw.slice(PRODUCT_PATH_PREFIX.length).replace(/\/+$/, "").split("/")[0] || "");
      if (slug) return `/pdp/${slug}`.slice(0, 500);
    }
    return raw.slice(0, 500);
  }
}

function truncate(value, max) {
  const text = decodeHtml(value);
  if (!text) return "";
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Flatten WP Story Premium circles into one Strapi-bound slide per item.
 * SortOrder is the homepage rail index of the circle (0 = first), plus item index
 * so a second slide on the same circle sorts immediately after.
 * @param {object[]} circles
 * @returns {object[]}
 */
function flattenWpStories(circles) {
  if (!Array.isArray(circles)) return [];

  const slides = [];
  let sortOrder = 0;

  for (const circle of circles) {
    const items = Array.isArray(circle?.items) ? circle.items : [];
    if (items.length === 0) continue;

    const name = decodeHtml(circle?.name || "");
    const thumbnailUrl = String(circle?.photo || "").trim() || undefined;

    items.forEach((item, itemIndex) => {
      const src = String(item?.src || "").trim();
      const mediaType = resolveMediaType(item?.type, src);
      const wpStoryId = resolveWpStoryId(circle, item);
      if (!src || !mediaType || !wpStoryId) return;

      const index = Number.isFinite(Number(item?.index)) ? Number(item.index) : itemIndex;
      const titleSuffix = items.length > 1 && itemIndex > 0 ? ` (${itemIndex + 1})` : "";
      const title = truncate(`${name}${titleSuffix}`, 100) || `Story ${wpStoryId}`;
      const ctaLabel = truncate(item?.linkText || "", 60) || undefined;
      const ctaUrl = rewriteCtaUrl(item?.link);

      slides.push({
        wpStoryId,
        itemIndex: index,
        slug: `wp-${wpStoryId}-${index}`,
        title,
        mediaType,
        mediaUrl: src,
        thumbnailUrl,
        durationMs: durationMsFromLength(item?.length),
        ctaLabel,
        ctaUrl,
        sortOrder,
      });
      sortOrder += 1;
    });
  }

  return slides;
}

/**
 * Convert each WP rail circle into one canonical story with ordered items.
 * Existing flattened Strapi rows are deliberately not consulted here; the importer
 * handles those conflicts before writing the grouped story.
 * @param {object[]} circles
 * @returns {object[]}
 */
function groupWpStories(circles) {
  if (!Array.isArray(circles)) return [];

  const groups = [];
  for (const circle of circles) {
    const sourceItems = Array.isArray(circle?.items) ? circle.items : [];
    const validItems = sourceItems.flatMap((item, itemIndex) => {
      const mediaUrl = String(item?.src || "").trim();
      const mediaType = resolveMediaType(item?.type, mediaUrl);
      const sourceId = resolveWpStoryId(circle, item);
      if (!mediaUrl || !mediaType || !sourceId) return [];
      const index = Number.isFinite(Number(item?.index)) ? Number(item.index) : itemIndex;
      return [{
        sourceId,
        itemIndex: index,
        key: `wp:${sourceId}:${index}`,
        mediaType,
        mediaUrl,
        durationMs: durationMsFromLength(item?.length),
        ctaLabel: truncate(item?.linkText || "", 60) || undefined,
        ctaUrl: rewriteCtaUrl(item?.link),
      }];
    });
    if (validItems.length === 0) continue;

    const wpStoryId = validItems[0].sourceId;
    groups.push({
      wpStoryId,
      slug: `wp-group-${wpStoryId}`,
      title: truncate(circle?.name || "", 100) || `Story ${wpStoryId}`,
      thumbnailUrl: String(circle?.photo || "").trim() || undefined,
      sortOrder: groups.length,
      items: validItems.map(({ sourceId: _sourceId, ...item }) => item),
    });
  }
  return groups;
}

/**
 * Import last-first so newest-first storefront sort matches the WP rail.
 * @param {object[]} slides
 * @returns {object[]}
 */
function reverseForNewestFirst(slides) {
  return [...slides].reverse();
}

module.exports = {
  decodeHtml,
  safeDecode,
  parseHomepageStories,
  parseJsonArrayAt,
  resolveWpStoryId,
  resolveMediaType,
  durationMsFromLength,
  rewriteCtaUrl,
  flattenWpStories,
  groupWpStories,
  reverseForNewestFirst,
};
