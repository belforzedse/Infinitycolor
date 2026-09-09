let mockStrapi: any;
let mockCoreFind: jest.Mock;
jest.mock('@strapi/strapi', () => ({
  factories: {
    createCoreController: (_uid, factory) => {
      const controller = factory({ strapi: mockStrapi });
      Object.setPrototypeOf(controller, {
        find: (...args) => mockCoreFind(...args),
      });
      return controller;
    },
  },
}));
jest.mock('../../../utils/roles', () => ({ resolveCustomerTargetUserId: jest.fn(async () => 7) }));
jest.mock('../../../utils/operationalCommerce', () => ({ enforceOperationalDataFields: jest.fn(async () => true) }));

const existing = { id: 2, Rate: 3, Content: 'Original accepted review', Status: 'Accepted' };
let controller: any;
let query: any;
const ctx = (body = {}) => ({ request: { body }, badRequest: jest.fn(), notFound: jest.fn(), internalServerError: jest.fn() });
beforeEach(() => {
  jest.resetModules();
  mockCoreFind = jest.fn(async () => ({ data: [] }));
  query = { findOne: jest.fn(async () => existing) };
  mockStrapi = {
    db: { query: () => query, transaction: async callback => callback({ trx: { raw: jest.fn() } }) },
    entityService: { findOne: jest.fn(async () => ({ id: 1, Status: 'Active' })), update: jest.fn(async (_uid, id, options) => ({ id, ...options.data })), create: jest.fn(async (_uid, options) => ({ id: 3, ...options.data })) },
    log: { error: jest.fn() },
  };
  controller = require('../controllers/product-review').default;
});
it('uses the null operator when restricting public review listings', async () => {
  const requestedFilters = { product: { id: { $eq: '1569' } } };
  const context = {
    state: {},
    query: { filters: requestedFilters },
  };

  await controller.find(context);

  expect(context.query.filters).toEqual({
    $and: [
      requestedFilters,
      { Status: 'Accepted', removedAt: { $null: true } },
    ],
  });
  expect(mockCoreFind).toHaveBeenCalledWith(context);
});
it('returns edited reviews to moderation and ignores caller supplied status/identity', async () => {
  const result = await controller.submitReview(ctx({ productId: 1, rate: 5, content: 'Updated customer review', Status: 'Accepted', user: 9 }));
  expect(result).toMatchObject({ id: 2, Rate: 5, Status: 'Need for Review' });
  expect(mockStrapi.entityService.update.mock.calls[0][2].data).not.toHaveProperty('user');
});
it('leaves unchanged accepted retries untouched', async () => {
  const result = await controller.submitReview(ctx({ productId: 1, rate: 3, content: existing.Content }));
  expect(result.Status).toBe('Accepted');
  expect(mockStrapi.entityService.update).not.toHaveBeenCalled();
});
it.each([{ rate: 6 }, { rate: 1.5 }, { rate: '5' }, { content: ' ' }, { content: 'x'.repeat(4001) }, { productId: -1 }])('rejects malformed input before writing', async patch => {
  const context = ctx({ productId: 1, rate: 5, content: 'Valid review content', ...patch });
  await controller.submitReview(context);
  expect(context.badRequest).toHaveBeenCalled();
  expect(mockStrapi.entityService.create).not.toHaveBeenCalled();
  expect(mockStrapi.entityService.update).not.toHaveBeenCalled();
});
it('creates a pending review owned by the authenticated customer', async () => {
  query.findOne.mockResolvedValue(null);
  const result = await controller.submitReview(ctx({ productId: 1, rate: 4, content: 'Valid review content' }));
  expect(result).toMatchObject({ user: 7, product: 1, Status: 'Need for Review', isNew: true });
});
