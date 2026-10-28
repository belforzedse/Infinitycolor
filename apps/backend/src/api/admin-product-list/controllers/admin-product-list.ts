import { sanitize } from "@strapi/utils";
import { rejectAdminListRequest } from "../../../utils/admin-list-query";
import { productLifecycleState } from "../../../utils/productVisibility";
import {
  PRODUCT_UID,
  countProductListViews,
  findProductListPage,
  parseProductListCriteria,
} from "../services/product-list-query";
import {
  purgeDueAt,
  readRetentionEnabledSince,
  trashRetentionDays,
} from "../../product/services/product-trash-retention";

/**
 * Admin Products list and its lifecycle tab counts. The query model — views,
 * search, quick and advanced filters, the sort allowlist — lives in
 * services/product-list-query.ts; this controller validates, hydrates the page
 * of ids with the compact list projection, and answers.
 */

const PRODUCT_SELECT = [
  "id",
  "EditRevision",
  "removedAt",
  "removedById",
  "removedByLabel",
  "preRemovalStatus",
  "preRemovalScheduledPublishAt",
  "Title",
  "Slug",
  "Status",
  "scheduledPublishAt",
  "scheduledPublishTimezone",
  "scheduledPublishLastAttemptAt",
  "scheduledPublishLastError",
  "scheduledPublishFailureKind",
  "PublishedAt",
  "ProductType",
  "AverageRating",
  "RatingCount",
  "createdAt",
  "updatedAt",
  "LastEditedByAdminAt",
];

const PRODUCT_POPULATE = {
  product_main_category: { select: ["id", "Title"] },
  product_variations: {
    select: ["id", "IsPublished", "SKU", "Price", "DiscountPrice"],
    populate: {
      product_stock: { select: ["id", "Count", "reservedCount", "StockRevision"] },
    },
  },
  CoverImage: {
    select: ["id", "name", "alternativeText", "width", "height", "formats", "url", "mime"],
  },
};

function projectProduct(
  product: any,
  retention: { days: number; enabledSince: Date | null },
) {
  const category = product.product_main_category;
  const coverImage = product.CoverImage;
  const variations = Array.isArray(product.product_variations) ? product.product_variations : [];

  return {
    id: product.id,
    attributes: {
      EditRevision: Number(product.EditRevision || 0),
      lifecycleState: productLifecycleState(product),
      removedAt: product.removedAt ?? null,
      removedById: product.removedById ?? null,
      removedByLabel: product.removedByLabel ?? null,
      // Legacy trashed rows predate preRemovalStatus and still carry their status.
      preRemovalStatus: product.removedAt
        ? product.preRemovalStatus ?? product.Status ?? null
        : null,
      preRemovalScheduledPublishAt: product.preRemovalScheduledPublishAt ?? null,
      purgeAt:
        product.removedAt && retention.days > 0
          ? purgeDueAt(new Date(product.removedAt), retention.enabledSince, retention.days).toISOString()
          : null,
      Title: product.Title ?? null,
      Slug: product.Slug ?? null,
      Status: product.Status ?? null,
      PublishedAt: product.PublishedAt ?? null,
      scheduledPublishAt: product.scheduledPublishAt ?? null,
      scheduledPublishTimezone: product.scheduledPublishTimezone ?? null,
      scheduledPublishLastAttemptAt: product.scheduledPublishLastAttemptAt ?? null,
      scheduledPublishLastError: product.scheduledPublishLastError ?? null,
      scheduledPublishFailureKind: product.scheduledPublishFailureKind ?? null,
      ProductType: product.ProductType ?? null,
      AverageRating:
        product.AverageRating === null || product.AverageRating === undefined
          ? null
          : Number(product.AverageRating),
      RatingCount:
        product.RatingCount === null || product.RatingCount === undefined
          ? null
          : Number(product.RatingCount),
      createdAt: product.createdAt ?? null,
      updatedAt: product.updatedAt ?? null,
      LastEditedByAdminAt: product.LastEditedByAdminAt ?? null,
      product_main_category: {
        data: category
          ? {
              id: category.id,
              attributes: { Title: category.Title ?? null },
            }
          : null,
      },
      product_variations: {
        data: variations.map((variation: any) => ({
          id: variation.id,
          attributes: {
            IsPublished: variation.IsPublished === true,
            SKU: variation.SKU ?? null,
            Price: variation.Price ?? null,
            DiscountPrice: variation.DiscountPrice ?? null,
            product_stock: {
              data: variation.product_stock
                ? {
                    id: variation.product_stock.id,
                    attributes: {
                      Count: Number(variation.product_stock.Count) || 0,
                      StockRevision: Number(variation.product_stock.StockRevision || 0),
                      reservedCount: Number(variation.product_stock.reservedCount || 0),
                    },
                  }
                : null,
            },
          },
        })),
      },
      CoverImage: {
        data: coverImage
          ? {
              id: coverImage.id,
              attributes: {
                name: coverImage.name ?? null,
                alternativeText: coverImage.alternativeText ?? null,
                width: coverImage.width ?? null,
                height: coverImage.height ?? null,
                formats: coverImage.formats ?? null,
                url: coverImage.url ?? null,
                mime: coverImage.mime ?? null,
              },
            }
          : null,
      },
    },
  };
}

async function hydrate(ids: number[]) {
  if (ids.length === 0) return [];
  const rows = await strapi.query(PRODUCT_UID).findMany({
    where: { id: { $in: ids } },
    select: PRODUCT_SELECT,
    populate: PRODUCT_POPULATE,
    limit: ids.length,
  });
  const rank = new Map(ids.map((id, index) => [id, index]));
  return (rows as any[]).sort((left, right) => rank.get(Number(left.id))! - rank.get(Number(right.id))!);
}

async function retentionState() {
  const days = trashRetentionDays();
  return { days, enabledSince: days > 0 ? await readRetentionEnabledSince(strapi) : null };
}

export default {
  async query(ctx) {
    const startedAt = Date.now();
    const criteria = parseProductListCriteria(ctx, ctx.request?.body);
    if (!criteria) return;

    const [{ ids, total }, counts, retention] = await Promise.all([
      findProductListPage(strapi, criteria),
      countProductListViews(strapi, { ...criteria, page: 1 }),
      retentionState(),
    ]);
    const rows = await hydrate(ids);
    const schema = strapi.contentType(PRODUCT_UID);
    const sanitizedRows = await sanitize.contentAPI.output(rows, schema, {
      auth: ctx.state.auth,
    });
    const data = (sanitizedRows as any[]).map((row) => projectProduct(row, retention));

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = {
      data,
      meta: {
        pagination: {
          page: criteria.page,
          pageSize: criteria.pageSize,
          pageCount: Math.ceil(total / criteria.pageSize),
          total,
        },
        view: criteria.view,
        sort: criteria.sort,
        counts,
        // Pre-lifecycle clients read the recycle-bin badge from here.
        recycleCount: counts.trash,
        trashRetentionDays: retention.days,
      },
    };

    strapi.log.info("admin products list completed", {
      durationMs: Date.now() - startedAt,
      page: criteria.page,
      pageSize: criteria.pageSize,
      returned: data.length,
      total,
      view: criteria.view,
      sort: criteria.sort,
      hasSearch: Boolean(criteria.search),
      filterCount: criteria.filters.length,
    });
  },

  async counts(ctx) {
    const startedAt = Date.now();
    const body = ctx.request?.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return rejectAdminListRequest(ctx, "Request body must be an object");
    }
    // The tab is not a count criterion: every bucket is counted.
    const criteria = parseProductListCriteria(ctx, { ...body, view: "all", sort: undefined });
    if (!criteria) return;
    const counts = await countProductListViews(strapi, criteria);

    ctx.set("Cache-Control", "private, no-store");
    ctx.body = { data: { counts, trashRetentionDays: trashRetentionDays() } };
    strapi.log.info("admin product counts completed", {
      durationMs: Date.now() - startedAt,
      hasSearch: Boolean(criteria.search),
      filterCount: criteria.filters.length,
    });
  },
};
