"use strict";

/**
 * Turn a WordPress-rendered blog body into Infinity's blog contract.
 *
 * WordPress articles embed two things that are not HTML: a product carousel
 * (`[cyn_product_cat_temp]`) and the shop's promotional section
 * (`[cyn_blog_temp pic=N]`). The theme expands both into markup whose layout
 * lives entirely in theme CSS, so storing that markup verbatim — which is what
 * the importer did — produces a wall of unstyled fragments on Infinity and, for
 * the carousel, nothing at all (it never expands in `context=edit`).
 *
 * This module recognises the expanded blocks and replaces them with the markers
 * the storefront renderer and the admin editor already share:
 *
 *   [products:"slug",…]         → BlogProductCarousel
 *   [promo:{…}]                 → BlogPromoSection
 *
 * Everything here is pure: the media upload is injected by the caller so a dry
 * run can report what it would upload without uploading anything.
 */

const CAROUSEL_MARKERS = /\[cyn_product_cat_temp[^\]]*\]/gi;
const PROMO_MARKERS = /\[cyn_blog_temp[^\]]*\]/gi;
const PROMO_VARIANT = /blog-temp-pic(\d+)\.png/i;

/* ------------------------------------------------------------------ *
 * A small, forgiving HTML scanner
 * ------------------------------------------------------------------ */

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Read one tag starting at `<`. Quoted attribute values may contain `>`, so the
 * scan tracks quoting rather than looking for the next `>`.
 * @returns {{ end:number, name:string, closing:boolean, selfClosing:boolean, attribs:Record<string,string> }|null}
 */
function readTag(html, start) {
  if (html[start] !== "<") return null;
  if (html.startsWith("<!--", start)) {
    const end = html.indexOf("-->", start);
    return { end: end === -1 ? html.length : end + 3, name: "#comment", closing: false, selfClosing: true, attribs: {} };
  }
  const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(start, start + 64));
  if (!nameMatch) return null;
  let index = start + nameMatch[0].length;
  let quote = null;
  while (index < html.length) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      index += 1;
      break;
    }
    index += 1;
  }
  const raw = html.slice(start, index);
  const attribs = {};
  const attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let attribute;
  // Skip the tag name before reading attributes.
  attributePattern.lastIndex = nameMatch[0].length;
  while ((attribute = attributePattern.exec(raw)) !== null) {
    attribs[attribute[1].toLowerCase()] = attribute[3] ?? attribute[4] ?? attribute[5] ?? "";
  }
  return {
    end: index,
    name: nameMatch[1].toLowerCase(),
    closing: nameMatch[0][1] === "/",
    selfClosing: /\/>$/.test(raw) || VOID_ELEMENTS.has(nameMatch[1].toLowerCase()),
    attribs,
  };
}

/**
 * Every element the predicate accepts, with its exact bounds in `html`.
 * Nested matches of an already-matched element are not returned twice.
 *
 * @param {string} html
 * @param {(tag: { name:string, attribs:Record<string,string> }) => boolean} matches
 * @returns {Array<{ start:number, end:number, outerHtml:string, innerHtml:string, attribs:Record<string,string>, name:string }>}
 */
function extractBalancedElements(html, matches) {
  const found = [];
  if (typeof html !== "string" || !html) return found;
  let index = 0;
  while (index < html.length) {
    const char = html.indexOf("<", index);
    if (char === -1) break;
    const tag = readTag(html, char);
    if (!tag) {
      index = char + 1;
      continue;
    }
    if (tag.closing || tag.selfClosing || tag.name === "#comment" || !matches(tag)) {
      index = tag.end;
      continue;
    }
    // Walk forward counting same-name tags until this one closes.
    let depth = 1;
    let cursor = tag.end;
    let end = -1;
    while (cursor < html.length && depth > 0) {
      const next = html.indexOf("<", cursor);
      if (next === -1) break;
      const nextTag = readTag(html, next);
      if (!nextTag) {
        cursor = next + 1;
        continue;
      }
      if (nextTag.name === tag.name && !nextTag.selfClosing) {
        if (nextTag.closing) {
          depth -= 1;
          if (depth === 0) end = nextTag.end;
        } else {
          depth += 1;
        }
      }
      cursor = nextTag.end;
    }
    if (end === -1) {
      index = tag.end;
      continue;
    }
    found.push({
      name: tag.name,
      start: char,
      end,
      outerHtml: html.slice(char, end),
      innerHtml: html.slice(tag.end, html.lastIndexOf("<", end - 1)),
      attribs: tag.attribs,
    });
    index = end;
  }
  return found;
}

function hasClass(attribs, className) {
  return String(attribs?.class || "").split(/\s+/).includes(className);
}

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&zwnj;/gi, "‌")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, "&");
}

function textOf(html) {
  return decodeEntities(String(html || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ *
 * Product carousels
 * ------------------------------------------------------------------ */

/** Ordered, de-duplicated product slugs from a rendered carousel. */
function carouselSlugs(outerHtml) {
  const slugs = [];
  const seen = new Set();
  const anchor = /href\s*=\s*["']([^"']*\/product\/[^"']+)["']/gi;
  let match;
  while ((match = anchor.exec(outerHtml)) !== null) {
    const path = decodeEntities(match[1]).split(/[?#]/)[0];
    const segment = /\/product\/([^/]+)\/?$/.exec(path);
    if (!segment) continue;
    let slug;
    try {
      slug = decodeURIComponent(segment[1]);
    } catch {
      slug = segment[1];
    }
    slug = slug.normalize("NFC").trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

/** Same quoting grammar the admin editor's shortcode builder uses. */
function productsMarker(identifiers) {
  const parts = identifiers.map((identifier) => (
    /^\d+$/.test(identifier) ? identifier : `"${identifier.replace(/"/g, '\\"')}"`
  ));
  return `[products:${parts.join(",")}]`;
}

function carouselsFrom(html) {
  return extractBalancedElements(html, (tag) => (
    tag.attribs.id === "the-content-products-swiper" || hasClass(tag.attribs, "products-swiper")
  )).map((element) => ({ ...element, slugs: carouselSlugs(element.outerHtml) }));
}

/* ------------------------------------------------------------------ *
 * Promotional sections
 * ------------------------------------------------------------------ */

/**
 * The illustration, not the Instagram glyph. The theme renders the social icon
 * first, so "the first `<img>`" is the wrong one; the named `blog-temp-pic{N}`
 * asset wins, and anything that is plainly the icon is excluded.
 */
function promoIllustration(outerHtml) {
  const images = [];
  const pattern = /<img\b[^>]*>/gi;
  let tag;
  while ((tag = pattern.exec(outerHtml)) !== null) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag[0]);
    if (!src) continue;
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag[0]);
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(tag[0]);
    images.push({
      src: decodeEntities(src[1]),
      alt: alt ? decodeEntities(alt[1]) : "",
      id: id ? id[1] : "",
    });
  }
  const candidates = images.filter((image) => (
    !/insta/i.test(image.id) && !/\binsta[-_.]?/i.test(image.src.split("/").pop() || "")
  ));
  return candidates.find((image) => PROMO_VARIANT.test(image.src)) || candidates[0] || null;
}

function firstMatch(html, pattern) {
  const match = pattern.exec(html);
  pattern.lastIndex = 0;
  return match;
}

/**
 * The fields of one rendered `<section class="blog-middle-section">`. The theme
 * renders a fixed structure: a highlighted title paragraph, a subtitle, a
 * primary call to action, an Instagram link and an illustration.
 */
function promoFieldsFrom(outerHtml) {
  const paragraphs = extractBalancedElements(outerHtml, (tag) => tag.name === "p");
  const titleElement = paragraphs.find((element) => hasClass(element.attribs, "text-primary-700"));
  const title = titleElement ? textOf(titleElement.innerHtml) : "";
  const body = titleElement
    ? textOf((paragraphs.find((element) => element.start > titleElement.start) || {}).innerHtml || "")
    : textOf((paragraphs[0] || {}).innerHtml || "");

  const anchors = extractBalancedElements(outerHtml, (tag) => tag.name === "a");
  const ctaElement = anchors.find((element) => hasClass(element.attribs, "btn-primary"));
  const socialElement = anchors.find((element) => /instagram\.com/i.test(element.attribs.href || ""));
  const image = promoIllustration(outerHtml);
  const variant = image ? PROMO_VARIANT.exec(image.src) : null;

  return {
    title,
    body,
    cta: ctaElement
      ? { label: textOf(ctaElement.innerHtml), href: decodeEntities(ctaElement.attribs.href || "") }
      : null,
    social: socialElement
      ? { label: textOf(socialElement.innerHtml), href: decodeEntities(socialElement.attribs.href || "") }
      : null,
    imageUrl: image ? image.src : null,
    imageAlt: image ? image.alt : "",
    variant: variant ? `pic${variant[1]}` : null,
  };
}

function promoSectionsFrom(html) {
  return extractBalancedElements(html, (tag) => (
    tag.name === "section" && hasClass(tag.attribs, "blog-middle-section")
  )).map((element) => ({ ...element, fields: promoFieldsFrom(element.outerHtml) }));
}

/**
 * The theme emits a `<style>` block just above the section that only defines
 * the frame-image variables. It is dead weight on Infinity (DOMPurify drops it
 * anyway) and is removed with the section it belongs to.
 */
function promoStyleStart(html, sectionStart) {
  const before = html.slice(0, sectionStart);
  const styleStart = before.lastIndexOf("<style");
  if (styleStart === -1) return sectionStart;
  const styleEnd = html.indexOf("</style>", styleStart);
  if (styleEnd === -1 || styleEnd > sectionStart) return sectionStart;
  const between = html.slice(styleEnd + "</style>".length, sectionStart);
  if (between.trim() !== "") return sectionStart;
  if (!/--bg-frame/.test(html.slice(styleStart, styleEnd))) return sectionStart;
  return styleStart;
}

const MAX_PROMO_TEXT = 400;
const MAX_PROMO_LABEL = 120;

function bounded(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function safeExternalHref(href) {
  const value = bounded(href, 2048);
  return /^https?:\/\//i.test(value) ? value : null;
}

/**
 * `https://infinitycolor.co/shop/<slug>/` → `/plp/category/<destination slug>`
 * when the category is known, otherwise the original absolute link so the
 * reader still reaches something.
 */
function rewriteShopHref(href, resolveCategoryRoute) {
  const value = safeExternalHref(href);
  if (!value) return { href: null, diagnostic: "PROMO_CTA_HREF_UNSAFE" };
  const match = /\/shop\/([^/?#]+)\/?/.exec(value);
  if (!match) return { href: value, diagnostic: null };
  let sourceSlug;
  try {
    sourceSlug = decodeURIComponent(match[1]);
  } catch {
    sourceSlug = match[1];
  }
  const route = resolveCategoryRoute ? resolveCategoryRoute(sourceSlug) : null;
  return route
    ? { href: route, diagnostic: null }
    : { href: value, diagnostic: "PROMO_CTA_CATEGORY_UNRESOLVED" };
}

function promoMarker(promo) {
  return `[promo:${JSON.stringify(promo)}]`;
}

/* ------------------------------------------------------------------ *
 * Whole-body transform
 * ------------------------------------------------------------------ */

function countMarkers(raw, pattern) {
  const matches = String(raw || "").match(pattern);
  return matches ? matches.length : 0;
}

/**
 * @param {{ raw?: string, renderedEdit?: string, renderedView?: string }} bodies
 * @param {object} [options]
 * @param {(sourceSlug: string) => string|null} [options.resolveCategoryRoute]
 * @param {(url: string, alt: string) => Promise<{ url: string, id?: number }|null>} [options.uploadImage]
 *   Omitted in a dry run: the promo block is still recognised and counted, but
 *   the post is reported unresolved rather than given a WordPress hotlink.
 * @returns {Promise<{ content: string, diagnostics: string[], carousels: number,
 *   promos: number, productSlugs: string[], pendingImages: string[] }>}
 */
async function transformBlogContent(bodies, options = {}) {
  const raw = String(bodies?.raw || "");
  const source = String(bodies?.renderedView || bodies?.renderedEdit || "");
  const usedView = Boolean(bodies?.renderedView);
  const diagnostics = [];
  const productSlugs = [];
  const pendingImages = [];

  const carousels = carouselsFrom(source);
  const promos = promoSectionsFrom(source);

  // Replacements are spliced by index, newest last, so one marker's text can
  // never be re-matched as part of another.
  const replacements = [];

  for (const carousel of carousels) {
    if (carousel.slugs.length === 0) {
      diagnostics.push("CAROUSEL_NO_PRODUCTS");
      continue;
    }
    for (const slug of carousel.slugs) {
      if (!productSlugs.includes(slug)) productSlugs.push(slug);
    }
    replacements.push({
      start: carousel.start,
      end: carousel.end,
      text: productsMarker(carousel.slugs),
    });
  }

  for (const promo of promos) {
    const fields = promo.fields;
    if (!fields.title && !fields.body) {
      diagnostics.push("PROMO_FIELDS_EMPTY");
      continue;
    }
    const cta = fields.cta ? rewriteShopHref(fields.cta.href, options.resolveCategoryRoute) : null;
    if (cta?.diagnostic) diagnostics.push(cta.diagnostic);
    const socialHref = fields.social ? safeExternalHref(fields.social.href) : null;

    let image = null;
    if (fields.imageUrl) {
      if (typeof options.uploadImage === "function") {
        const uploaded = await options.uploadImage(fields.imageUrl, fields.imageAlt);
        if (uploaded?.url) image = { url: uploaded.url, alt: bounded(fields.imageAlt, MAX_PROMO_LABEL) };
        else diagnostics.push("PROMO_IMAGE_UPLOAD_FAILED");
      } else {
        // Never emit a marker pointing at WordPress: the block renders without
        // its illustration and the caller reports what it would have uploaded.
        pendingImages.push(fields.imageUrl);
        diagnostics.push("PROMO_IMAGE_PENDING");
      }
    }

    replacements.push({
      start: promoStyleStart(source, promo.start),
      end: promo.end,
      text: promoMarker({
        v: 1,
        title: bounded(fields.title, MAX_PROMO_LABEL),
        body: bounded(fields.body, MAX_PROMO_TEXT),
        cta: cta?.href && fields.cta?.label
          ? { label: bounded(fields.cta.label, MAX_PROMO_LABEL), href: cta.href }
          : null,
        social: socialHref && fields.social?.label
          ? { label: bounded(fields.social.label, MAX_PROMO_LABEL), href: socialHref }
          : null,
        image,
        variant: fields.variant,
      }),
    });
  }

  replacements.sort((left, right) => right.start - left.start);
  let content = source;
  for (const replacement of replacements) {
    // A marker is its own line between blocks, never inside a paragraph: the
    // renderer splits the HTML here and a split paragraph would leave the block
    // inside broken flow.
    content = `${content.slice(0, replacement.start)}\n${replacement.text}\n${content.slice(replacement.end)}`;
  }

  // What the source says should be there, against what was actually found.
  const rawCarousels = countMarkers(raw, CAROUSEL_MARKERS);
  const rawPromos = countMarkers(raw, PROMO_MARKERS);
  if (rawCarousels > carousels.length) {
    diagnostics.push(usedView ? "CAROUSEL_BLOCK_NOT_FOUND" : "CAROUSEL_SOURCE_NOT_EXPANDED");
  }
  if (rawPromos > promos.length) diagnostics.push("PROMO_SOURCE_NOT_EXPANDED");

  return {
    content,
    diagnostics,
    carousels: replacements.length - promos.filter((promo) => promo.fields.title || promo.fields.body).length,
    promos: promos.filter((promo) => promo.fields.title || promo.fields.body).length,
    productSlugs,
    pendingImages,
  };
}

module.exports = {
  extractBalancedElements,
  carouselsFrom,
  carouselSlugs,
  productsMarker,
  promoSectionsFrom,
  promoFieldsFrom,
  rewriteShopHref,
  transformBlogContent,
  textOf,
};
