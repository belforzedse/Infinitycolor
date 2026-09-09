"use strict";

const crypto = require("node:crypto");
const sanitizeHtml = require("sanitize-html");
const { resolveSlug, safeDecode } = require("./slug");

const IMPORT_SOURCE = "woocommerce-category-description";
const TITLE_LIMIT = 180;
const PARAGRAPH_LIMIT = 4_000;
const CONTENT_LIMIT = 120_000;

const BODY_TAGS = [
  "p", "br", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "code", "strong",
  "b", "em", "i", "u", "s", "a", "img", "figure", "figcaption", "table", "thead",
  "tbody", "tfoot", "tr", "th", "td", "hr", "span",
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function plainText(value) {
  return sanitizeHtml(typeof value === "string" ? value : "", {
    allowedTags: [],
    allowedAttributes: {},
  }).replace(/\s+/g, " ").trim();
}

function boundedPlainText(value, limit, code) {
  const normalized = plainText(value);
  if (normalized.length > limit) throw new Error(code);
  return normalized;
}

function normalizeSlugKey(value) {
  return safeDecode(String(value || ""))
    .normalize("NFC")
    .replace(/^\/+|\/+$/g, "")
    .toLocaleLowerCase("fa-IR");
}

function relationValue(value) {
  return value?.data?.attributes
    ? { id: value.data.id, ...value.data.attributes }
    : value?.data ?? value;
}

function destinationCategoryIndex(snapshotRows) {
  const index = new Map();
  for (const row of Array.isArray(snapshotRows) ? snapshotRows : []) {
    if (row?.externalSource === "woocommerce" && row?.externalId !== null && row?.externalId !== undefined) {
      index.set(String(row.externalId), row);
    }
  }
  return index;
}

function categoryRouteMap(sourceCategories, destinationIndex) {
  const routes = new Map();
  for (const source of sourceCategories) {
    const destination = destinationIndex.get(String(source.id));
    if (!destination) continue;
    const key = normalizeSlugKey(source.slug);
    if (!key) continue;
    routes.set(key, `/plp/category/${encodeURIComponent(String(destination.slug || resolveSlug(source, "category")))}`);
  }
  return routes;
}

function oldCategoryLinkSlug(rawHref) {
  if (typeof rawHref !== "string" || !rawHref.trim()) return null;
  const href = rawHref.trim();
  let parsed;
  try {
    parsed = new URL(href, "https://infinitycolor.co");
  } catch {
    return null;
  }
  const absolute = /^https?:\/\//i.test(href);
  if (absolute && !["infinitycolor.co", "www.infinitycolor.co"].includes(parsed.hostname.toLowerCase())) {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0].toLowerCase() !== "shop") return null;
  return normalizeSlugKey(segments[1]);
}

function sourceHasDescription(category) {
  const raw = typeof category?.description === "string" ? category.description : "";
  const withoutAudio = raw
    .replace(/\[audio\b[^\]]*\](?:\s*\[\/audio\])?/gi, " ")
    .replace(/\[playlist\b[^\]]*\](?:\s*\[\/playlist\])?/gi, " ");
  return Boolean(plainText(withoutAudio.replace(/&nbsp;/gi, " ")));
}

function extractLeadingTitle(description, fallbackTitle) {
  const leading = description.match(/^\s*<(h1|h2)\b[^>]*>([\s\S]*?)<\/\1>\s*/i);
  if (leading) {
    const extracted = boundedPlainText(
      leading[2],
      TITLE_LIMIT,
      "CATEGORY_EDITORIAL_TITLE_TOO_LONG",
    );
    return {
      title: extracted || boundedPlainText(
        fallbackTitle,
        TITLE_LIMIT,
        "CATEGORY_EDITORIAL_TITLE_TOO_LONG",
      ),
      remainder: description.slice(leading[0].length),
      extracted: Boolean(extracted),
    };
  }

  // Several live category descriptions predate the editor and store their SEO
  // heading as the first plain-text line instead of an H1/H2. Only recognize
  // an explicit Persian purchase heading; generic opening sentences (for
  // example "Welcome to Infinity") remain body copy rather than becoming the
  // public title.
  const plainHeading = description.match(/^\s*(خرید[^\r\n<]{0,174})\s*(?:\r?\n|$)/i);
  if (plainHeading) {
    const extracted = boundedPlainText(
      plainHeading[1],
      TITLE_LIMIT,
      "CATEGORY_EDITORIAL_TITLE_TOO_LONG",
    );
    return {
      title: extracted,
      remainder: description.slice(plainHeading[0].length),
      extracted: true,
    };
  }

  return {
    title: boundedPlainText(fallbackTitle, TITLE_LIMIT, "CATEGORY_EDITORIAL_TITLE_TOO_LONG"),
    remainder: description,
    extracted: false,
  };
}

function extractAudio(remainder) {
  const matches = [...remainder.matchAll(/\[audio\b([^\]]*)\](?:\s*\[\/audio\])?/gi)];
  if (/\[playlist\b/i.test(remainder)) throw new Error("CATEGORY_EDITORIAL_PLAYLIST_UNSUPPORTED");
  if (matches.length > 1) throw new Error("CATEGORY_EDITORIAL_MULTIPLE_AUDIO_UNSUPPORTED");
  if (matches.length === 0) {
    if (/\[\/?audio\b/i.test(remainder)) throw new Error("CATEGORY_EDITORIAL_AUDIO_SHORTCODE_INVALID");
    return { audioUrl: null, before: "", after: remainder };
  }
  const attributes = matches[0][1];
  const mp3 = attributes.match(/(?:^|\s)mp3\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s\]]+))/i);
  if (!mp3 || !String(mp3[1] || mp3[2] || mp3[3] || "").trim()) {
    throw new Error("CATEGORY_EDITORIAL_AUDIO_URL_MISSING");
  }
  const start = matches[0].index;
  const end = start + matches[0][0].length;
  const after = remainder.slice(end);
  if (/\[\/?audio\b/i.test(after)) throw new Error("CATEGORY_EDITORIAL_AUDIO_SHORTCODE_INVALID");
  return {
    audioUrl: String(mp3[1] || mp3[2] || mp3[3]).trim(),
    before: remainder.slice(0, start),
    after,
  };
}

function sanitizeBody(html, routes) {
  if (html.length > CONTENT_LIMIT) throw new Error("CATEGORY_EDITORIAL_CONTENT_TOO_LONG");
  let rewrittenLinkCount = 0;
  const unresolvedLinks = [];
  const sanitized = sanitizeHtml(html, {
    allowedTags: BODY_TAGS,
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading"],
      th: ["colspan", "rowspan", "scope"],
      td: ["colspan", "rowspan"],
      code: ["class"],
    },
    allowedClasses: { code: [/^language-[a-z0-9-]+$/] },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    transformTags: {
      h1: "h3",
      h2: "h3",
      h5: "h4",
      h6: "h4",
      a: (_tagName, attribs) => {
        const next = { ...attribs };
        const oldSlug = oldCategoryLinkSlug(next.href);
        if (oldSlug) {
          const replacement = routes.get(oldSlug);
          if (!replacement) unresolvedLinks.push(next.href);
          else {
            next.href = replacement;
            rewrittenLinkCount += 1;
          }
        }
        if (next.target === "_blank") next.rel = "noopener noreferrer";
        return { tagName: "a", attribs: next };
      },
      img: (_tagName, attribs) => ({
        tagName: "img",
        attribs: { ...attribs, loading: "lazy" },
      }),
    },
    exclusiveFilter: (frame) =>
      frame.tag === "img" && !(typeof frame.attribs.alt === "string" && frame.attribs.alt.trim()),
  }).trim();
  if (unresolvedLinks.length > 0) {
    throw new Error(`CATEGORY_EDITORIAL_UNRESOLVED_CATEGORY_LINK:${unresolvedLinks.join(",")}`);
  }
  if (/<img\b[^>]+(?:src=["'][^"']*\/wp-content\/uploads\/)/i.test(sanitized)) {
    throw new Error("CATEGORY_EDITORIAL_WORDPRESS_IMAGE_HOTLINK");
  }
  if (/href=["'][^"']*(?:infinitycolor\.co)?\/shop\//i.test(sanitized)) {
    throw new Error("CATEGORY_EDITORIAL_UNRESOLVED_CATEGORY_LINK");
  }
  if (/\[\/?audio\b/i.test(sanitized)) {
    throw new Error("CATEGORY_EDITORIAL_AUDIO_SHORTCODE_REMAINS");
  }
  return { content: sanitized, rewrittenLinkCount };
}

function transformCategoryEditorial(category, destination, routes) {
  if (!sourceHasDescription(category)) return null;
  if (!destination) throw new Error("CATEGORY_EDITORIAL_DESTINATION_CATEGORY_MISSING");
  const raw = String(category.description || "");
  const leading = extractLeadingTitle(raw, destination.title || category.name);
  if (!leading.title) throw new Error("CATEGORY_EDITORIAL_TITLE_REQUIRED");
  const audio = extractAudio(leading.remainder);
  const paragraph = audio.audioUrl
    ? boundedPlainText(
        audio.before,
        PARAGRAPH_LIMIT,
        "CATEGORY_EDITORIAL_PARAGRAPH_TOO_LONG",
      )
    : "";
  const body = sanitizeBody(audio.after, routes);
  return {
    sourceId: String(category.id),
    sourceSlug: String(category.slug || ""),
    sourceDescriptionHash: sha256(raw),
    destinationCategoryId: Number(destination.id),
    destinationSlug: String(destination.slug || ""),
    title: leading.title,
    paragraph,
    content: body.content,
    isRtl: true,
    audioUrl: audio.audioUrl,
    rewrittenLinkCount: body.rewrittenLinkCount,
    titleOnly: !paragraph && !plainText(body.content.replace(/&nbsp;/gi, " ")),
  };
}

function categoryEditorialSourceHash(plan, audioHash = null) {
  return sha256(Buffer.from(JSON.stringify([
    String(plan.sourceId),
    String(plan.destinationSlug),
    String(plan.title),
    String(plan.paragraph),
    String(plan.content),
    audioHash || null,
  ]), "utf8"));
}

function buildCategoryEditorialManifest(sourceCategories, resolvedPlans) {
  const entries = resolvedPlans
    .map((plan) => ({
      sourceId: String(plan.sourceId),
      sourceSlug: plan.sourceSlug,
      sourceDescriptionHash: plan.sourceDescriptionHash,
      destinationCategoryId: plan.destinationCategoryId,
      destinationSlug: plan.destinationSlug,
      transformedContentHash: plan.sourceHash,
      rewrittenLinkCount: plan.rewrittenLinkCount,
      audioHash: plan.audioInspection?.sha256 ?? plan.audio?.sha256 ?? null,
      audioBytes: plan.audioInspection?.bytes ?? plan.audio?.bytes ?? null,
      titleOnly: plan.titleOnly,
    }))
    .sort((left, right) => Number(left.sourceId) - Number(right.sourceId));
  const manifestHash = sha256(Buffer.from(JSON.stringify(entries), "utf8"));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    importSource: IMPORT_SOURCE,
    sourceEndpoint: "/products/categories",
    sourceCategoryCount: sourceCategories.length,
    nonEmptyCategoryCount: entries.length,
    audioCount: entries.filter((entry) => entry.audioHash).length,
    rewrittenLinkCount: entries.reduce((total, entry) => total + entry.rewrittenLinkCount, 0),
    manifestHash,
    batchId: `category-seo-${manifestHash.slice(0, 32)}`,
    entries,
  };
}

module.exports = {
  IMPORT_SOURCE,
  BODY_TAGS,
  sourceHasDescription,
  destinationCategoryIndex,
  categoryRouteMap,
  oldCategoryLinkSlug,
  extractLeadingTitle,
  extractAudio,
  sanitizeBody,
  transformCategoryEditorial,
  categoryEditorialSourceHash,
  buildCategoryEditorialManifest,
};
