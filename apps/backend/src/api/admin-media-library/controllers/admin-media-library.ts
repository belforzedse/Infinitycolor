import {
  adminPagination,
  MAX_ADMIN_PAGE,
  MAX_ADMIN_SEARCH_LENGTH,
  positiveAdminInteger,
  rejectAdminListRequest,
} from "../../../utils/admin-list-query";
import { expandSearchTermVariants } from "../../../utils/searchTermVariants";
import {
  buildMediaLibraryCountQuery,
  buildMediaLibraryPageQuery,
  buildMediaLibraryUsageQuery,
  groupUsageRows,
  MEDIA_LIBRARY_DEFAULT_PAGE_SIZE,
  MEDIA_LIBRARY_MAX_PAGE_SIZE,
  MEDIA_LIBRARY_TYPES,
  MEDIA_LIBRARY_USAGES,
  projectMediaLibraryRow,
  rowsFromRaw,
  type MediaLibraryType,
  type MediaLibraryUsage,
} from "../lib/media-library-query";

function pickOption<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T | null {
  if (value === undefined || value === null || value === "") return fallback;
  return options.includes(value as T) ? (value as T) : null;
}

export default {
  async query(ctx) {
    const startedAt = Date.now();
    const body = ctx.request?.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return rejectAdminListRequest(ctx, "Request body must be an object");
    }

    const page = Math.min(positiveAdminInteger(body.page, 1), MAX_ADMIN_PAGE);
    const pageSize = Math.min(
      positiveAdminInteger(body.pageSize, MEDIA_LIBRARY_DEFAULT_PAGE_SIZE),
      MEDIA_LIBRARY_MAX_PAGE_SIZE,
    );
    const type = pickOption<MediaLibraryType>(body.type, MEDIA_LIBRARY_TYPES, "image");
    if (!type) return rejectAdminListRequest(ctx, "Unsupported media-library type");
    const usage = pickOption<MediaLibraryUsage>(body.usage, MEDIA_LIBRARY_USAGES, "all");
    if (!usage) return rejectAdminListRequest(ctx, "Unsupported media-library usage");
    const search = String(body.search ?? "").trim();
    if (search.length > MAX_ADMIN_SEARCH_LENGTH) {
      return rejectAdminListRequest(ctx, "search must contain at most 80 characters");
    }

    // "W00288" must find the product whose title stores the code as "W 00288".
    const filter = { type, usage, searchVariants: expandSearchTermVariants(search) };
    const knex = strapi.db.connection;
    const pageQuery = buildMediaLibraryPageQuery(filter, page, pageSize);
    const countQuery = buildMediaLibraryCountQuery(filter);
    const [pageResult, countResult] = await Promise.all([
      knex.raw(pageQuery.sql, pageQuery.bindings),
      knex.raw(countQuery.sql, countQuery.bindings),
    ]);
    const rows = rowsFromRaw(pageResult);
    const total = Number(rowsFromRaw(countResult)[0]?.total ?? 0);

    let usageByFile = new Map();
    if (rows.length > 0) {
      const usageQuery = buildMediaLibraryUsageQuery(rows.map((row) => Number(row.id)));
      usageByFile = groupUsageRows(
        rowsFromRaw(await knex.raw(usageQuery.sql, usageQuery.bindings)),
      );
    }
    const data = rows.map((row) => projectMediaLibraryRow(row, usageByFile.get(Number(row.id))));

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data,
      meta: { pagination: adminPagination(page, pageSize, total) },
    };

    // Strapi's logger drops a metadata argument, so the fields go into the message.
    strapi.log.info(
      `admin media library completed ${JSON.stringify({
        durationMs: Date.now() - startedAt,
        page,
        pageSize,
        returned: data.length,
        total,
        type,
        usage,
        hasSearch: Boolean(search),
      })}`,
    );
  },
};
