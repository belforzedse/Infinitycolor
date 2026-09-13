/**
 * Blocks embedded in blog content.
 *
 * Blog bodies are HTML with plain-text markers for the things that are not
 * HTML — a product carousel and the shop's promotional section. The markers are
 * the contract shared by the WordPress importer (which writes them), the admin
 * editor (which inserts them) and this renderer (which turns them back into
 * components):
 *
 *   [products:1,2,"slug-with-,comma"]
 *   [promo:{"v":1,"title":"…","cta":{…}}]
 *
 * Two details matter more than they look. Indices are computed on the original
 * string, because the renderer slices that string around each block — the
 * previous parser matched on an entity-decoded copy and back-mapped with a ±50
 * character search, so any post with a `&amp;` before its marker rendered
 * `[products:…]` as literal text. And the scan is bracket-aware inside quotes,
 * so a `]` inside a promo JSON string does not end the marker early.
 */

export type ProductsBlock = {
  type: "products";
  identifiers: string[];
  originalMatch: string;
  startIndex: number;
  endIndex: number;
};

export type PromoBlock = {
  type: "promo";
  data: PromoData;
  originalMatch: string;
  startIndex: number;
  endIndex: number;
};

export type BlogBlock = ProductsBlock | PromoBlock;

/** Legacy name kept for the admin editor's preview. */
export type ParsedShortcode = ProductsBlock;

export type PromoLink = { label: string; href: string };

export type PromoData = {
  title: string;
  body: string;
  cta: PromoLink | null;
  social: PromoLink | null;
  image: { url: string; alt: string } | null;
  variant: string | null;
};

const MAX_PROMO_TEXT = 400;
const MAX_PROMO_LABEL = 120;

/**
 * Decode only the entities an editor or WordPress introduces around a marker.
 * Applied to the matched substring, never to the document — the document's
 * offsets have to stay usable for slicing.
 */
function decodeMarkerEntities(text: string): string {
  return text
    .replace(/&#0*91;/g, "[")
    .replace(/&#0*93;/g, "]")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

/**
 * Find the index just past the `]` that closes a marker opened at `openIndex`.
 * Quoted sections are skipped so `]` inside a JSON string is ordinary text.
 * Returns -1 when the marker is never closed.
 */
function findMarkerEnd(html: string, openIndex: number): number {
  let quote: string | null = null;
  let escaped = false;
  for (let i = openIndex; i < html.length; i += 1) {
    const char = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // An entity-encoded quote opens a quoted section just as a bare one does.
    if (char === "&" && /^&(?:quot|apos|#0*39);/i.test(html.slice(i, i + 8))) {
      const entity = /^&(?:quot|apos|#0*39);/i.exec(html.slice(i, i + 8))!;
      const closing = html.indexOf(entity[0], i + entity[0].length);
      if (closing === -1) return -1;
      i = closing + entity[0].length - 1;
      continue;
    }
    if (char === "]") return i + 1;
    // WordPress and the editor both emit the brackets as entities sometimes.
    const encodedClose = /^&#0*93;/.exec(html.slice(i, i + 8));
    if (encodedClose) return i + encodedClose[0].length;
    if (char === "<") return -1; // a marker never spans an HTML tag
  }
  return -1;
}

/** Split a product list on commas that are not inside quotes. */
function splitIdentifiers(body: string): string[] {
  const identifiers: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  for (const char of body) {
    if (quote) {
      if (escaped) {
        current += char;
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ",") {
      identifiers.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  identifiers.push(current);
  return identifiers.map((value) => value.trim()).filter((value) => value.length > 0);
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * A promo href must be a site-relative path or an http(s) URL. Anything else
 * (`javascript:`, `data:`, a protocol-relative host) is dropped rather than
 * rendered — the marker comes from imported content.
 */
function safeHref(value: unknown): string | null {
  const href = boundedText(value, 2048);
  if (!href) return null;
  if (href.startsWith("//")) return null;
  if (href.startsWith("/")) return href;
  return /^https?:\/\//i.test(href) ? href : null;
}

function parsePromoLink(value: any): PromoLink | null {
  const href = safeHref(value?.href);
  const label = boundedText(value?.label, MAX_PROMO_LABEL);
  return href && label ? { label, href } : null;
}

function parsePromoData(json: string): PromoData | null {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const title = boundedText(raw.title, MAX_PROMO_LABEL);
  const body = boundedText(raw.body, MAX_PROMO_TEXT);
  if (!title && !body) return null;
  const imageUrl = safeHref(raw.image?.url);
  return {
    title,
    body,
    cta: parsePromoLink(raw.cta),
    social: parsePromoLink(raw.social),
    image: imageUrl ? { url: imageUrl, alt: boundedText(raw.image?.alt, MAX_PROMO_LABEL) } : null,
    variant: boundedText(raw.variant, 32) || null,
  };
}

/**
 * Every embedded block in document order, with indices into `html` itself.
 * A marker that does not parse is left alone — it stays part of the HTML
 * rather than disappearing from the article.
 */
export function parseBlogBlocks(html: string): BlogBlock[] {
  if (!html || typeof html !== "string") return [];
  const blocks: BlogBlock[] = [];
  const opener = /\[(products|promo):|&#0*91;(products|promo):/gi;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(html)) !== null) {
    const startIndex = match.index;
    const endIndex = findMarkerEnd(html, startIndex);
    if (endIndex === -1) continue;
    const originalMatch = html.slice(startIndex, endIndex);
    const decoded = decodeMarkerEntities(originalMatch);
    // `decoded` turns both bracket forms into real brackets, so the payload is
    // always between the first ":" and the final "]".
    const inner = decoded.slice(decoded.indexOf(":") + 1, decoded.lastIndexOf("]")).trim();
    const kind = (match[1] || match[2]).toLowerCase();

    if (kind === "products") {
      const identifiers = splitIdentifiers(inner);
      if (identifiers.length > 0) {
        blocks.push({ type: "products", identifiers, originalMatch, startIndex, endIndex });
      }
    } else {
      const data = parsePromoData(inner);
      if (data) {
        blocks.push({ type: "promo", data, originalMatch, startIndex, endIndex });
      }
    }
    opener.lastIndex = endIndex;
  }

  return blocks;
}

/**
 * Product carousels only. Kept for the admin editor, whose preview knows
 * nothing about promotional sections.
 */
export function parseProductShortcodes(html: string): ParsedShortcode[] {
  return parseBlogBlocks(html).filter(
    (block): block is ProductsBlock => block.type === "products",
  );
}

/**
 * Replace blocks in HTML with placeholders
 * Returns the modified HTML and a map of placeholders to block data
 */
export function replaceShortcodesWithPlaceholders(
  html: string,
  shortcodes: ParsedShortcode[],
): { html: string; placeholders: Map<string, ParsedShortcode> } {
  const placeholders = new Map<string, ParsedShortcode>();
  let modifiedHtml = html;

  // Process in reverse order to maintain indices
  const sortedShortcodes = [...shortcodes].sort((a, b) => b.startIndex - a.startIndex);

  for (const shortcode of sortedShortcodes) {
    const placeholder = `__SHORTCODE_${shortcodes.indexOf(shortcode)}__`;
    placeholders.set(placeholder, shortcode);

    modifiedHtml =
      modifiedHtml.slice(0, shortcode.startIndex) +
      placeholder +
      modifiedHtml.slice(shortcode.endIndex);
  }

  return { html: modifiedHtml, placeholders };
}

/**
 * Extract product slug from URL
 * Supports both full URLs and relative paths
 * Examples:
 * - https://new.infinitycolor.co/pdp/product-slug → product-slug
 * - /pdp/product-slug → product-slug
 * - pdp/product-slug → product-slug
 */
export function extractProductSlugFromUrl(url: string): string | null {
  if (!url || typeof url !== "string") {
    return null;
  }

  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  // Try to extract slug from /pdp/[slug] pattern
  // Handle both full URLs and relative paths
  const patterns = [
    /\/pdp\/([^\/\?#]+)/, // Matches /pdp/slug or https://domain/pdp/slug
    /^pdp\/([^\/\?#]+)/, // Matches pdp/slug (no leading slash)
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match && match[1]) {
      // Decode the slug in case it's URL encoded
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }

  // If no pattern matches, check if it's just a slug (no /pdp/ prefix)
  // This handles cases where user pastes just the slug
  if (!trimmed.includes("/") && !trimmed.includes("http")) {
    return trimmed;
  }

  return null;
}

/**
 * Extract multiple product slugs from URLs
 * Supports comma-separated or newline-separated URLs
 */
export function extractProductSlugsFromUrls(urls: string): string[] {
  if (!urls || typeof urls !== "string") {
    return [];
  }

  // Split by comma or newline
  const urlList = urls
    .split(/[,\n]/)
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  const slugs: string[] = [];
  for (const url of urlList) {
    const slug = extractProductSlugFromUrl(url);
    if (slug) {
      slugs.push(slug);
    }
  }

  return slugs;
}
