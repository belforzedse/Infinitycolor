import { randomUUID } from "node:crypto";
import { makeFactories, type Factories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;
let fixtures: Factories;
let productId: number;

beforeAll(async () => { strapi = await setupStrapi(); });
afterAll(async () => { await teardownStrapi(); });
beforeEach(() => { fixtures = makeFactories(strapi); });
afterEach(async () => {
  if (productId) await strapi.db.connection("product_edit_leases").where({ product_id: productId }).delete();
  await fixtures.cleanup();
});

it("saves all selected variations through the guarded route, advances proof and rolls back a stale stock row", async () => {
  const product = await fixtures.createProduct();
  productId = product.id;
  const rows = await Promise.all([
    fixtures.createVariation({ productId, stockCount: 10 }),
    fixtures.createVariation({ productId, stockCount: 10 }),
  ]);
  const user = await fixtures.createUser();
  let role = await strapi.db.query("plugin::users-permissions.role").findOne({ where: { type: "seller-1" } });
  if (!role) role = await strapi.db.query("plugin::users-permissions.role").create({ data: { name: "Seller 1", type: "seller-1", description: "Disposable test staff" } });
  await strapi.db.query("plugin::users-permissions.user").update({ where: { id: user.id }, data: { role: role.id } });
  const sessionId = `variation-test-${user.id}`;
  // Match the compiled controller's async transaction context, just as the server does.
  const compiled = require(`${process.env.INTEGRATION_DIST_DIR}/src/utils/catalogEdit`);
  const acquisition = await compiled.changeEditLease(strapi, productId, {
    actor: { user: { id: user.id }, role: "seller1", capabilities: ["product.update"] }, sessionId,
  }, "acquire", { editorInstanceId: randomUUID() });
  const proof = {
    "x-product-edit-token": acquisition.lease.token,
    "x-product-edit-instance": acquisition.lease.editorInstanceId,
    "x-product-edit-generation": String(acquisition.lease.generation),
  };
  const middleware = require(`${process.env.INTEGRATION_DIST_DIR}/src/middlewares/catalog-edit`).default({ resource: "product" }, { strapi });
  const save = async (variation: typeof rows[number], revision: number, expectedStockRevision: number, price: number, count: number) => {
    const headers: Record<string, string> = { ...proof, "x-product-expected-revision": String(revision) };
    const ctx: any = {
      params: { id: String(productId), variationId: String(variation.id) }, query: {}, status: 200,
      state: { user: { id: user.id }, betterAuthSessionId: sessionId },
      request: { method: "PUT", headers, body: { data: { Price: price }, stock: { id: variation.stockId, Count: count, expectedStockRevision } } },
      get: (key: string) => headers[key.toLowerCase()] || "", set: jest.fn(), is: () => false,
      badRequest: (message: string) => { throw new Error(message); },
      forbidden: (message: string) => { throw new Error(message); },
      notFound: (message: string) => { throw new Error(message); },
    };
    await strapi.requestContext.run(ctx, () => middleware(ctx, () => strapi.controller("api::product.product").editorVariation(ctx)));
    return ctx;
  };

  for (const [index, variation] of rows.entries()) {
    const ctx = await save(variation, index, 0, 200 + index, 11 + index);
    expect(ctx.status).toBe(200);
    expect(ctx.body.meta.editRevision).toBe(index + 1);
    expect(ctx.body.data.revision).toBe(index + 1);
    expect(ctx.body.data.product.attributes.product_variations.data).toHaveLength(2);
    const committed = ctx.body.data.product.attributes.product_variations.data.find((row: any) => row.id === variation.id).attributes;
    expect(Number(committed.Price)).toBe(200 + index);
    expect(committed.product_stock.data.attributes).toMatchObject({ Count: 11 + index, StockRevision: 1 });
  }

  const conflict = await save(rows[0], 2, 0, 999, 15);
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.details.code).toBe("PRODUCT_STOCK_VERSION_CONFLICT");
  const unchanged = await strapi.db.query("api::product-variation.product-variation").findOne({ where: { id: rows[0].id }, populate: { product_stock: true } });
  expect(Number(unchanged.Price)).toBe(200);
  expect(unchanged.product_stock).toMatchObject({ Count: 11, StockRevision: 1 });
  expect((await strapi.db.connection("products").where({ id: productId }).first()).edit_revision).toBe(2);

  const staleProduct = await save(rows[1], 1, 1, 888, 14);
  expect(staleProduct.status).toBe(409);
  expect(staleProduct.body.error.details.code).toBe("PRODUCT_VERSION_CONFLICT");
  const resumed = await save(rows[0], 2, 1, 250, 15);
  expect(resumed.status).toBe(200);
  expect(resumed.body.meta.editRevision).toBe(3);
});
