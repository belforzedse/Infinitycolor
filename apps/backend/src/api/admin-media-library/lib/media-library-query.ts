import { escapeAdminLike } from "../../../utils/admin-list-query";
import { MODEL_APPLICATION_PHOTO_ALT_TEXTS } from "../../model-application/lib/photos";

/**
 * Catalog media library for the admin product picker.
 *
 * The upload table is shared by every feature (posts, stories, category content,
 * model-application photos…), so the stock `GET /upload/files` would show a seller every
 * upload in the system. This library shows only files that are either used exclusively
 * as a product's CoverImage/Media, or attached to nothing at all (replaced covers,
 * uploads that were never saved). A file shared with any other entity is left out: post
 * delete removes its files without a where-used check, so a product reusing one would
 * lose its image with the post.
 */

export const MEDIA_LIBRARY_TYPES = ["image", "video"] as const;
export const MEDIA_LIBRARY_USAGES = ["all", "attached", "unattached"] as const;
export const MEDIA_LIBRARY_DEFAULT_PAGE_SIZE = 24;
export const MEDIA_LIBRARY_MAX_PAGE_SIZE = 60;
export const MEDIA_LIBRARY_USAGE_PRODUCTS_LIMIT = 3;

export type MediaLibraryType = (typeof MEDIA_LIBRARY_TYPES)[number];
export type MediaLibraryUsage = (typeof MEDIA_LIBRARY_USAGES)[number];

export type MediaLibraryFilter = {
  type: MediaLibraryType;
  usage: MediaLibraryUsage;
  /** Already expanded with `expandSearchTermVariants`; empty means no search. */
  searchVariants: string[];
};

export type SqlQuery = { sql: string; bindings: unknown[] };

const PRODUCT_UID = "api::product.product";
const PRODUCT_MEDIA_FIELDS = ["CoverImage", "Media"] as const;
// Only components actually owned by a product count as catalog media.
export const PRODUCT_MEDIA_REFERENCES = `
  SELECT file_id, related_id AS product_id, (field = 'CoverImage') AS as_cover
  FROM files_related_morphs
  WHERE related_type = 'api::product.product' AND field IN ('CoverImage', 'Media')
  UNION ALL
  SELECT fm.file_id, pc.entity_id AS product_id, false AS as_cover
  FROM files_related_morphs fm
  JOIN products_components pc ON pc.component_id = fm.related_id
    AND pc.component_type = 'product.color-gallery' AND pc.field = 'ColorGalleries'
  WHERE fm.related_type = 'product.color-gallery' AND fm.field = 'Images'
`;
const FORMAT_KEYS = ["thumbnail", "small", "medium", "large"] as const;

type FormatKey = (typeof FORMAT_KEYS)[number];

export type MediaLibraryFormat = {
  url: string;
  width: number | null;
  height: number | null;
  mime: string | null;
};

export type MediaLibraryUsageProduct = {
  id: number;
  title: string;
  removed: boolean;
  asCover: boolean;
};

export type MediaLibraryItemUsage = {
  /** Live products using the file (cover and gallery on one product count once). */
  productCount: number;
  removedProductCount: number;
  usedAsCover: boolean;
  /** At most MEDIA_LIBRARY_USAGE_PRODUCTS_LIMIT, live products first. */
  products: MediaLibraryUsageProduct[];
};

export type MediaLibraryItem = {
  id: number;
  name: string;
  alternativeText: string | null;
  url: string;
  mime: string;
  ext: string | null;
  width: number | null;
  height: number | null;
  /** Kilobytes, as Strapi stores it. */
  size: number | null;
  createdAt: string | null;
  formats: Partial<Record<FormatKey, MediaLibraryFormat>> | null;
  /** Best small rendition for a grid tile. */
  thumbnailUrl: string | null;
  video: { status: string | null; posterUrl: string | null } | null;
  usage: MediaLibraryItemUsage;
};

export const EMPTY_USAGE: MediaLibraryItemUsage = Object.freeze({
  productCount: 0,
  removedProductCount: 0,
  usedAsCover: false,
  products: [],
}) as MediaLibraryItemUsage;

export function buildMediaLibraryWhere(filter: MediaLibraryFilter): SqlQuery {
  const clauses: string[] = [];
  const bindings: unknown[] = [];

  clauses.push("f.url IS NOT NULL");
  clauses.push("f.mime LIKE ?");
  bindings.push(`${filter.type}/%`);

  // `IS NOT TRUE` keeps a morph row with a NULL related_type/field counted as foreign.
  clauses.push(
    `NOT EXISTS (
      SELECT 1 FROM files_related_morphs fm
      WHERE fm.file_id = f.id
        AND ((fm.related_type = ? AND fm.field IN (?, ?)) OR
          (fm.related_type = 'product.color-gallery' AND fm.field = 'Images' AND EXISTS (
            SELECT 1 FROM products_components pc WHERE pc.component_id = fm.related_id
              AND pc.component_type = 'product.color-gallery' AND pc.field = 'ColorGalleries'
          ))) IS NOT TRUE
    )`,
  );
  bindings.push(PRODUCT_UID, ...PRODUCT_MEDIA_FIELDS);

  const applicantAltTexts = Object.values(MODEL_APPLICATION_PHOTO_ALT_TEXTS);
  clauses.push(
    `(f.alternative_text IS NULL OR f.alternative_text NOT IN (${applicantAltTexts
      .map(() => "?")
      .join(", ")}))`,
  );
  bindings.push(...applicantAltTexts);

  if (filter.type === "video") {
    // A failed transcode leaves the row on a raw source browsers may not decode.
    clauses.push("COALESCE(f.provider_metadata -> 'video' ->> 'status', '') <> 'failed'");
  }

  if (filter.usage === "attached") {
    clauses.push("EXISTS (SELECT 1 FROM files_related_morphs um WHERE um.file_id = f.id)");
  } else if (filter.usage === "unattached") {
    clauses.push("NOT EXISTS (SELECT 1 FROM files_related_morphs um WHERE um.file_id = f.id)");
  }

  if (filter.searchVariants.length > 0) {
    const patterns = filter.searchVariants.map((variant) => `%${escapeAdminLike(variant)}%`);
    const nameMatch = patterns.map(() => "f.name ILIKE ?").join(" OR ");
    const titleMatch = patterns.map(() => "sp.title ILIKE ?").join(" OR ");
    // `IN (subquery)` is planned once as a hashed SubPlan instead of per file.
    clauses.push(
      `(${nameMatch} OR f.id IN (
        SELECT sm.file_id FROM (${PRODUCT_MEDIA_REFERENCES}) sm
        JOIN products sp ON sp.id = sm.product_id
        WHERE (${titleMatch})
      ))`,
    );
    bindings.push(...patterns, ...patterns);
  }

  return { sql: clauses.join("\n  AND "), bindings };
}

export function buildMediaLibraryPageQuery(
  filter: MediaLibraryFilter,
  page: number,
  pageSize: number,
): SqlQuery {
  const where = buildMediaLibraryWhere(filter);
  return {
    sql: `SELECT f.id, f.name, f.alternative_text, f.url, f.mime, f.ext, f.width, f.height,
       f.size, f.formats, f.created_at,
       f.provider_metadata -> 'video' ->> 'status' AS video_status,
       f.provider_metadata -> 'video' -> 'output' -> 'poster' ->> 'url' AS video_poster_url
FROM files f
WHERE ${where.sql}
ORDER BY f.created_at DESC, f.id DESC
LIMIT ? OFFSET ?`,
    bindings: [...where.bindings, pageSize, (page - 1) * pageSize],
  };
}

export function buildMediaLibraryCountQuery(filter: MediaLibraryFilter): SqlQuery {
  const where = buildMediaLibraryWhere(filter);
  return {
    sql: `SELECT COUNT(*)::bigint AS total FROM files f WHERE ${where.sql}`,
    bindings: where.bindings,
  };
}

export function buildMediaLibraryUsageQuery(fileIds: number[]): SqlQuery {
  return {
    sql: `WITH pairs AS (
  SELECT m.file_id, p.id AS product_id, p.title, (p.removed_at IS NOT NULL) AS removed,
         BOOL_OR(m.as_cover) AS as_cover
  FROM (${PRODUCT_MEDIA_REFERENCES}) m
  JOIN products p ON p.id = m.product_id
  WHERE m.file_id = ANY(string_to_array(?, ',')::integer[])
  GROUP BY m.file_id, p.id, p.title, p.removed_at
), ranked AS (
  SELECT pairs.*,
         SUM(CASE WHEN removed THEN 0 ELSE 1 END) OVER w AS active_count,
         SUM(CASE WHEN removed THEN 1 ELSE 0 END) OVER w AS removed_count,
         BOOL_OR(as_cover AND NOT removed) OVER w AS active_cover,
         ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY removed ASC, product_id DESC) AS rn
  FROM pairs
  WINDOW w AS (PARTITION BY file_id)
)
SELECT file_id, product_id, title, removed, as_cover, active_count, removed_count, active_cover
FROM ranked
WHERE rn <= ?
ORDER BY file_id, rn`,
    bindings: [
      fileIds.join(","),
      MEDIA_LIBRARY_USAGE_PRODUCTS_LIMIT,
    ],
  };
}

export function rowsFromRaw(result: any): any[] {
  return result?.rows || result?.[0] || [];
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value !== "") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
  }
  return null;
}

function projectFormats(raw: unknown): MediaLibraryItem["formats"] {
  let formats = raw;
  if (typeof formats === "string") {
    try {
      formats = JSON.parse(formats);
    } catch {
      return null;
    }
  }
  if (!formats || typeof formats !== "object") return null;

  const projected: Partial<Record<FormatKey, MediaLibraryFormat>> = {};
  for (const key of FORMAT_KEYS) {
    const format = (formats as Record<string, any>)[key];
    const url = toText(format?.url);
    if (!url) continue;
    projected[key] = {
      url,
      width: toNumberOrNull(format.width),
      height: toNumberOrNull(format.height),
      mime: toText(format.mime),
    };
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

export function groupUsageRows(rows: any[]): Map<number, MediaLibraryItemUsage> {
  const usageByFile = new Map<number, MediaLibraryItemUsage>();
  for (const row of rows) {
    const fileId = Number(row.file_id);
    let usage = usageByFile.get(fileId);
    if (!usage) {
      usage = {
        productCount: Number(row.active_count) || 0,
        removedProductCount: Number(row.removed_count) || 0,
        usedAsCover: row.active_cover === true,
        products: [],
      };
      usageByFile.set(fileId, usage);
    }
    usage.products.push({
      id: Number(row.product_id),
      title: String(row.title ?? ""),
      removed: row.removed === true,
      asCover: row.as_cover === true,
    });
  }
  return usageByFile;
}

/** Explicit projection: never `hash`, and never raw provider_metadata (lease, failures). */
export function projectMediaLibraryRow(
  row: any,
  usage: MediaLibraryItemUsage = EMPTY_USAGE,
): MediaLibraryItem {
  const mime = String(row.mime ?? "");
  const url = String(row.url ?? "");
  const formats = projectFormats(row.formats);
  const isVideo = mime.startsWith("video/");
  const posterUrl = toText(row.video_poster_url);

  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    alternativeText: toText(row.alternative_text),
    url,
    mime,
    ext: toText(row.ext),
    width: toNumberOrNull(row.width),
    height: toNumberOrNull(row.height),
    size: toNumberOrNull(row.size),
    createdAt: toIsoString(row.created_at),
    formats,
    thumbnailUrl:
      formats?.small?.url ??
      formats?.thumbnail?.url ??
      posterUrl ??
      (mime.startsWith("image/") && url ? url : null),
    video: isVideo ? { status: toText(row.video_status), posterUrl } : null,
    usage: {
      ...usage,
      products: usage.products.map((product) => ({ ...product })),
    },
  };
}
