import { triggerFrontendRevalidation } from "../../../../utils/revalidate";

const REVIEW_UID = 'api::product-review.product-review' as const;

type Snapshot = { product?: { id: number }; Status?: string; removedAt?: unknown; Rate?: number };
const contribution = (review?: Snapshot) =>
  review?.Status === 'Accepted' && !review.removedAt && Number.isFinite(review.Rate)
    ? { count: 1, sum: Number(review.Rate) }
    : { count: 0, sum: 0 };

async function readReview(where): Promise<Snapshot | undefined> {
  return strapi.db.query(REVIEW_UID).findOne({
    where, select: ['Rate', 'Status', 'removedAt'], populate: { product: { select: ['id'] } },
  });
}

async function rememberReview(event) {
  event.state = { ...event.state, previousReview: await readReview(event.params.where) };
}

async function refreshRating(event) {
  const previous: Snapshot | undefined = event.state?.previousReview;
  const current = event.action === 'afterDelete' ? undefined : await readReview({ id: event.result.id });
  const productIds = [...new Set([previous?.product?.id, current?.product?.id].filter(Boolean))].sort((a, b) => a - b);
  for (const productId of productIds) {
    const before = contribution(previous?.product?.id === productId ? previous : undefined);
    const after = contribution(current?.product?.id === productId ? current : undefined);
    const countDelta = after.count - before.count;
    const sumDelta = after.sum - before.sum;
    if (!countDelta && !sumDelta) continue;
    // Preserve imported rating totals; apply only this review's moderation change.
    let slug: string | undefined;
    await strapi.db.transaction(async ({ trx }) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`product-review-rating:${productId}`]);
      const product = await strapi.entityService.findOne('api::product.product', productId, {
        fields: ['AverageRating', 'RatingCount', 'Slug'], transacting: trx,
      } as any);
      if (!product) return;
      slug = product.Slug;
      const previousCount = Number(product.RatingCount) || 0;
      const count = Math.max(0, previousCount + countDelta);
      const sum = (Number(product.AverageRating) || 0) * previousCount + sumDelta;
      await strapi.entityService.update('api::product.product', productId, {
        data: { RatingCount: count, AverageRating: count ? Math.max(0, Math.min(5, sum / count)) : 0 },
        transacting: trx,
      } as any);
    });
    if (slug) await triggerFrontendRevalidation({ path: slug, type: 'product' }, 'Review rating');
  }
}

export default {
  beforeUpdate: rememberReview,
  beforeDelete: rememberReview,
  afterCreate: refreshRating,
  afterUpdate: refreshRating,
  afterDelete: refreshRating,
};
