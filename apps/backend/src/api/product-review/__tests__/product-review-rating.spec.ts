import lifecycle from '../content-types/product-review/lifecycles';
jest.mock('../../../utils/revalidate', () => ({ triggerFrontendRevalidation: jest.fn(async () => ({ failed: 0 })) }));
const accepted = { product: { id: 1 }, Rate: 4, Status: 'Accepted', removedAt: null };
const pending = { ...accepted, Status: 'Need for Review' };
let review: any;
let update: jest.Mock;
beforeEach(() => {
  update = jest.fn();
  (global as any).strapi = {
    db: { query: () => ({ findOne: async () => review }), transaction: async fn => fn({ trx: { raw: jest.fn() } }) },
    entityService: { findOne: async () => ({ Slug: 'fixture', RatingCount: 10, AverageRating: 3 }), update },
  };
});
it('does not replace imported totals when a pending review is added', async () => {
  review = pending;
  await lifecycle.afterCreate({ action: 'afterCreate', result: { id: 2 } });
  expect(update).not.toHaveBeenCalled();
});
it('adds newly accepted ratings to imported totals', async () => {
  review = accepted;
  await lifecycle.afterUpdate({ action: 'afterUpdate', result: { id: 2 }, state: { previousReview: pending } });
  expect(update).toHaveBeenCalledWith('api::product.product', 1, expect.objectContaining({ data: { RatingCount: 11, AverageRating: 34 / 11 } }));
});
it('subtracts an accepted review when it returns to moderation', async () => {
  review = pending;
  await lifecycle.afterUpdate({ action: 'afterUpdate', result: { id: 2 }, state: { previousReview: accepted } });
  expect(update).toHaveBeenCalledWith('api::product.product', 1, expect.objectContaining({ data: { RatingCount: 9, AverageRating: 26 / 9 } }));
});
it('does not double count an unchanged approval', async () => {
  review = accepted;
  await lifecycle.afterUpdate({ action: 'afterUpdate', result: { id: 2 }, state: { previousReview: accepted } });
  expect(update).not.toHaveBeenCalled();
});
