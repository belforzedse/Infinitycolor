import sanitizeHtml from "sanitize-html";

const TITLE_LIMIT = 180;
const PARAGRAPH_LIMIT = 4_000;
const CONTENT_LIMIT = 120_000;

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

function plainText(value: unknown, limit: number): string {
  return sanitizeHtml(typeof value === "string" ? value : "", {
    allowedTags: [],
    allowedAttributes: {},
  })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
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
  return plainText(html.replace(/&nbsp;/gi, " "), CONTENT_LIMIT);
}

export function sanitizeCategoryEditorial(
  input: CategoryEditorialInput,
  options: { rejectMissingImageAlt?: boolean } = { rejectMissingImageAlt: true },
): SanitizedCategoryEditorial {
  const rawContent = typeof input.Content === "string" ? input.Content.slice(0, CONTENT_LIMIT) : "";
  if (options.rejectMissingImageAlt !== false && containsImageWithoutAlt(rawContent)) {
    throw new Error("EDITORIAL_IMAGE_ALT_REQUIRED");
  }

  const value = {
    Title: plainText(input.Title, TITLE_LIMIT),
    Paragraph: plainText(input.Paragraph, PARAGRAPH_LIMIT),
    Content: sanitizeHtml(rawContent, BODY_OPTIONS).trim(),
    IsPublished: input.IsPublished === true,
    IsRTL: input.IsRTL !== false,
  };

  if (!value.Title) throw new Error("EDITORIAL_TITLE_REQUIRED");
  if (value.IsPublished && !value.Paragraph && !meaningfulEditorialText(value.Content)) {
    throw new Error("EDITORIAL_PUBLISHED_CONTENT_REQUIRED");
  }
  return value;
}

export function sanitizePublicCategoryEditorial(record: any) {
  if (!record?.IsPublished) return null;
  try {
    const value = sanitizeCategoryEditorial(record, { rejectMissingImageAlt: false });
    if (!value.Title || (!value.Paragraph && !meaningfulEditorialText(value.Content))) return null;
    return {
      id: Number(record.id),
      title: value.Title,
      paragraph: value.Paragraph || null,
      content: value.Content || null,
      isRtl: value.IsRTL,
      updatedAt: record.updatedAt ?? null,
    };
  } catch {
    // Legacy rows may predate today's publication validation. Treat an invalid
    // published row as unavailable instead of allowing it to break the PLP.
    return null;
  }
}
