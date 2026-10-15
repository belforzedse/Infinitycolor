/** Real authenticated catalog writes; only the local token authority and external providers are fixtures. */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories, TEST_PREFIX } from "../factories";

let strapi: any;
let f: Factories;
let apiServer: Server;
let jwksServer: Server;
let origin: string;
let issuer: string;
let privateKey: KeyLike;
let userId: number;
let roleId: number;
let catalog: any;
const sid = randomUUID();
const kid = randomUUID();
const permissions: number[] = [];
const products: number[] = [];
const apiTokens: number[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

async function request(pathname: string, data?: any, headers: Record<string, string> = {}, method?: string) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ strapi_user_id: userId, sid })
    .setProtectedHeader({ alg: "EdDSA", kid }).setIssuer(issuer).setAudience(origin)
    .setSubject(`test-staff-${userId}`).setIssuedAt(now).setNotBefore(now)
    .setExpirationTime(now + 60).setJti(randomUUID()).sign(privateKey);
  const response = await fetch(`${origin}/api${pathname}`, {
    method: method || (data === undefined ? "GET" : pathname.endsWith("/acquire") || pathname === "/products" || pathname === "/product-size-helpers" ? "POST" : "PUT"),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { status: response.status, body: await response.json() as any };
}

beforeAll(async () => {
  if ((process.env.INTEGRATION_DB_MODE || "testcontainers") !== "testcontainers") throw new Error("Catalog creation fixture requires disposable Testcontainers PostgreSQL");
  if (process.env.NODE_ENV !== "test" || process.env.DATABASE_NAME !== "infinity_test") throw new Error("Catalog write fixture refused a non-disposable database");
  apiServer = createServer();
  origin = await listen(apiServer);
  const keys = await generateKeyPair("EdDSA");
  privateKey = keys.privateKey;
  const publicKey = { ...(await exportJWK(keys.publicKey)), alg: "EdDSA", use: "sig", kid };
  jwksServer = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ keys: [publicKey] }));
  });
  issuer = await listen(jwksServer);
  Object.assign(process.env, {
    STRAPI_ENABLE_DOCUMENTATION: "false", BETTER_AUTH_BRIDGE_ENABLED: "true",
    BETTER_AUTH_ENVIRONMENT: "development", BETTER_AUTH_JWKS_URL: `${issuer}/api/auth/jwks`,
    BETTER_AUTH_JWT_ISSUER: issuer, BETTER_AUTH_JWT_AUDIENCE: origin, IS_PROXIED: "false",
  });
  jest.doMock(`${process.env.INTEGRATION_DIST_DIR}/src/utils/revalidate`, () => ({
    triggerFrontendRevalidation: jest.fn(async () => ({ attempted: 1, successful: 1, failed: 0 })),
    getFrontendUrls: jest.fn(() => []),
  }));
  strapi = await setupStrapi();
  strapi.server.mount();
  apiServer.on("request", strapi.server.app.callback());
  f = makeFactories(strapi);
  catalog = require(`${process.env.INTEGRATION_DIST_DIR}/src/utils/catalogEdit`);
  // Redis rate limiting is an external boundary; catalog guards and persistence stay real.
  const redis = await require(`${process.env.INTEGRATION_DIST_DIR}/src/index`).RedisClient;
  redis.eval = jest.fn(async () => [1, 0]);
  const role = await strapi.db.query("plugin::users-permissions.role").create({
    data: { name: "Superadmin", type: "superadmin", description: TEST_PREFIX },
  });
  roleId = role.id;
  for (const action of [
    "api::product.product.create", "api::product.product.editAcquire", "api::product.product.editSnapshot",
    "api::product.product.softDelete", "api::product.product.restore", "api::product.product.permanentDelete", "api::product.product.delete",
    "api::product.product.editRelease", "api::product.product.publication",
    "api::product.product.editorHomepage", "api::settings.settings.updateHomepageProducts",
    "api::product.product.find", "api::product.product.findOne",
    "api::product-variation.product-variation.create", "api::product-variation.product-variation.find", "api::product-variation.product-variation.findOne",
    "api::product-stock.product-stock.find", "api::product-stock.product-stock.update",
    "api::product-size-helper.product-size-helper.create", "api::product-size-helper.product-size-helper.update",
  ]) {
    const permission = await strapi.db.query("plugin::users-permissions.permission").create({ data: { action, role: roleId } });
    permissions.push(permission.id);
  }
  const user = await f.createUser();
  userId = user.id;
  await f.createUserInfo({ userId, firstName: "Catalog", lastName: "Fixture" });
  await strapi.db.query("plugin::users-permissions.user").update({ where: { id: userId }, data: { role: roleId } });
});

afterAll(async () => {
  for (const server of [apiServer, jwksServer]) {
    if (!server?.listening) continue;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (strapi) {
    if (products.length) {
      await strapi.db.connection("product_edit_leases").whereIn("product_id", products).delete();
      const logs = await strapi.db.query("api::product-log.product-log").findMany({ where: { product: { id: { $in: products } } }, select: ["id"] });
      for (const log of logs) await strapi.db.query("api::product-log.product-log").delete({ where: { id: log.id } });
    }
    for (const id of permissions) await strapi.db.query("plugin::users-permissions.permission").delete({ where: { id } });
    for (const id of apiTokens) await strapi.service("admin::api-token").revoke(id);
    await f?.cleanup();
    if (roleId) await strapi.db.query("plugin::users-permissions.role").delete({ where: { id: roleId } });
  }
  await teardownStrapi();
});

async function createProduct() {
  const title = `${TEST_PREFIX}authenticated_create_${randomUUID()}`;
  const result = await request("/products", { data: { Title: title, Status: "InActive" } });
  expect(result.status).toBe(200);
  const id = result.body.data.id;
  products.push(id);
  f.remember("api::product.product", id);
  const helper = await strapi.db.query("api::product-size-helper.product-size-helper").findOne({ where: { product: { id } }, populate: { product: true } });
  f.remember("api::product-size-helper.product-size-helper", helper.id);
  return { id, title, helper };
}

it("creates the authenticated draft with exactly one helper owned by the new product", async () => {
  const { id, title, helper } = await createProduct();
  expect(helper.product.id).toBe(id);
  expect(helper.Helper).toEqual({});
  expect(await strapi.db.query("api::product-size-helper.product-size-helper").count({ where: { product: { id } } })).toBe(1);
  expect(await strapi.db.connection("products").where({ id }).first()).toMatchObject({ title, status: "InActive", edit_revision: 1 });
});

it("updates the variation's single auto-created stock under its lease before publishing", async () => {
  const { id } = await createProduct();
  const claim = await request(`/products/${id}/edit-lease/acquire`, { editorInstanceId: randomUUID() });
  expect(claim.status).toBe(200);
  const { lease, snapshot } = claim.body.data;
  const initialRevision = snapshot.revision;
  let revision = initialRevision;
  const headers = () => ({
    "X-Product-Edit-Token": lease.token, "X-Product-Edit-Instance": lease.editorInstanceId,
    "X-Product-Edit-Generation": String(lease.generation), "X-Product-Expected-Revision": String(revision),
  });
  try {
    const variation = await request("/product-variations", {
      data: { product: id, SKU: `${TEST_PREFIX}auto_stock_${randomUUID()}`, Price: 250000, IsPublished: false },
    }, headers(), "POST");
    expect([variation.status, variation.body.error]).toEqual([200, undefined]);
    const variationId = variation.body.data.id;
    f.remember("api::product-variation.product-variation", variationId);
    revision = variation.body.meta.editRevision;
    expect(revision).toBe(initialRevision + 1);

    const stockQuery = new URLSearchParams({
      "filters[product_variation][id][$eq]": String(variationId), "populate": "product_variation",
    });
    const stocks = await request(`/product-stocks?${stockQuery}`);
    expect(stocks.status).toBe(200);
    expect(stocks.body.data).toHaveLength(1);
    const stock = stocks.body.data[0];
    f.remember("api::product-stock.product-stock", stock.id);
    expect(stock.attributes).toMatchObject({ Count: 0, StockRevision: 0 });
    expect(stock.attributes.product_variation.data.id).toBe(variationId);

    const updated = await request(`/product-stocks/${stock.id}`, { data: { Count: 12 } }, {
      ...headers(), "X-Product-Expected-Stock-Revision": "0",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.id).toBe(stock.id);
    expect(updated.body.data.attributes).toMatchObject({ Count: 12, StockRevision: 1 });
    revision = updated.body.meta.editRevision;
    expect(revision).toBe(initialRevision + 2);

    const published = await request(`/products/${id}/publication`, { data: { action: "publish-now" } }, headers(), "POST");
    expect(published.status).toBe(200);
    revision = published.body.meta.editRevision;
    expect(revision).toBe(initialRevision + 3);
    const saved = await request(`/products/${id}/edit-snapshot`);
    expect(saved.status).toBe(200);
    expect(saved.body.data.revision).toBe(revision);
    expect(saved.body.data.product.attributes.Status).toBe("Active");
    const variations = saved.body.data.product.attributes.product_variations.data;
    expect(variations).toHaveLength(1);
    expect(variations[0].id).toBe(variationId);
    expect(variations[0].attributes.IsPublished).toBe(true);
    expect(variations[0].attributes.product_stock.data).toMatchObject({ id: stock.id, attributes: { Count: 12, StockRevision: 1 } });
    const finalStocks = await request(`/product-stocks?${stockQuery}`);
    expect(finalStocks.status).toBe(200);
    expect(finalStocks.body.data).toHaveLength(1);
    expect(finalStocks.body.data[0]).toMatchObject({ id: stock.id, attributes: { Count: 12, StockRevision: 1 } });
  } finally {
    const released = await request(`/products/${id}/edit-lease/release`, { data: {} }, headers(), "POST");
    expect(released.status).toBe(200);
    expect(released.body.data).toEqual({ released: true });
  }
  expect((await strapi.db.connection("product_edit_leases").where({ product_id: id }).first()).owner_id).toBeNull();
});

it("rolls back the product, initial helper and edit coordination when initialization fails", async () => {
  const title = `${TEST_PREFIX}rolled_back_create_${randomUUID()}`;
  let failedId: number;
  let helperId: number;
  const create = strapi.entityService.create.bind(strapi.entityService);
  const spy = jest.spyOn(strapi.entityService, "create").mockImplementation(async (uid: string, args: any) => {
    const result = await create(uid, args);
    if (uid === "api::product-size-helper.product-size-helper") {
      const context = catalog.catalogMutationContext();
      failedId = args.data.product;
      helperId = result.id;
      expect(context.ids).toEqual([failedId]);
      expect(context.writer).toEqual({ kind: "system", command: "catalog-initialization" });
      expect(strapi.db.inTransaction()).toBe(true);
      throw new Error("injected initial helper failure");
    }
    return result;
  });
  try {
    expect((await request("/products", { data: { Title: title } })).status).toBe(500);
  } finally { spy.mockRestore(); }
  expect(failedId!).toBeGreaterThan(0);
  expect(await strapi.db.connection("products").where({ id: failedId! }).first()).toBeUndefined();
  expect(await strapi.db.connection("product_size_helpers").where({ id: helperId! }).first()).toBeUndefined();
  expect(await strapi.db.connection("product_edit_leases").where({ product_id: failedId! }).first()).toBeUndefined();
  expect(await strapi.db.query("api::product-log.product-log").count({ where: { product: { id: failedId! } } })).toBe(0);
});

it("keeps subsequent child writes lease/revision guarded and cannot claim an existing helper on creation", async () => {
  const { id, helper } = await createProduct();
  const missing = await request(`/product-size-helpers/${helper.id}`, { data: { Helper: { invalid: true } } });
  expect(missing.status).toBe(409);
  expect(missing.body.error.details.code).toBe("EDIT_LEASE_LOST");
  const child = await request("/product-size-helpers", { data: { product: id, Helper: {} } });
  expect(child.status).toBe(409);
  expect(child.body.error.details.code).toBe("EDIT_LEASE_LOST");
  const hijack = await request("/products", { data: { Title: `${TEST_PREFIX}helper_hijack_${randomUUID()}`, product_size_helper: helper.id } });
  expect(hijack.status).toBe(400);
  const ctx = { state: { user: { id: userId }, betterAuthSessionId: sid } };
  await expect(strapi.requestContext.run(ctx, () => strapi.db.query("api::product-size-helper.product-size-helper").update({ where: { id: helper.id }, data: { Helper: { invalid: true } } }))).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
  await expect(strapi.requestContext.run(ctx, () => strapi.db.query("api::product-faq.product-faq").create({ data: { Title: "unguarded FAQ", product: id } }))).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
  const claim = await request(`/products/${id}/edit-lease/acquire`, { editorInstanceId: randomUUID() });
  expect(claim.status).toBe(200);
  const { lease, snapshot } = claim.body.data;
  expect(snapshot.revision).toBe(1);
  const headers = {
    "X-Product-Edit-Token": lease.token, "X-Product-Edit-Instance": lease.editorInstanceId,
    "X-Product-Edit-Generation": String(lease.generation), "X-Product-Expected-Revision": String(snapshot.revision),
  };
  const saved = await request(`/product-size-helpers/${helper.id}`, { data: { Helper: { sizes: ["M"] } } }, headers);
  expect(saved.status).toBe(200);
  expect(saved.body.meta.editRevision).toBe(2);
  const stale = await request(`/product-size-helpers/${helper.id}`, { data: { Helper: { sizes: ["L"] } } }, headers);
  expect(stale.status).toBe(409);
  expect(stale.body.error.details.code).toBe("PRODUCT_VERSION_CONFLICT");
  expect((await strapi.db.query("api::product-size-helper.product-size-helper").findOne({ where: { id: helper.id }, populate: { product: true } })).product.id).toBe(id);
  expect((await strapi.db.query("api::product-size-helper.product-size-helper").findOne({ where: { id: helper.id } })).Helper).toEqual({ sizes: ["M"] });
});

it("serializes authenticated permanent deletion and preserves idempotency and purged restore errors", async () => {
  const { id } = await createProduct();
  expect((await request(`/products/${id}/soft-delete`, { data: {} }, {}, "POST")).status).toBe(200);
  const before = await strapi.db.connection("products").where({ id }).first();
  const purges = await Promise.all([1, 2].map(() => request(`/products/${id}/permanent-delete`, { data: {} }, {}, "POST")));
  expect(purges.map((result) => result.status)).toEqual([200, 200]);
  expect(purges.map((result) => result.body.data.unchanged).sort()).toEqual([false, true]);
  const repeated = await request(`/products/${id}/permanent-delete`, { data: {} }, {}, "POST");
  expect(repeated.status).toBe(200);
  expect(repeated.body.data).toMatchObject({ state: "purged", unchanged: true });
  expect((await strapi.db.connection("products").where({ id }).first()).edit_revision).toBe(Number(before.edit_revision) + 1);
  expect(await strapi.db.connection("manual_admin_activities").where({ target_id: String(id), event_key: "products.permanently_deleted" })).toHaveLength(1);
  expect(await strapi.db.connection("manual_admin_activities").where({ target_id: String(id), event_key: "products.edit_committed" })).toHaveLength(2);
  expect(await strapi.db.query("api::product-log.product-log").count({ where: { product: { id }, Action: "PermanentDelete" } })).toBe(1);
  const restore = await request(`/products/${id}/restore`, { data: {} }, {}, "POST");
  expect(restore.status).toBe(409);
  expect(restore.body.error.details.code).toBe("PRODUCT_PURGED");
  const genericDelete = await request(`/products/${id}`, undefined, {
    "X-Product-Edit-Token": Buffer.alloc(32).toString("base64url"),
    "X-Product-Edit-Instance": randomUUID(), "X-Product-Edit-Generation": "1", "X-Product-Expected-Revision": "0",
  }, "DELETE");
  expect(genericDelete.status).toBe(404);
  expect(genericDelete.body.error.details.code).toBe("PRODUCT_NOT_FOUND");
  const missing = await request("/products/2147483647/permanent-delete", { data: {} }, {}, "POST");
  expect(missing.status).toBe(404);
  expect(missing.body.error.details.code).toBe("PRODUCT_NOT_FOUND");
});

it("keeps active edit leases fenced for authenticated transient lifecycle commands", async () => {
  const { id } = await createProduct();
  const claim = await request(`/products/${id}/edit-lease/acquire`, { editorInstanceId: randomUUID() });
  expect(claim.status).toBe(200);
  const trash = await request(`/products/${id}/soft-delete`, { data: {} }, {}, "POST");
  expect(trash.status).toBe(409);
  expect(trash.body.error.details.code).toBe("EDIT_LEASE_CONFLICT");
  expect((await strapi.db.connection("products").where({ id }).first()).removed_at).toBeNull();
});

it("retains authentication and capability denials on all single lifecycle routes", async () => {
  const { id } = await createProduct();
  const paths = ["soft-delete", "restore", "permanent-delete"].map((action) => `/products/${id}/${action}`);
  for (const pathname of paths) {
    const anonymous = await fetch(`${origin}/api${pathname}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: {} }),
    });
    expect(anonymous.status).toBe(403);
    const invalidToken = await fetch(`${origin}/api${pathname}`, {
      method: "POST", headers: { Authorization: "Bearer invalid-test-token", "Content-Type": "application/json" }, body: JSON.stringify({ data: {} }),
    });
    expect(invalidToken.status).toBe(401);
  }
  const customerRole = await strapi.db.query("plugin::users-permissions.role").findOne({ where: { type: "authenticated" } });
  expect(customerRole).toBeTruthy();
  await strapi.db.query("plugin::users-permissions.user").update({ where: { id: userId }, data: { role: customerRole.id } });
  try {
    for (const pathname of paths) expect((await request(pathname, { data: {} }, {}, "POST")).status).toBe(403);
  } finally {
    await strapi.db.query("plugin::users-permissions.user").update({ where: { id: userId }, data: { role: roleId } });
  }
  expect(await strapi.db.connection("products").where({ id }).first()).toMatchObject({ status: "InActive", removed_at: null, purged_at: null, edit_revision: 1 });
});

it("preserves authorized API-token lifecycle commands and denies restricted tokens", async () => {
  const service = strapi.service("admin::api-token");
  const full = await service.create({ name: `${TEST_PREFIX}catalog_full_${randomUUID()}`, description: TEST_PREFIX, type: "full-access", lifespan: null });
  const restricted = await service.create({ name: `${TEST_PREFIX}catalog_read_${randomUUID()}`, description: TEST_PREFIX, type: "read-only", lifespan: null });
  const custom = await service.create({ name: `${TEST_PREFIX}catalog_custom_${randomUUID()}`, description: TEST_PREFIX, type: "custom", permissions: ["api::product.product.find"], lifespan: null });
  apiTokens.push(full.id, restricted.id, custom.id);
  const { id } = await createProduct();
  const call = async (action: string, token: string) => {
    const response = await fetch(`${origin}/api/products/${id}/${action}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ data: {} }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  for (const token of [restricted, custom]) {
    for (const action of ["soft-delete", "restore", "permanent-delete"]) expect((await call(action, token.accessKey)).status).toBe(403);
  }
  expect((await call("soft-delete", full.accessKey)).status).toBe(200);
  const purge = await call("permanent-delete", full.accessKey);
  expect(purge.status).toBe(200);
  expect(purge.body.data.unchanged).toBe(false);
  const before = await strapi.db.connection("products").where({ id }).first();
  const repeat = await call("permanent-delete", full.accessKey);
  expect(repeat.status).toBe(200);
  expect(repeat.body.data.unchanged).toBe(true);
  expect((await strapi.db.connection("products").where({ id }).first()).edit_revision).toBe(before.edit_revision);
  const restore = await call("restore", full.accessKey);
  expect(restore.status).toBe(409);
  expect(restore.body.error.details.code).toBe("PRODUCT_PURGED");
});

describe("authenticated homepage settings writes on the declared PostgreSQL table", () => {
  let settingsId: number;
  let previousHomepage: Record<string, unknown>;
  const homepageDefaults = {
    homeNewestProductIds: [], homeFavoriteProductIds: [], homeDiscountedProductIds: [],
    homeWeeklyPicksProductIds: [], homeEveryoneFollowsProductIds: [],
    homeWeeklyPicksEnabled: false, homeEveryoneFollowsEnabled: false, HomepageProductsRevision: 0,
  };

  beforeEach(async () => {
    expect(strapi.db.metadata.get("api::settings.settings").tableName).toBe("site_settings");
    expect(await strapi.db.connection.schema.hasTable("site_settings")).toBe(true);
    expect(await strapi.db.connection.schema.hasTable("settings")).toBe(false);
    const query = strapi.db.query("api::settings.settings");
    const existing = await query.findOne({ where: {}, orderBy: { id: "asc" } });
    if (existing) {
      settingsId = existing.id;
      previousHomepage = Object.fromEntries(Object.keys(homepageDefaults).map((field) => [field, existing[field]]));
      await query.update({ where: { id: settingsId }, data: { ...homepageDefaults } });
    } else {
      settingsId = (await query.create({ data: { ...homepageDefaults } })).id;
    }
  });

  afterEach(async () => {
    if (settingsId) {
      const query = strapi.db.query("api::settings.settings");
      if (previousHomepage) {
        await query.update({ where: { id: settingsId }, data: { ...previousHomepage } });
        const restored = await query.findOne({ where: { id: settingsId } });
        expect(Object.fromEntries(Object.keys(homepageDefaults).map((field) => [field, restored[field]]))).toEqual(previousHomepage);
      } else {
        await query.delete({ where: { id: settingsId } });
      }
    }
    settingsId = undefined;
    previousHomepage = undefined;
  });

  const settingsRow = () => strapi.db.query("api::settings.settings").findOne({ where: { id: settingsId } });

  it("saves global membership, ordering and toggles and rolls back stale revisions", async () => {
    const first = await createProduct();
    const second = await createProduct();
    const productRows = () => strapi.db.connection("products").whereIn("id", [first.id, second.id]).orderBy("id").select("id", "edit_revision");
    const leaseRows = () => strapi.db.connection("product_edit_leases").whereIn("product_id", [first.id, second.id]).orderBy("product_id");
    const save = (data: any, expectedRevision: number) => request("/settings/homepage-products", { data, expectedRevision });

    const membership = await save({ homeNewestProductIds: [first.id, second.id], homeWeeklyPicksEnabled: true }, 0);
    expect([membership.status, membership.body.error]).toEqual([200, undefined]);
    expect(membership.body.data.attributes).toMatchObject({ homeNewestProductIds: [first.id, second.id], homeWeeklyPicksEnabled: true, HomepageProductsRevision: 1 });
    expect(await settingsRow()).toMatchObject({ homeNewestProductIds: [first.id, second.id], homeWeeklyPicksEnabled: true, HomepageProductsRevision: 1 });
    expect(await productRows()).toEqual([{ id: first.id, edit_revision: 2 }, { id: second.id, edit_revision: 2 }]);

    const reorder = await save({ homeNewestProductIds: [second.id, first.id] }, 1);
    expect([reorder.status, reorder.body.error]).toEqual([200, undefined]);
    expect(reorder.body.data.attributes.HomepageProductsRevision).toBe(2);
    expect(await settingsRow()).toMatchObject({ homeNewestProductIds: [second.id, first.id], HomepageProductsRevision: 2 });

    const toggle = await save({ homeWeeklyPicksEnabled: false }, 2);
    expect([toggle.status, toggle.body.error]).toEqual([200, undefined]);
    expect(toggle.body.data.attributes.HomepageProductsRevision).toBe(3);
    expect(await settingsRow()).toMatchObject({ homeNewestProductIds: [second.id, first.id], homeWeeklyPicksEnabled: false, HomepageProductsRevision: 3 });
    expect(await productRows()).toEqual([{ id: first.id, edit_revision: 2 }, { id: second.id, edit_revision: 2 }]);

    const before = { settings: await settingsRow(), products: await productRows(), leases: await leaseRows() };
    const stale = await save({ homeNewestProductIds: [first.id], homeWeeklyPicksEnabled: true }, 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error.details.code).toBe("HOMEPAGE_VERSION_CONFLICT");
    expect({ settings: await settingsRow(), products: await productRows(), leases: await leaseRows() }).toEqual(before);
  });

  it("adds and removes homepage membership through the product editor with both revisions", async () => {
    const product = await createProduct();
    const other = await createProduct();
    await strapi.db.query("api::settings.settings").update({ where: { id: settingsId }, data: {
      homeNewestProductIds: [other.id], homeDiscountedProductIds: [product.id, other.id],
      homeWeeklyPicksProductIds: [other.id], homeWeeklyPicksEnabled: true,
    } });
    const claim = await request(`/products/${product.id}/edit-lease/acquire`, { editorInstanceId: randomUUID() });
    expect([claim.status, claim.body.error]).toEqual([200, undefined]);
    const { lease, snapshot } = claim.body.data;
    let revision = snapshot.revision;
    const save = (data: any) => request(`/products/${product.id}/editor/homepage`, { data }, {
      "X-Product-Edit-Token": lease.token, "X-Product-Edit-Instance": lease.editorInstanceId,
      "X-Product-Edit-Generation": String(lease.generation), "X-Product-Expected-Revision": String(revision),
    });

    const added = await save({ homeNewestProductIds: true, homeFavoriteProductIds: true, homeDiscountedProductIds: false });
    expect([added.status, added.body.error]).toEqual([200, undefined]);
    expect(added.body.meta).toMatchObject({ editRevision: snapshot.revision + 1, homepageProductsRevision: 1 });
    expect(await settingsRow()).toMatchObject({
      homeNewestProductIds: [product.id, other.id], homeFavoriteProductIds: [product.id],
      homeDiscountedProductIds: [other.id], homeWeeklyPicksProductIds: [other.id],
      homeWeeklyPicksEnabled: true, HomepageProductsRevision: 1,
    });

    revision = added.body.meta.editRevision;
    const removed = await save({ homeNewestProductIds: false, homeFavoriteProductIds: false });
    expect([removed.status, removed.body.error]).toEqual([200, undefined]);
    expect(removed.body.meta).toMatchObject({ editRevision: snapshot.revision + 2, homepageProductsRevision: 2 });
    expect(await settingsRow()).toMatchObject({
      homeNewestProductIds: [other.id], homeFavoriteProductIds: [], homeDiscountedProductIds: [other.id],
      homeWeeklyPicksProductIds: [other.id], homeWeeklyPicksEnabled: true, HomepageProductsRevision: 2,
    });
    expect(await strapi.db.connection("products").where({ id: product.id }).first()).toMatchObject({ edit_revision: snapshot.revision + 2 });
    expect(await strapi.db.connection("products").where({ id: other.id }).first()).toMatchObject({ edit_revision: 1 });
  });

  it("repairs a missing homepage revision column on site_settings idempotently", async () => {
    const { ensureCatalogEditStorage } = require("../../../../database/catalog-edit-storage");
    // DDL stays inside a rolled-back transaction on this disposable test DB.
    const trx = await strapi.db.connection.transaction();
    try {
      await trx.schema.alterTable("site_settings", (table: any) => table.dropColumn("homepage_products_revision"));
      expect(await trx.schema.hasColumn("site_settings", "homepage_products_revision")).toBe(false);
      await ensureCatalogEditStorage(trx);
      expect(await trx.schema.hasColumn("site_settings", "homepage_products_revision")).toBe(true);
      expect(await trx("site_settings").where({ id: settingsId }).first()).toMatchObject({ homepage_products_revision: 0 });
      await trx("site_settings").where({ id: settingsId }).update({ homepage_products_revision: 7 });
      await ensureCatalogEditStorage(trx);
      expect(await trx("site_settings").where({ id: settingsId }).first()).toMatchObject({ homepage_products_revision: 7 });
      expect(await trx.schema.hasTable("settings")).toBe(false);
    } finally {
      await trx.rollback();
    }
  });
});
