import type { Strapi } from "@strapi/strapi";
import { triggerFrontendRevalidation } from "../utils/revalidate";

type ScheduledProductRow = {
  id: number;
  Status?: string;
  Slug?: string | null;
  scheduledPublishAt?: string | Date | null;
  scheduledPublishRequireMedia?: boolean | null;
  CoverImage?: unknown;
};

function hasCover(cover: unknown): boolean {
  if (!cover) return false;
  if (Array.isArray(cover)) return cover.length > 0;
  if (typeof cover === "object" && cover !== null && "data" in cover) {
    const data = (cover as { data: unknown }).data;
    if (data === null || data === undefined) return false;
    return Array.isArray(data) ? data.length > 0 : Boolean(data);
  }
  return Boolean(cover);
}

/**
 * Publish due scheduled products.
 *
 * Claim is idempotent: an UPDATE only succeeds while Status is still `Scheduled`,
 * so concurrent workers cannot double-publish the same row.
 */
export async function runPublishScheduledProductsTick(
  strapi: Strapi,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ claimed: number; published: number; blocked: number; skipped: number }> {
  const now = opts.now || new Date();
  const limit = opts.limit ?? 50;
  const summary = { claimed: 0, published: 0, blocked: 0, skipped: 0 };

  const due = (await strapi.entityService.findMany("api::product.product", {
    filters: {
      Status: "Scheduled",
      scheduledPublishAt: { $lte: now.toISOString() },
    },
    populate: { CoverImage: true },
    fields: [
      "id",
      "Slug",
      "Status",
      "scheduledPublishAt",
      "scheduledPublishRequireMedia",
    ],
    limit,
    sort: { scheduledPublishAt: "asc" },
  })) as ScheduledProductRow[];

  summary.claimed = due.length;

  for (const row of due) {
    const product = (await strapi.entityService.findOne("api::product.product", row.id, {
      populate: { CoverImage: true },
      fields: [
        "id",
        "Slug",
        "Status",
        "scheduledPublishAt",
        "scheduledPublishRequireMedia",
      ],
    })) as ScheduledProductRow | null;

    if (!product || product.Status !== "Scheduled") {
      summary.skipped += 1;
      continue;
    }

    const scheduledAt = product.scheduledPublishAt
      ? new Date(product.scheduledPublishAt)
      : null;
    if (!scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() > now.getTime()) {
      summary.skipped += 1;
      continue;
    }

    const requireMedia = product.scheduledPublishRequireMedia !== false;
    if (requireMedia && !hasCover(product.CoverImage)) {
      await strapi.entityService.update("api::product.product", row.id, {
        data: {
          scheduledPublishLastAttemptAt: now.toISOString(),
          scheduledPublishLastError: "media-incomplete-blocking-scheduled-publish",
        } as never,
      });
      summary.blocked += 1;
      strapi.log.warn(`[scheduled-publish] blocked product ${row.id}: media incomplete`);
      continue;
    }

    // Atomic claim: only transition Scheduled → Active.
    const knex = strapi.db.connection;
    const updated = await knex("products")
      .where({ id: row.id, status: "Scheduled" })
      .update({
        status: "Active",
        scheduled_publish_at: null,
        scheduled_publish_last_attempt_at: now.toISOString(),
        scheduled_publish_last_error: null,
        updated_at: now.toISOString(),
      });

    if (!updated) {
      summary.skipped += 1;
      continue;
    }

    summary.published += 1;
    const slug = product.Slug || null;
    await triggerFrontendRevalidation(
      {
        type: "product",
        ...(slug ? { path: `/pdp/${slug}` } : {}),
        tag: "products",
      },
      "ScheduledProductPublish",
    );
  }

  return summary;
}
