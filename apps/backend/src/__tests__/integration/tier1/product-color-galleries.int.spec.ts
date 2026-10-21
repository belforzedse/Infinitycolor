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
