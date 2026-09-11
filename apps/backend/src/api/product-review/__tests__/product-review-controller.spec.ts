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
  query = { findOne: jest.fn(async () => existing), findMany: jest.fn(async () => []) };
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
it('names review and reply authors that sanitization stripped from the payload', async () => {
  mockCoreFind.mockResolvedValue({
    data: [
      {
        id: 11,
        attributes: {
          Content: 'Great',
          product_review_replies: { data: [{ id: 21, attributes: { Content: 'Thanks' } }] },
        },
      },
      { id: 12, attributes: { Content: 'Nameless' } },
    ],
  });
  query.findMany.mockResolvedValue([
    {
      id: 11,
      user: { id: 5, user_info: { FirstName: 'کیمبرلی', LastName: 'نوروزی' } },
      product_review_replies: [{ id: 21, user: { id: 6, Phone: '09123456789' } }],
    },
    { id: 12, user: null, product_review_replies: [] },
  ]);

  const result = await controller.find({ state: {}, query: {} });

  expect(query.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: { $in: [11, 12] } } }),
  );
  expect(result.data[0].attributes.authorDisplayName).toBe('کیمبرلی نوروزی');
  // Name-only stand-in for the stripped relation, so storefront builds released
  // before `authorDisplayName` still render the name. No id/phone/email/username.
  expect(result.data[0].attributes.user).toEqual({
    data: {
      id: null,
      attributes: {
        user_info: { data: { attributes: { FirstName: 'کیمبرلی نوروزی', LastName: null } } },
      },
    },
  });
  expect(result.data[1].attributes.user).toBeUndefined();
  expect(result.data[0].attributes.product_review_replies.data[0].attributes.authorDisplayName)
    .toBe('0912***6789');
  expect(result.data[1].attributes.authorDisplayName).toBe('کاربر ناشناس');
});
it('leaves a privileged caller\'s real user relation untouched', async () => {
  const realUser = { data: { id: 5, attributes: { phone: '09123456789', username: 'kim' } } };
  mockCoreFind.mockResolvedValue({ data: [{ id: 11, attributes: { Content: 'Great', user: realUser } }] });
  query.findMany.mockResolvedValue([
    { id: 11, user: { id: 5, user_info: { FirstName: 'کیمبرلی', LastName: 'نوروزی' } } },
  ]);

  const result = await controller.find({ state: {}, query: {} });

  expect(result.data[0].attributes.user).toBe(realUser);
  expect(result.data[0].attributes.authorDisplayName).toBe('کیمبرلی نوروزی');
});
it('still returns the listing when author name resolution fails', async () => {
  mockCoreFind.mockResolvedValue({ data: [{ id: 11, attributes: { Content: 'Great' } }] });
  query.findMany.mockRejectedValue(new Error('db down'));

  const result = await controller.find({ state: {}, query: {} });

  expect(result.data[0].attributes.Content).toBe('Great');
  expect(mockStrapi.log.error).toHaveBeenCalled();
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
