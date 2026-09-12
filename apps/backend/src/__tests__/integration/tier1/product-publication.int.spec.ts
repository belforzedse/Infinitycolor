import {
  executePublicationCommand,
  publishScheduledProduct,
  runPublicationEffects,
} from "../../../api/product/services/product-publication";
import { setupStrapi, teardownStrapi, getStrapi } from "../strapiInstance";
import { makeFactories, type Factories, TEST_PREFIX } from "../factories";

let strapi: any;
let f: Factories;
const productIds: number[] = [];

beforeAll(async () => {
  strapi = await setupStrapi();
});

beforeEach(() => {
  f = makeFactories(strapi);
});

afterEach(async () => {
  await f.cleanup();
});

afterAll(async () => {
  for (const id of productIds.reverse()) {
    const logLinks = await strapi.db.connection("product_logs_product_links")
      .select("product_log_id")
      .where({ product_id: id });
    await strapi.db.connection("product_logs_product_links")
      .where({ product_id: id })
      .delete();
    if (logLinks.length > 0) {
      await strapi.db.connection("product_logs")
        .whereIn("id", logLinks.map((link: any) => link.product_log_id))
        .delete();
    }
    await strapi.db.query("api::product.product").delete({ where: { id } });
  }
  await teardownStrapi();
});

async function createProduct(status: "Active" | "InActive" = "InActive") {
  const suffix = `${Date.now()}_${productIds.length}`;
  const row = await strapi.db.query("api::product.product").create({
    data: {
      Title: `${TEST_PREFIX}publication_${suffix}`,
      Slug: `${TEST_PREFIX.toLowerCase()}publication-${suffix}`,
      Status: status,
      external_source: TEST_PREFIX,
      external_id: `publication-${suffix}`,
    },
  });
  productIds.push(row.id);
  return row;
}

describe("product publication on real PostgreSQL", () => {
  it("has the additive scheduling and recovery columns without changing existing statuses", async () => {
    const product = await createProduct("Active");
    const columns = await getStrapi().db.connection("information_schema.columns")
      .select("column_name")
      .where({ table_schema: "public", table_name: "products" })
      .whereIn("column_name", [
        "scheduled_publish_at",
        "scheduled_publish_timezone",
        "scheduled_publish_revision",
        "scheduled_publish_attempt_count",
        "scheduled_publish_last_attempt_at",
        "scheduled_publish_last_error",
        "scheduled_publish_failure_kind",
        "scheduled_publish_next_retry_at",
        "publication_revision",
        "publication_effects_completed_revision",
        "publication_effects_last_error",
      ]);

    expect(columns.map((column: any) => column.column_name).sort()).toEqual([
      "publication_effects_completed_revision",
      "publication_effects_last_error",
      "publication_revision",
      "scheduled_publish_at",
      "scheduled_publish_attempt_count",
      "scheduled_publish_failure_kind",
      "scheduled_publish_last_attempt_at",
      "scheduled_publish_last_error",
      "scheduled_publish_next_retry_at",
      "scheduled_publish_revision",
      "scheduled_publish_timezone",
    ]);
    expect((await strapi.db.query("api::product.product").findOne({
      where: { id: product.id },
    })).Status).toBe("Active");
  });

  it("serializes reschedules under row lock and makes the superseded revision stale", async () => {
    const product = await createProduct();
    const now = new Date("2026-08-08T10:00:00.000Z");
    const firstAt = "2026-08-08T12:00:00.000Z";
    const laterAt = "2026-08-08T13:00:00.000Z";

    const scheduled = await executePublicationCommand(strapi, product.id, {
      action: "schedule",
      publishAt: firstAt,
      timezone: "Asia/Tehran",
    }, { origin: "admin", now });
    const rescheduled = await executePublicationCommand(strapi, product.id, {
      action: "schedule",
      publishAt: laterAt,
      timezone: "Asia/Tehran",
    }, { origin: "admin", now });
    const stale = await publishScheduledProduct(strapi, {
      productId: product.id,
      scheduleRevision: scheduled.scheduleRevision,
      expectedPublishAt: firstAt,
      now: new Date("2026-08-08T14:00:00.000Z"),
    });

    expect(rescheduled.scheduleRevision).toBe(scheduled.scheduleRevision + 1);
    expect(stale.outcome).toBe("stale");
    const persisted = await strapi.db.query("api::product.product").findOne({
      where: { id: product.id },
    });
    expect(persisted.Status).toBe("Scheduled");
    expect(new Date(persisted.scheduledPublishAt).toISOString()).toBe(laterAt);
  });

  it("allows two workers to race but records one publication transition and one audit", async () => {
    const product = await createProduct();
    const publishAt = "2026-08-08T12:00:00.000Z";
    const scheduled = await executePublicationCommand(strapi, product.id, {
      action: "schedule",
      publishAt,
      timezone: "Asia/Tehran",
    }, { origin: "admin", now: new Date("2026-08-08T10:00:00.000Z") });
    const delivery = {
      productId: product.id,
      scheduleRevision: scheduled.scheduleRevision,
      expectedPublishAt: publishAt,
      now: new Date("2026-08-08T12:01:00.000Z"),
    };

    const attempts = await Promise.all([
      publishScheduledProduct(strapi, delivery),
      publishScheduledProduct(strapi, delivery),
    ]);

    expect(attempts.map((attempt) => attempt.outcome).sort()).toEqual([
      "already-published",
      "published",
    ]);
    const persisted = await strapi.db.query("api::product.product").findOne({
      where: { id: product.id },
    });
    expect(persisted.Status).toBe("Active");
    expect(persisted.publicationRevision).toBe(1);

    const publicationLogs = await strapi.db.query("api::product-log.product-log").findMany({
      where: { product: { id: product.id }, Action: "Publish" },
    });
    expect(publicationLogs).toHaveLength(1);

    await expect(runPublicationEffects(strapi, product.id, 1)).resolves.toEqual({
      completed: true,
      revision: 1,
    });
    const effectsCompleted = await strapi.db.query("api::product.product").findOne({
      where: { id: product.id },
    });
    expect(effectsCompleted.publicationEffectsCompletedRevision).toBe(1);
  });

  it("publishes the product's own variations and leaves other products' alone", async () => {
    const product = await createProduct();
    const other = await createProduct();
    const draft = await f.createVariation({ productId: product.id, isPublished: false });
    const alreadyLive = await f.createVariation({ productId: product.id, isPublished: true });
    const foreign = await f.createVariation({ productId: other.id, isPublished: false });

    const result = await executePublicationCommand(
      strapi,
      product.id,
      { action: "publish-now" },
      { origin: "admin", now: new Date("2026-08-08T10:00:00.000Z") },
    );

    expect(result.status).toBe("Active");
    // Only the unpublished one was flipped; the already-live row was left alone.
    expect(result.publishedVariationCount).toBe(1);

    const readVariation = async (id: number) =>
      strapi.db.query("api::product-variation.product-variation").findOne({ where: { id } });
    expect((await readVariation(draft.id)).IsPublished).toBe(true);
    expect((await readVariation(alreadyLive.id)).IsPublished).toBe(true);
    expect((await readVariation(foreign.id)).IsPublished).toBe(false);
  });
});
