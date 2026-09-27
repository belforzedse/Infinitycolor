import {
  buildMediaLibraryCountQuery,
  buildMediaLibraryPageQuery,
  buildMediaLibraryUsageQuery,
  buildMediaLibraryWhere,
  groupUsageRows,
  MEDIA_LIBRARY_TYPES,
  MEDIA_LIBRARY_USAGES,
  projectMediaLibraryRow,
  type MediaLibraryFilter,
} from "../media-library-query";
import { expandSearchTermVariants } from "../../../../utils/searchTermVariants";

const baseFilter: MediaLibraryFilter = { type: "image", usage: "all", searchVariants: [] };

function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) || []).length;
}

describe("media library query builder", () => {
  it("limits the default query to product-only or unattached images", () => {
    const { sql, bindings } = buildMediaLibraryWhere(baseFilter);

    expect(sql).toContain("f.url IS NOT NULL");
    expect(sql).toContain("f.mime LIKE ?");
    expect(bindings[0]).toBe("image/%");
    expect(sql).toMatch(
      /NOT EXISTS \(\s*SELECT 1 FROM files_related_morphs fm[\s\S]*IS NOT TRUE\s*\)/,
    );
    expect(bindings).toEqual(
      expect.arrayContaining(["api::product.product", "CoverImage", "Media"]),
    );
    expect(sql).not.toContain("provider_metadata");
    expect(sql).not.toContain("um.file_id");
  });

  it("excludes model-application photos by their alt text", () => {
    const { sql, bindings } = buildMediaLibraryWhere(baseFilter);

    expect(sql).toContain("f.alternative_text IS NULL OR f.alternative_text NOT IN (?, ?)");
    expect(bindings).toEqual(
      expect.arrayContaining(["عکس اول درخواست مدل", "عکس دوم درخواست مدل"]),
    );
  });

  it("drops failed video transcodes only for the video type", () => {
    const { sql, bindings } = buildMediaLibraryWhere({ ...baseFilter, type: "video" });

    expect(bindings[0]).toBe("video/%");
    expect(sql).toContain("COALESCE(f.provider_metadata -> 'video' ->> 'status', '') <> 'failed'");
  });

  it("filters attached and unattached files", () => {
    expect(buildMediaLibraryWhere({ ...baseFilter, usage: "attached" }).sql).toContain(
      "AND EXISTS (SELECT 1 FROM files_related_morphs um WHERE um.file_id = f.id)",
    );
    expect(buildMediaLibraryWhere({ ...baseFilter, usage: "unattached" }).sql).toContain(
      "AND NOT EXISTS (SELECT 1 FROM files_related_morphs um WHERE um.file_id = f.id)",
    );
  });

  it("searches file names and product titles with escaped wildcards", () => {
    const { sql, bindings } = buildMediaLibraryWhere({
      ...baseFilter,
      searchVariants: ["50%_\\"],
    });

    expect(sql).toContain("f.name ILIKE ?");
    expect(sql).toContain("sp.title ILIKE ?");
    expect(sql).toContain("f.id IN (");
    expect(bindings.filter((value) => value === "%50\\%\\_\\\\%")).toHaveLength(2);
  });

  it("matches a product code typed without the space the title stores", () => {
    const { bindings } = buildMediaLibraryWhere({
      ...baseFilter,
      searchVariants: expandSearchTermVariants("W00288"),
    });

    expect(bindings).toEqual(expect.arrayContaining(["%W00288%", "%W 00288%"]));
  });

  it("binds exactly one value per placeholder for every filter combination", () => {
    for (const type of MEDIA_LIBRARY_TYPES) {
      for (const usage of MEDIA_LIBRARY_USAGES) {
        for (const searchVariants of [[], ["a"], expandSearchTermVariants("W00288")]) {
          const filter = { type, usage, searchVariants };
          const page = buildMediaLibraryPageQuery(filter, 3, 24);
          const count = buildMediaLibraryCountQuery(filter);
          expect(placeholderCount(page.sql)).toBe(page.bindings.length);
          expect(placeholderCount(count.sql)).toBe(count.bindings.length);
        }
      }
    }
    const usage = buildMediaLibraryUsageQuery([1, 2, 3]);
    expect(placeholderCount(usage.sql)).toBe(usage.bindings.length);
  });

  it("pages newest first with limit and offset last", () => {
    const { sql, bindings } = buildMediaLibraryPageQuery(baseFilter, 3, 24);

    expect(sql).toContain("ORDER BY f.created_at DESC, f.id DESC");
    expect(bindings.slice(-2)).toEqual([24, 48]);
  });

  it("passes the page's file ids to the usage query as one list", () => {
    const { bindings } = buildMediaLibraryUsageQuery([7, 8, 9]);

    expect(bindings).toContain("7,8,9");
    expect(bindings[bindings.length - 1]).toBe(3);
  });
});

describe("media library projection", () => {
  const row = {
    id: "12",
    name: "cover.webp",
    alternative_text: null,
    url: "/uploads/cover.webp",
    mime: "image/webp",
    ext: ".webp",
    width: 844,
    height: 1000,
    size: "15.54",
    formats: JSON.stringify({
      thumbnail: { url: "/uploads/thumbnail_cover.webp", width: 132, height: 156, hash: "must-not-leak" },
      small: { url: "/uploads/small_cover.webp", width: 422, height: 500, mime: "image/webp" },
    }),
    created_at: new Date("2026-09-20T10:00:00.000Z"),
    hash: "must-not-leak",
    provider_metadata: { video: { lease: { owner: "must-not-leak" } } },
    video_status: null,
    video_poster_url: null,
  };

  it("returns explicit fields and prefers the small rendition for tiles", () => {
    const item = projectMediaLibraryRow(row);

    expect(item).toMatchObject({
      id: 12,
      name: "cover.webp",
      mime: "image/webp",
      size: 15.54,
      createdAt: "2026-09-20T10:00:00.000Z",
      thumbnailUrl: "/uploads/small_cover.webp",
      video: null,
      usage: { productCount: 0, removedProductCount: 0, usedAsCover: false, products: [] },
    });
    expect(item.formats?.thumbnail).toEqual({
      url: "/uploads/thumbnail_cover.webp",
      width: 132,
      height: 156,
      mime: null,
    });
    expect(JSON.stringify(item)).not.toContain("must-not-leak");
  });

  it("falls back to the video poster, then the original image", () => {
    const video = projectMediaLibraryRow({
      ...row,
      mime: "video/mp4",
      formats: null,
      video_status: "playback_ready",
      video_poster_url: "/uploads/poster.jpg",
    });
    expect(video.thumbnailUrl).toBe("/uploads/poster.jpg");
    expect(video.video).toEqual({ status: "playback_ready", posterUrl: "/uploads/poster.jpg" });

    const bare = projectMediaLibraryRow({ ...row, formats: null });
    expect(bare.thumbnailUrl).toBe("/uploads/cover.webp");

    const unprocessedVideo = projectMediaLibraryRow({ ...row, mime: "video/mp4", formats: null });
    expect(unprocessedVideo.thumbnailUrl).toBeNull();
  });

  it("groups usage rows per file and keeps the full counts", () => {
    const usage = groupUsageRows([
      {
        file_id: 12,
        product_id: 40,
        title: "مانتو",
        removed: false,
        as_cover: true,
        active_count: "2",
        removed_count: "1",
        active_cover: true,
      },
      {
        file_id: 12,
        product_id: 30,
        title: "شومیز",
        removed: false,
        as_cover: false,
        active_count: "2",
        removed_count: "1",
        active_cover: true,
      },
      {
        file_id: 13,
        product_id: 20,
        title: "حذف‌شده",
        removed: true,
        as_cover: true,
        active_count: "0",
        removed_count: "1",
        active_cover: false,
      },
    ]);

    expect(usage.get(12)).toEqual({
      productCount: 2,
      removedProductCount: 1,
      usedAsCover: true,
      products: [
        { id: 40, title: "مانتو", removed: false, asCover: true },
        { id: 30, title: "شومیز", removed: false, asCover: false },
      ],
    });
    expect(usage.get(13)).toMatchObject({ productCount: 0, removedProductCount: 1, usedAsCover: false });
  });
});
