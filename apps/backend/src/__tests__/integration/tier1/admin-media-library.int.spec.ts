/**
 * Catalog media library on real Postgres.
 *
 * The picker's visibility rule (product-only or unattached files), the product-title
 * search and the usage window query are raw SQL against Strapi's `files`,
 * `files_related_morphs` and `products` tables, so column names, jsonb operators and the
 * NULL-safe foreign-attachment test are proven here rather than assumed.
 */
import controller from "../../../api/admin-media-library/controllers/admin-media-library";
import { MODEL_APPLICATION_PHOTO_ALT_TEXTS } from "../../../api/model-application/lib/photos";
import { makeFactories, TEST_PREFIX, type Factories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;
let f: Factories;
const createdFiles: number[] = [];

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
});

beforeEach(() => {
  f = makeFactories(strapi);
});

afterEach(async () => {
  const knex = strapi.db.connection;
  if (createdFiles.length) {
    const ids = createdFiles.splice(0);
    await knex("files_related_morphs").whereIn("file_id", ids).del();
    await knex("files").whereIn("id", ids).del();
  }
  await f.cleanup();
});

let fileSeq = 0;
async function createFile(
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<number> {
  fileSeq += 1;
  const name = `${TEST_PREFIX}ml_${label}_${fileSeq}.webp`;
  const row = await strapi.db.query("plugin::upload.file").create({
    data: {
      name,
      hash: `${TEST_PREFIX}ml_${label}_${fileSeq}`,
      ext: ".webp",
      mime: "image/webp",
      size: 12.5,
      width: 800,
      height: 1000,
      url: `/uploads/${name}`,
      provider: "local",
      ...overrides,
    },
  });
  createdFiles.push(row.id);
  return row.id;
}

async function attach(fileId: number, relatedType: string, relatedId: number, field: string) {
  await strapi.db.connection("files_related_morphs").insert({
    file_id: fileId,
    related_id: relatedId,
    related_type: relatedType,
    field,
    order: 1,
  });
}

function listCtx(body: Record<string, unknown>) {
  return {
    request: { body },
    state: { auth: {}, user: { id: 1 } },
    body: null as any,
    badRequest: jest.fn((message: string) => {
      throw new Error(message);
    }),
    set: jest.fn(),
  };
}

async function query(body: Record<string, unknown>) {
  const ctx = listCtx({ pageSize: 60, ...body });
  await controller.query(ctx);
  return ctx.body as { data: any[]; meta: { pagination: { total: number } } };
}

describe("admin media library (real Postgres)", () => {
  it("shows product-only and unattached files and hides everything shared or private", async () => {
    const product = await f.createProduct({ title: `${TEST_PREFIX}مانتو کتابخانه` });
    const cover = await createFile("cover");
    const unattached = await createFile("unattached");
    const postShared = await createFile("post_shared");
    const postOnly = await createFile("post_only");
    const applicant = await createFile("applicant", {
      alternativeText: MODEL_APPLICATION_PHOTO_ALT_TEXTS.photoOne,
    });
    await attach(cover, "api::product.product", product.id, "CoverImage");
    await attach(postShared, "api::product.product", product.id, "Media");
    await attach(postShared, "api::post.post", 999_999, "CoverImage");
    await attach(postOnly, "api::post.post", 999_999, "Media");

    const body = await query({ search: `${TEST_PREFIX}ml_` });
    const ids = body.data.map((item) => item.id);

    expect(ids).toEqual(expect.arrayContaining([cover, unattached]));
    expect(ids).not.toContain(postShared);
    expect(ids).not.toContain(postOnly);
    expect(ids).not.toContain(applicant);
    expect(body.meta.pagination.total).toBe(2);
    // Newest first.
    expect(ids.indexOf(unattached)).toBeLessThan(ids.indexOf(cover));

    const attached = await query({ search: `${TEST_PREFIX}ml_`, usage: "attached" });
    expect(attached.data.map((item) => item.id)).toEqual([cover]);
    const loose = await query({ search: `${TEST_PREFIX}ml_`, usage: "unattached" });
    expect(loose.data.map((item) => item.id)).toEqual([unattached]);
  });

  it("finds a product's images by product title and counts usage per product", async () => {
    const title = `${TEST_PREFIX}شومیز-${Date.now()}`;
    const first = await f.createProduct({ title });
    const second = await f.createProduct({ title: `${TEST_PREFIX}دیگری-${Date.now()}` });
    const removed = await f.createProduct({ title: `${TEST_PREFIX}حذف‌شده-${Date.now()}` });
    await strapi.db.connection("products").where({ id: removed.id }).update({ removed_at: new Date() });

    const shared = await createFile("shared");
    const both = await createFile("both");
    await attach(shared, "api::product.product", first.id, "Media");
    await attach(shared, "api::product.product", second.id, "CoverImage");
    await attach(shared, "api::product.product", removed.id, "Media");
    await attach(both, "api::product.product", first.id, "CoverImage");
    await attach(both, "api::product.product", first.id, "Media");

    const body = await query({ search: title });
    const byId = new Map(body.data.map((item) => [item.id, item]));

    expect([...byId.keys()].sort()).toEqual([shared, both].sort());
    expect(byId.get(shared).usage).toMatchObject({
      productCount: 2,
      removedProductCount: 1,
      usedAsCover: true,
    });
    expect(byId.get(shared).usage.products).toHaveLength(3);
    expect(byId.get(shared).usage.products[2]).toMatchObject({ id: removed.id, removed: true });
    expect(byId.get(both).usage).toMatchObject({
      productCount: 1,
      removedProductCount: 0,
      usedAsCover: true,
      products: [{ id: first.id, title, removed: false, asCover: true }],
    });
  });

  it("pages with a real total and filters videos by transcode status", async () => {
    for (let index = 0; index < 3; index += 1) await createFile(`page${index}`);
    const pageOne = await query({ search: `${TEST_PREFIX}ml_page`, pageSize: 2, page: 1 });
    const pageTwo = await query({ search: `${TEST_PREFIX}ml_page`, pageSize: 2, page: 2 });
    expect(pageOne.meta.pagination.total).toBe(3);
    expect(pageOne.data).toHaveLength(2);
    expect(pageTwo.data).toHaveLength(1);

    const ready = await createFile("video_ready", {
      mime: "video/mp4",
      ext: ".mp4",
      provider_metadata: {
        video: {
          status: "playback_ready",
          output: { poster: { url: "/uploads/poster.jpg", width: 10, height: 10 } },
          lease: { owner: "must-not-leak" },
        },
      },
    });
    const failed = await createFile("video_failed", {
      mime: "video/mp4",
      ext: ".mp4",
      provider_metadata: { video: { status: "failed" } },
    });

    const videos = await query({ search: `${TEST_PREFIX}ml_video`, type: "video" });
    expect(videos.data.map((item) => item.id)).toEqual([ready]);
    expect(videos.data[0].video).toEqual({ status: "playback_ready", posterUrl: "/uploads/poster.jpg" });
    expect(videos.data[0].thumbnailUrl).toBe("/uploads/poster.jpg");
    expect(JSON.stringify(videos)).not.toContain("must-not-leak");
    expect(videos.data.map((item) => item.id)).not.toContain(failed);

    const images = await query({ search: `${TEST_PREFIX}ml_video` });
    expect(images.data).toHaveLength(0);
  });
});
