export type BlogHeadingLevel = 2 | 3;

export interface BlogHeading {
  id: string;
  text: string;
  level: BlogHeadingLevel;
}

const HEADING_RE = /<h([23])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
const ID_ATTR_RE = /\sid\s*=\s*(["'])(.*?)\1/i;
const TAG_RE = /<[^>]+>/g;

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTags(html: string): string {
  return decodeBasicEntities(html.replace(TAG_RE, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeExistingId(raw: string): string {
  return raw
    .trim()
    .replace(/["'<>\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Collects h2/h3 titles for the post TOC and injects stable heading ids.
 * Generated ids use `section-n` so Persian titles never become empty slugs.
 */
export function extractBlogHeadings(html: string): { html: string; headings: BlogHeading[] } {
  if (!html) {
    return { html: html ?? "", headings: [] };
  }

  const headings: BlogHeading[] = [];
  const usedIds = new Set<string>();
  let sectionIndex = 0;

  const nextGeneratedId = (): string => {
    do {
      sectionIndex += 1;
    } while (usedIds.has(`section-${sectionIndex}`));
    return `section-${sectionIndex}`;
  };

  const rewritten = html.replace(
    HEADING_RE,
    (match, levelSrc: string, attrs = "", inner: string) => {
      const text = stripTags(inner);
      if (!text) return match;

      const level = Number(levelSrc) as BlogHeadingLevel;
      const idMatch = typeof attrs === "string" ? attrs.match(ID_ATTR_RE) : null;
      let id = idMatch ? sanitizeExistingId(idMatch[2] ?? "") : "";

      if (!id || usedIds.has(id)) {
        id = nextGeneratedId();
      }

      usedIds.add(id);
      headings.push({ id, text, level });

      const withoutId = (attrs || "").replace(ID_ATTR_RE, "").trim();
      const attrString = withoutId ? ` ${withoutId}` : "";
      return `<h${level}${attrString} id="${id}">${inner}</h${level}>`;
    },
  );

  return { html: rewritten, headings };
}
