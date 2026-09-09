import sanitizeHtml from "sanitize-html";

const TITLE_LIMIT = 180;
const PARAGRAPH_LIMIT = 4_000;
const CONTENT_LIMIT = 120_000;
const SEO_DESCRIPTION_LIMIT = 180;

export const CATEGORY_EDITORIAL_IMPORT_SOURCE = "woocommerce-category-description";

const BODY_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "h3",
    "h4",
    "ul",
    "ol",
    "li",
    "blockquote",
    "pre",
    "code",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "a",
    "img",
    "figure",
    "figcaption",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "hr",
    "span",
  ],
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
};

function plainText(value: unknown): string {
  return sanitizeHtml(typeof value === "string" ? value : "", {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\s+/g, " ")
    .trim();
}

function boundedPlainText(value: unknown, limit: number, code: string): string {
  const normalized = plainText(value);
  if (normalized.length > limit) throw new Error(code);
  return normalized;
}

function containsImageWithoutAlt(html: string): boolean {
  return [...html.matchAll(/<img\b([^>]*)>/gi)].some((match) => {
    const alt = match[1].match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return !alt || !(alt[1] ?? alt[2] ?? alt[3] ?? "").trim();
  });
}

export type CategoryEditorialInput = {
  Title?: unknown;
  Paragraph?: unknown;
  Content?: unknown;
  IsPublished?: unknown;
  IsRTL?: unknown;
};

export type SanitizedCategoryEditorial = {
  Title: string;
  Paragraph: string;
  Content: string;
  IsPublished: boolean;
  IsRTL: boolean;
};

export function meaningfulEditorialText(html: string): string {
  return plainText(html.replace(/&nbsp;/gi, " "));
}

function normalizeAudio(record: any) {
  const raw = record?.Audio?.data?.attributes
    ? { id: record.Audio.data.id, ...record.Audio.data.attributes }
    : record?.Audio?.data ?? record?.Audio;
  const url = typeof raw?.url === "string" ? raw.url.trim() : "";
  const name = typeof raw?.name === "string" ? raw.name.trim() : "";
  const mime = typeof raw?.mime === "string" ? raw.mime.trim().toLowerCase() : "";
  if (!raw?.id || !url.startsWith("/uploads/") || !name || !mime.startsWith("audio/")) {
    return null;
  }
  return { url, name, mime };
}

export function categoryEditorialSeoDescription(record: any): string {
  const body = [plainText(record?.Paragraph), meaningfulEditorialText(String(record?.Content || ""))]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const combined = body || plainText(record?.Title);
  if (combined.length <= SEO_DESCRIPTION_LIMIT) return combined;
  const candidate = combined.slice(0, SEO_DESCRIPTION_LIMIT + 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  const clipped = wordBoundary >= Math.floor(SEO_DESCRIPTION_LIMIT * 0.65)
    ? candidate.slice(0, wordBoundary)
    : combined.slice(0, SEO_DESCRIPTION_LIMIT);
  return `${clipped.trim()}…`;
}

export function sanitizeCategoryEditorial(
  input: CategoryEditorialInput,
  options: { rejectMissingImageAlt?: boolean; allowTitleOnly?: boolean } = {
    rejectMissingImageAlt: true,
  },
): SanitizedCategoryEditorial {
  const rawContent = typeof input.Content === "string" ? input.Content : "";
  if (rawContent.length > CONTENT_LIMIT) throw new Error("EDITORIAL_CONTENT_TOO_LONG");
  if (options.rejectMissingImageAlt !== false && containsImageWithoutAlt(rawContent)) {
    throw new Error("EDITORIAL_IMAGE_ALT_REQUIRED");
  }

  const value = {
    Title: boundedPlainText(input.Title, TITLE_LIMIT, "EDITORIAL_TITLE_TOO_LONG"),
    Paragraph: boundedPlainText(
      input.Paragraph,
      PARAGRAPH_LIMIT,
      "EDITORIAL_PARAGRAPH_TOO_LONG",
    ),
    Content: sanitizeHtml(rawContent, BODY_OPTIONS).trim(),
    IsPublished: input.IsPublished === true,
    IsRTL: input.IsRTL !== false,
  };

  if (!value.Title) throw new Error("EDITORIAL_TITLE_REQUIRED");
  if (
    value.IsPublished &&
    !options.allowTitleOnly &&
    !value.Paragraph &&
    !meaningfulEditorialText(value.Content)
  ) {
    throw new Error("EDITORIAL_PUBLISHED_CONTENT_REQUIRED");
  }
  return value;
}

export function sanitizePublicCategoryEditorial(record: any) {
  if (!record?.IsPublished) return null;
  try {
    const allowTitleOnly = record?.ImportSource === CATEGORY_EDITORIAL_IMPORT_SOURCE;
    const value = sanitizeCategoryEditorial(record, {
      rejectMissingImageAlt: false,
      allowTitleOnly,
    });
    if (
      !value.Title ||
      (!allowTitleOnly && !value.Paragraph && !meaningfulEditorialText(value.Content))
    ) {
      return null;
    }
    return {
      id: Number(record.id),
      title: value.Title,
      paragraph: value.Paragraph || null,
      content: value.Content || null,
      audio: normalizeAudio(record),
      seoDescription: categoryEditorialSeoDescription(value) || null,
      isRtl: value.IsRTL,
      updatedAt: record.updatedAt ?? null,
    };
  } catch {
    // Legacy rows may predate today's publication validation. Treat an invalid
    // published row as unavailable instead of allowing it to break the PLP.
    return null;
  }
}
