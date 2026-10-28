import { randomUUID } from "node:crypto";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories } from "../factories";
import {
  buildMediaLibraryPageQuery,
  buildMediaLibraryUsageQuery,
  groupUsageRows,
  rowsFromRaw,
} from "../../../api/admin-media-library/lib/media-library-query";

const PRODUCT = "api::product.product";
const COLOR = "api::product-variation-color.product-variation-color";
let strapi: any;
let f: Factories;
let guard: any;
let galleries: any;
let ownership: any;
let snapshots: any;
let products: number[] = [];
let colors: number[] = [];
let files: any[] = [];

// Cold Strapi boot creates the native admin's permissions for the entire catalogue.
// On Windows this can exceed the shared four-minute hook timeout.
beforeAll(async () => {
  strapi = await setupStrapi();
  const root = process.env.INTEGRATION_DIST_DIR;
  guard = require(root + "/src/utils/catalogEdit");
  galleries = require(root + "/src/api/product/services/product-color-galleries");
  ownership = require(root + "/src/utils/catalogOwnership");
  snapshots = require(root + "/src/api/product/services/product-editor-snapshot");
}, 600_000);
afterAll(async () => {
  await teardownStrapi();
});
beforeEach(() => {
  f = makeFactories(strapi);
  products = [];
  colors = [];
  files = [];
});
afterEach(async () => {
  if (!strapi || !f) return;
  for (const id of products) await save(id, { ColorGalleries: [] });
  await f.cleanup();
  for (const file of files)
    await strapi.db.query("plugin::upload.file").delete({ where: { id: file.id } });
  for (const id of colors) await strapi.db.query(COLOR).delete({ where: { id } });
});

async function fixture() {
  const product = await f.createProduct({ title: "JEST_TEST__gallery_" + randomUUID() });
  products.push(product.id);
  const variation = await f.createVariation({
    productId: product.id,
    stockCount: 10,
    price: 12345,
  });
  for (const title of ["red", "blue"]) {
    const color = await strapi.db
      .query(COLOR)
      .create({
        data: { Title: "JEST_TEST__" + title, ColorCode: title === "red" ? "#ff0000" : "#0000ff" },
      });
    colors.push(color.id);
  }
  for (let i = 0; i < 3; i++)
    files.push(
      await strapi.db.query("plugin::upload.file").create({
        data: {
          name: "JEST_TEST__gallery_" + i + ".jpg",
          hash: randomUUID(),
          ext: ".jpg",
          mime: "image/jpeg",
          size: 1,
          url: "/uploads/JEST_TEST__gallery_" + i + ".jpg",
          provider: "local",
        },
      }),
    );
  return { product, variation };
}

// Same transaction, attachment locks and component validation as the guarded editor.
async function save(id: number, data: any) {
  return guard.runCatalogSystemMutation(strapi, [id], "fixture", async () => {
    if (data.ColorGalleries !== undefined) {
      await galleries.captureColorGalleriesBefore(strapi, id);
      await galleries.validateColorGalleriesInput(strapi, data.ColorGalleries, id);
    }
    await ownership.validateProductOwnedRelations(strapi, id, data);
    await strapi.entityService.update(PRODUCT, id, { data });
    return snapshots.loadEditorSnapshot(strapi, id);
  });
}

const mapping = () => [
  { color: colors[0], Images: [files[1].id, files[0].id] },
  { color: colors[1], Images: [files[1].id, files[2].id] },
];

it("saves and reopens ordered galleries per product/color without changing variation price, stock or SKU", async () => {
  const { product, variation } = await fixture();
  const before = await strapi.entityService.findOne(
    "api::product-variation.product-variation",
    variation.id,
    { populate: { product_stock: true } },
  );
  await save(product.id, { ColorGalleries: mapping() });
  const loaded = await snapshots.loadEditorSnapshot(strapi, product.id);
  const result = loaded.product.attributes.ColorGalleries;
  expect(result.map((row: any) => row.color.data.id)).toEqual(colors);
  expect(result[0].Images.data.map((row: any) => row.id)).toEqual([files[1].id, files[0].id]);
  expect(result[1].Images.data.map((row: any) => row.id)).toEqual([files[1].id, files[2].id]);
  const after = await strapi.entityService.findOne(
    "api::product-variation.product-variation",
    variation.id,
    { populate: { product_stock: true } },
  );
  expect(after).toEqual(before);
});

it("persists a reorder on existing components and records its before/after values", async () => {
  const { product } = await fixture();
  const first = await save(product.id, { ColorGalleries: mapping() });
  const rows = first.product.attributes.ColorGalleries;
  await save(product.id, {
    ColorGalleries: rows.map((row: any, index: number) => ({
      id: row.id,
      color: row.color.data.id,
      Images:
        index === 0 ? [files[0].id, files[1].id] : row.Images.data.map((image: any) => image.id),
    })),
  });
  const reopened = await snapshots.loadEditorSnapshot(strapi, product.id);
  expect(reopened.product.attributes.ColorGalleries[0].id).toBe(rows[0].id);
  expect(
    reopened.product.attributes.ColorGalleries[0].Images.data.map((row: any) => row.id),
  ).toEqual([files[0].id, files[1].id]);
  const logs = await strapi.db
    .query("api::product-log.product-log")
    .findMany({ where: { product: product.id, Action: "Update" }, orderBy: { id: "desc" } });
  const changes = logs[0].Changes.ColorGalleries;
  expect(changes.from[0].Images.map((row: any) => row.id)).toEqual([files[1].id, files[0].id]);
  expect(changes.to[0].Images.map((row: any) => row.id)).toEqual([files[0].id, files[1].id]);
});

it("preserves galleries on unrelated edits and supports clearing them", async () => {
  const { product } = await fixture();
  const first = await save(product.id, { ColorGalleries: mapping() });
  const edited = await save(product.id, { Title: "JEST_TEST__new title" });
  expect(edited.product.attributes.ColorGalleries).toEqual(first.product.attributes.ColorGalleries);
  expect(
    (await save(product.id, { ColorGalleries: [] })).product.attributes.ColorGalleries,
  ).toEqual([]);
});

it("rejects component IDs belonging to a different product", async () => {
  const { product } = await fixture();
  const first = await save(product.id, { ColorGalleries: mapping() });
  const other = await f.createProduct();
  products.push(other.id);
  await expect(
    save(other.id, {
      ColorGalleries: [{ id: first.product.attributes.ColorGalleries[0].id, ...mapping()[0] }],
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PARENT_CHANGE_FORBIDDEN" });
  expect(
    (await snapshots.loadEditorSnapshot(strapi, other.id)).product.attributes.ColorGalleries,
  ).toEqual([]);
});

it("keeps color-only media in the library, deduplicates product usage and prevents deletion/replacement", async () => {
  const { product } = await fixture();
  await save(product.id, { ColorGalleries: mapping() });
  const query = buildMediaLibraryPageQuery(
    { type: "image", usage: "attached", searchVariants: [product.Title] },
    1,
    60,
  );
  expect(
    rowsFromRaw(await strapi.db.connection.raw(query.sql, query.bindings)).map(
      (row: any) => row.id,
    ),
  ).toEqual(expect.arrayContaining(files.map((file) => file.id)));
  const usage = buildMediaLibraryUsageQuery([files[1].id]);
  const grouped = groupUsageRows(
    rowsFromRaw(await strapi.db.connection.raw(usage.sql, usage.bindings)),
  );
  expect(grouped.get(files[1].id)?.productCount).toBe(1);
  const upload = strapi.plugin("upload").service("upload");
  await expect(upload.remove(files[1])).rejects.toMatchObject({ code: "PRODUCT_MEDIA_IN_USE" });
  await expect(upload.replace(files[1].id, { data: {}, file: {} })).rejects.toMatchObject({
    code: "PRODUCT_MEDIA_IN_USE",
  });
});

it.each(["replace", "clear", "append"])("preserves galleries and revision when a native %s edit lacks a lease", async (operation) => {
  const { product } = await fixture();
  await save(product.id, { ColorGalleries: mapping() });
  const before = await snapshots.loadEditorSnapshot(strapi, product.id);
  const rows = before.product.attributes.ColorGalleries;
  const existing = rows.map((row: any) => ({
    id: row.id, color: row.color.data.id, Images: row.Images.data.map((image: any) => image.id),
  }));
  const ColorGalleries = operation === "clear" ? []
    : operation === "replace" ? existing.map((row: any, index: number) => index === 0 ? { ...row, Images: [files[2].id] } : row)
    : [...existing, { color: colors[0], Images: [files[2].id] }];
  const ctx = { state: { user: { id: 99999 } } };
  await expect(strapi.requestContext.run(ctx, () => strapi.entityService.update(PRODUCT, product.id, {
    data: { Title: "JEST_TEST__rejected edit", ColorGalleries },
  }))).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
  expect(await snapshots.loadEditorSnapshot(strapi, product.id)).toEqual(before);
});

it("saves galleries through the human editor route and rejects stale revision proof", async () => {
  const { product } = await fixture();
  await save(product.id, { ColorGalleries: mapping() });
  const before = await snapshots.loadEditorSnapshot(strapi, product.id);
  const user = await f.createUser();
  let role = await strapi.db.query("plugin::users-permissions.role").findOne({ where: { type: "seller-1" } });
  if (!role) role = await strapi.db.query("plugin::users-permissions.role").create({ data: { name: "Seller 1", type: "seller-1", description: "Disposable test staff" } });
  await strapi.db.query("plugin::users-permissions.user").update({ where: { id: user.id }, data: { role: role.id } });
  const editor = { actor: { user: { id: user.id }, role: "seller1", capabilities: ["product.update", "product.media.manage"] }, sessionId: `test-gallery-staff-${user.id}` };
  const acquired = await guard.changeEditLease(strapi, product.id, editor, "acquire", { editorInstanceId: randomUUID() });
  const headers: Record<string, string> = {
    "x-product-edit-token": acquired.lease.token,
    "x-product-edit-instance": acquired.lease.editorInstanceId,
    "x-product-edit-generation": String(acquired.lease.generation),
    "x-product-expected-revision": String(before.revision),
  };
  const makeCtx = () => ({
    params: { id: String(product.id) }, query: {}, status: 200, body: undefined as any,
    state: { user: { id: user.id }, betterAuthSessionId: editor.sessionId },
    request: { method: "PUT", headers, body: { data: { ColorGalleries: [] } } },
    get: (key: string) => headers[key.toLowerCase()] || "", set: jest.fn(), is: () => false,
    badRequest: (message: string) => { throw new Error(message); },
    forbidden: (message: string) => { throw new Error(message); },
    notFound: (message: string) => { throw new Error(message); },
  });
  const middleware = require(`${process.env.INTEGRATION_DIST_DIR}/src/middlewares/catalog-edit`).default({ resource: "product" }, { strapi });
  const ctx = makeCtx();
  await strapi.requestContext.run(ctx, () => middleware(ctx, () => strapi.controller(PRODUCT).editor(ctx)));
  expect(ctx.status).toBe(200);
  expect(ctx.body.data.product.attributes.ColorGalleries).toEqual([]);
  expect(ctx.body.data.revision).toBe(before.revision + 1);
  const after = await snapshots.loadEditorSnapshot(strapi, product.id);
  const stale = makeCtx();
  await strapi.requestContext.run(stale, () => middleware(stale, () => strapi.controller(PRODUCT).editor(stale)));
  expect(stale.status).toBe(409);
  expect(stale.body.error.details.code).toBe("PRODUCT_VERSION_CONFLICT");
  expect(await snapshots.loadEditorSnapshot(strapi, product.id)).toEqual(after);
});

it("does not let one product's mutation context update another product's gallery", async () => {
  const { product } = await fixture();
  await save(product.id, { ColorGalleries: mapping() });
  const other = await f.createProduct(); products.push(other.id);
  const before = await snapshots.loadEditorSnapshot(strapi, product.id);
  const ctx = { state: { user: { id: 99999 } } };
  await expect(strapi.requestContext.run(ctx, () => guard.runCatalogSystemMutation(strapi, [other.id], "fixture", () =>
    strapi.entityService.update(PRODUCT, product.id, { data: { ColorGalleries: [] } }),
  ))).rejects.toMatchObject({ code: "CATALOG_PARENT_CHANGE_FORBIDDEN" });
  expect(await snapshots.loadEditorSnapshot(strapi, product.id)).toEqual(before);
});
