/**
 * Product lifecycle (All / Published / Drafts / Scheduled / Trash) on a real
 * PostgreSQL: the row locks, the SQL of the admin list and counts, and what a
 * permanent delete leaves behind for order history.
 */
jest.mock("../../../queue/product-publication-queue", () => ({
  enqueueScheduledProductPublication: jest.fn(async () => "job"),
  removeScheduledProductPublication: jest.fn(async () => true),
  scheduledProductJobExists: jest.fn(async () => false),
}));

import {
  executePublicationCommand,
  publishScheduledProduct,
} from "../../../api/product/services/product-publication";
import {
  emptyTrash,
  purgeProduct,
  restoreProduct,
  runLifecycleBulk,
  trashProduct,
} from "../../../api/product/services/product-lifecycle";
import {
  countProductListViews,
  findProductListPage,
  type ProductListCriteria,
} from "../../../api/admin-product-list/services/product-list-query";
import { runTrashRetentionSweep } from "../../../jobs/purgeExpiredTrashedProducts";
import { publicProductFilters } from "../../../utils/productVisibility";
import { setupStrapi, teardownStrapi } from "../strapiInstance";
import { makeFactories, type Factories, TEST_PREFIX } from "../factories";

let strapi: any;
let f: Factories;
let run = 0;
const staff: number[] = [];

beforeAll(async () => {
  strapi = await setupStrapi();
  // Real accounts, so product-log rows can reference who acted.
  for (const suffix of ["1", "7"]) {
    const user = await strapi.db.query("plugin::users-permissions.user").create({
      data: {
        username: `${TEST_PREFIX}lifecycle_admin_${suffix}_${Date.now()}`,
        email: `${TEST_PREFIX.toLowerCase()}lifecycle${suffix}${Date.now()}@example.test`,
        phone: `0912000${suffix.padStart(4, "0")}`,
        provider: "local",
        confirmed: true,
      },
    });
    staff.push(user.id);
  }
});

beforeEach(() => {
  f = makeFactories(strapi);
  run += 1;
});

afterEach(async () => {
  await f.cleanup();
});

afterAll(async () => {
  await teardownStrapi();
});

const admin = (which: 1 | 7 = 1) => ({
  origin: "admin" as const,
  actor: { id: staff[which === 1 ? 0 : 1], name: "admin", label: "Test Admin" },
});

async function row(id: number) {
  return strapi.db.connection("products").where({ id }).first();
}

/** A product with a unique searchable title, a priced variation and optional status. */
async function product(tag: string, status: "Active" | "InActive" | "Scheduled" = "InActive") {
  const created = await f.createProduct({ title: `${TEST_PREFIX}${tag}_${run}_${Date.now()}` });
  const variation = await f.createVariation({ productId: created.id, price: 250000, stockCount: 5 });
  if (status === "Active") {
    await executePublicationCommand(strapi, created.id, { action: "publish-now" }, admin());
  }
  if (status === "Scheduled") {
    await executePublicationCommand(
      strapi,
      created.id,
      { action: "schedule", publishAt: new Date(Date.now() + 3_600_000).toISOString(), timezone: "Asia/Tehran" },
      admin(),
    );
  }
  return { ...created, variation };
}

async function isPublic(id: number): Promise<boolean> {
  const rows = await strapi.entityService.findMany("api::product.product", {
    filters: { id, ...publicProductFilters() },
    fields: ["id"],
  });
  return (rows as unknown[]).length === 1;
}

function criteria(overrides: Partial<ProductListCriteria>): ProductListCriteria {
  return {
    view: "all",
    page: 1,
    pageSize: 25,
    sort: "last-edited",
    search: "",
    categoryId: null,
    stock: null,
    productType: null,
    filters: [],
    ...overrides,
  };
}

describe("product lifecycle on real PostgreSQL", () => {
  it("has the additive trash columns and the declared lifecycle indexes", async () => {
    const columns = await strapi.db.connection("information_schema.columns")
      .select("column_name")
      .where({ table_schema: "public", table_name: "products" })
      .whereIn("column_name", [
        "removed_by_id",
        "removed_by_label",
        "pre_removal_status",
        "pre_removal_scheduled_publish_at",
        "purged_at",
        "purged_by_id",
      ]);
    expect(columns).toHaveLength(6);

    const indexes = await strapi.db.connection("pg_indexes")
      .select("indexname")
      .where({ tablename: "products" })
      .whereIn("indexname", ["idx_products_lifecycle_view", "idx_products_removed_at", "idx_products_scheduled_publish"]);
    expect(indexes.map((index: any) => index.indexname).sort()).toEqual([
      "idx_products_lifecycle_view",
      "idx_products_removed_at",
      "idx_products_scheduled_publish",
    ]);
  });

  it("moves a published product to Trash, out of the storefront, and restores it as a draft", async () => {
    const published = await product("trash_published", "Active");
    expect(await isPublic(published.id)).toBe(true);

    const trashed = await trashProduct(strapi, published.id, admin(7));
    expect(trashed).toEqual(expect.objectContaining({ changed: true, state: "trashed", previousStatus: "Active" }));
    expect(await isPublic(published.id)).toBe(false);
    expect(await row(published.id)).toEqual(expect.objectContaining({
      status: "InActive",
      pre_removal_status: "Active",
      removed_by_id: staff[1],
      removed_by_label: "Test Admin",
    }));
    const logs = await strapi.db.query("api::product-log.product-log").findMany({
      where: { product: { id: published.id }, Action: "Trash" },
    });
    expect(logs).toHaveLength(1);

    // Repeating is harmless.
    await expect(trashProduct(strapi, published.id, admin(7))).resolves.toEqual(
      expect.objectContaining({ changed: false }),
    );
    // Trash never leads straight to published.
    await expect(
      executePublicationCommand(strapi, published.id, { action: "publish-now" }, admin()),
    ).rejects.toMatchObject({ code: "PRODUCT_REMOVED" });

    const restored = await restoreProduct(strapi, published.id, admin(7), { canPublish: true });
    expect(restored).toEqual(expect.objectContaining({ changed: true, state: "draft", status: "InActive" }));
    expect(await isPublic(published.id)).toBe(false);
    expect(await row(published.id)).toEqual(expect.objectContaining({
      removed_at: null,
      removed_by_id: null,
      pre_removal_status: null,
    }));
  });

  it("undoes a trash straight back to published for the same admin, within the window", async () => {
    const published = await product("undo", "Active");
    const trashed = await trashProduct(strapi, published.id, admin(7));

    const undone = await restoreProduct(strapi, published.id, admin(7), {
      undoToken: trashed.removedAt,
      canPublish: true,
    });

    expect(undone).toEqual(expect.objectContaining({ state: "published", status: "Active" }));
    expect(await isPublic(published.id)).toBe(true);
  });

  it("retires a schedule on trash so its delayed job can no longer publish", async () => {
    const scheduled = await product("trash_scheduled", "Scheduled");
    const before = await row(scheduled.id);

    await trashProduct(strapi, scheduled.id, admin());

    const attempt = await publishScheduledProduct(strapi, {
      productId: scheduled.id,
      scheduleRevision: Number(before.scheduled_publish_revision),
      expectedPublishAt: new Date(before.scheduled_publish_at).toISOString(),
      now: new Date(Date.now() + 7_200_000),
    });
    expect(attempt.outcome).toBe("stale");
    expect(await row(scheduled.id)).toEqual(expect.objectContaining({
      status: "InActive",
      scheduled_publish_at: null,
      pre_removal_status: "Scheduled",
    }));
    expect((await row(scheduled.id)).pre_removal_scheduled_publish_at).not.toBeNull();
  });

  it("publishes a due schedule exactly once however often the job runs, and never early", async () => {
    const scheduled = await product("scheduler", "Scheduled");
    const state = await row(scheduled.id);
    const input = {
      productId: scheduled.id,
      scheduleRevision: Number(state.scheduled_publish_revision),
      expectedPublishAt: new Date(state.scheduled_publish_at).toISOString(),
    };

    const early = await publishScheduledProduct(strapi, { ...input, now: new Date() });
    expect(early.outcome).toBe("early");
    expect(await isPublic(scheduled.id)).toBe(false);

    const due = new Date(Date.parse(input.expectedPublishAt) + 1000);
    const [first, second] = await Promise.all([
      publishScheduledProduct(strapi, { ...input, now: due }),
      publishScheduledProduct(strapi, { ...input, now: due }),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["already-published", "published"]);
    expect(await isPublic(scheduled.id)).toBe(true);
  });

  it("serialises publish against trash so the product never ends up public and trashed", async () => {
    const draft = await product("race_publish_trash");

    const outcomes = await Promise.allSettled([
      executePublicationCommand(strapi, draft.id, { action: "publish-now" }, admin()),
      trashProduct(strapi, draft.id, admin()),
    ]);

    const final = await row(draft.id);
    expect(final.removed_at).not.toBeNull();
    expect(final.status).toBe("InActive");
    expect(await isPublic(draft.id)).toBe(false);
    // Either publish ran first and trash then demoted it, or trash ran first and
    // the publish was refused.
    const publishOutcome = outcomes[0];
    if (publishOutcome.status === "rejected") {
      expect(publishOutcome.reason).toMatchObject({ code: "PRODUCT_REMOVED" });
      expect(final.pre_removal_status).toBe("InActive");
    } else {
      expect(final.pre_removal_status).toBe("Active");
    }
  });

  it("lets exactly one of two concurrent permanent deletes act, and a restore race never un-purges", async () => {
    const one = await product("race_purge");
    await trashProduct(strapi, one.id, admin());
    const purges = await Promise.all([
      purgeProduct(strapi, one.id, admin()),
      purgeProduct(strapi, one.id, admin()),
    ]);
    expect(purges.map((result) => result.changed).sort()).toEqual([false, true]);

    const two = await product("race_restore_purge");
    await trashProduct(strapi, two.id, admin());
    const [restore, purge] = await Promise.allSettled([
      restoreProduct(strapi, two.id, admin()),
      purgeProduct(strapi, two.id, admin()),
    ]);
    const final = await row(two.id);
    if (final.purged_at) {
      expect(restore.status).toBe("rejected");
      expect((restore as PromiseRejectedResult).reason).toMatchObject({ code: "PRODUCT_PURGED" });
      expect(final.removed_at).not.toBeNull();
    } else {
      expect(purge.status).toBe("rejected");
      expect((purge as PromiseRejectedResult).reason).toMatchObject({ code: "PRODUCT_NOT_IN_TRASH" });
      expect(final.removed_at).toBeNull();
    }
  });

  it("refuses permanent deletion outside Trash and keeps order history after it", async () => {
    const sold = await product("purge_order_history", "Active");
    const order = await f.createOrder({ status: "Done" });
    const item = await f.createOrderItem({ orderId: order.id, variationId: sold.variation.id, perAmount: 250000 });
    const skuBefore = sold.variation.SKU;

    await expect(purgeProduct(strapi, sold.id, admin())).rejects.toMatchObject({
      code: "PRODUCT_NOT_IN_TRASH",
    });

    await trashProduct(strapi, sold.id, admin());
    const purged = await purgeProduct(strapi, sold.id, admin());
    expect(purged).toEqual(expect.objectContaining({ changed: true, state: "purged" }));

    // Tombstone: the row stays for history, hidden from every list and the storefront.
    const tombstone = await row(sold.id);
    expect(tombstone.purged_at).not.toBeNull();
    expect(tombstone.title).toContain("purge_order_history");
    await expect(restoreProduct(strapi, sold.id, admin())).rejects.toMatchObject({ code: "PRODUCT_PURGED" });

    // The order line still resolves to its variation and product.
    const line = await strapi.db.query("api::order-item.order-item").findOne({
      where: { id: item.id },
      populate: { product_variation: { populate: { product: true } } },
    });
    expect(line.ProductTitle).toBeTruthy();
    expect(line.PerAmount).toBe("250000");
    expect(line.product_variation.id).toBe(sold.variation.id);
    expect(line.product_variation.product.id).toBe(sold.id);

    // Its SKU is free for a new product.
    expect(line.product_variation.SKU).toBe(`${skuBefore}~purged-${sold.id}`);
    const reuse = await strapi.entityService.create("api::product-variation.product-variation", {
      data: { SKU: skuBefore, Price: 1000, IsPublished: false, external_source: TEST_PREFIX },
    });
    f.remember("api::product-variation.product-variation", reuse.id);
    expect(reuse.SKU).toBe(skuBefore);
  });

  it("refuses to publish into a slug another live product owns, with a controlled error", async () => {
    const owner = await product("slug_owner", "Active");
    const other = await product("slug_other");
    const { slug } = await row(owner.id);
    await strapi.db.connection("products").where({ id: other.id }).update({ slug });

    await expect(
      executePublicationCommand(strapi, other.id, { action: "publish-now" }, admin()),
    ).rejects.toMatchObject({ code: "PRODUCT_SLUG_CONFLICT", status: 409 });

    // Restoring into an occupied slug lands on draft and says so.
    await trashProduct(strapi, other.id, admin());
    const restored = await restoreProduct(strapi, other.id, admin());
    expect(restored.warnings).toContain("SLUG_IN_USE");
    expect(restored.status).toBe("InActive");
  });

  it("counts every tab in one query and composes views with search, sort and pagination", async () => {
    const tag = `lifecycle_counts_${run}`;
    const make = async (suffix: string, status?: "Active" | "Scheduled") => {
      const created = await f.createProduct({ title: `${TEST_PREFIX}${tag}_${suffix}` });
      await f.createVariation({ productId: created.id, price: 1000, stockCount: suffix.startsWith("empty") ? 0 : 3 });
      if (status === "Active") await executePublicationCommand(strapi, created.id, { action: "publish-now" }, admin());
      if (status === "Scheduled") {
        await executePublicationCommand(
          strapi,
          created.id,
          { action: "schedule", publishAt: new Date(Date.now() + 86_400_000).toISOString(), timezone: "Asia/Tehran" },
          admin(),
        );
      }
      return created;
    };
    await make("pub_a", "Active");
    await make("pub_b", "Active");
    await make("draft_a");
    const scheduled = await make("sched_a", "Scheduled");
    const trashedDraft = await make("empty_trash_a");
    await trashProduct(strapi, trashedDraft.id, admin());
    const trashedPublished = await make("trash_b", "Active");
    await trashProduct(strapi, trashedPublished.id, admin());

    const counts = await countProductListViews(strapi, criteria({ search: tag }));
    expect(counts).toEqual({ all: 4, published: 2, drafts: 1, scheduled: 1, trash: 2 });

    const trashPage = await findProductListPage(strapi, criteria({ view: "trash", search: tag, sort: "trashed-desc" }));
    expect(trashPage).toEqual({ ids: [trashedPublished.id, trashedDraft.id], total: 2 });

    const scheduledPage = await findProductListPage(strapi, criteria({ view: "scheduled", search: tag, sort: "scheduled-asc" }));
    expect(scheduledPage.ids).toEqual([scheduled.id]);

    const firstPage = await findProductListPage(strapi, criteria({ search: tag, sort: "title", pageSize: 3 }));
    const secondPage = await findProductListPage(strapi, criteria({ search: tag, sort: "title", pageSize: 3, page: 2 }));
    expect(firstPage.total).toBe(4);
    expect(firstPage.ids).toHaveLength(3);
    expect(secondPage.ids).toHaveLength(1);
    expect(new Set([...firstPage.ids, ...secondPage.ids]).size).toBe(4);

    const outOfStock = await countProductListViews(strapi, criteria({ search: tag, stock: "out" }));
    expect(outOfStock).toEqual({ all: 0, published: 0, drafts: 0, scheduled: 0, trash: 1 });

    const advanced = await countProductListViews(
      strapi,
      criteria({ search: tag, filters: [{ Title: { $containsi: "pub_" } }] }),
    );
    expect(advanced).toEqual(expect.objectContaining({ all: 2, published: 2 }));

    // A relation-path advanced filter goes through Strapi's compiled subquery
    // (joins + DISTINCT) inside the list's WHERE … IN.
    const sku = (await strapi.db.connection("product_variations as pv")
      .join("product_variations_product_links as l", "l.product_variation_id", "pv.id")
      .where("l.product_id", scheduled.id)
      .first("pv.sku")).sku as string;
    const bySku = await findProductListPage(
      strapi,
      criteria({ view: "scheduled", filters: [{ product_variations: { SKU: { $containsi: sku } } }] }),
    );
    expect(bySku).toEqual({ ids: [scheduled.id], total: 1 });

    // The 30-day sales sort compiles its paid-orders CTE on Postgres and keeps
    // products without sales in the list.
    const bySales = await findProductListPage(strapi, criteria({ search: tag, sort: "sales-desc" }));
    expect(bySales.total).toBe(4);
    expect(bySales.ids).toHaveLength(4);
  });

  it("runs bulk commands per product with partial failures reported", async () => {
    const a = await product("bulk_a", "Active");
    const b = await product("bulk_b");
    const c = await product("bulk_c");
    await trashProduct(strapi, c.id, admin());

    const trashed = await runLifecycleBulk(strapi, "trash", [a.id, b.id, c.id], admin());
    expect(trashed.succeeded.sort()).toEqual([a.id, b.id].sort());
    expect(trashed.unchanged).toEqual([c.id]);
    expect(await isPublic(a.id)).toBe(false);

    const restored = await runLifecycleBulk(strapi, "restore", [a.id, b.id], admin());
    expect(restored.succeeded.sort()).toEqual([a.id, b.id].sort());
    expect(await isPublic(a.id)).toBe(false);

    const purged = await runLifecycleBulk(strapi, "purge", [a.id, c.id], admin());
    expect(purged.succeeded).toEqual([c.id]);
    expect(purged.failed).toEqual([{ id: a.id, code: "PRODUCT_NOT_IN_TRASH" }]);

    const published = await runLifecycleBulk(strapi, "publish", [a.id, b.id], admin());
    expect(published.succeeded.sort()).toEqual([a.id, b.id].sort());
    expect(await isPublic(b.id)).toBe(true);
  });

  it("empties Trash only up to the moment the admin looked at it", async () => {
    const old = await product("empty_old");
    await trashProduct(strapi, old.id, admin());
    const lookedAt = new Date();
    const later = await product("empty_later");
    await trashProduct(strapi, later.id, { ...admin(), now: new Date(lookedAt.getTime() + 60_000) });

    await emptyTrash(strapi, admin(), { trashedBefore: lookedAt });

    expect((await row(old.id)).purged_at).not.toBeNull();
    expect((await row(later.id)).purged_at).toBeNull();
  });

  it("sweeps only products past retention, counting from when retention was enabled", async () => {
    const store = strapi.store({ type: "core", name: "product-trash-retention" });
    await store.set({ key: "enabledSince", value: "2020-01-01T00:00:00.000Z" });
    const due = await product("retention_due");
    await trashProduct(strapi, due.id, { ...admin(), now: new Date(Date.now() - 40 * 86_400_000) });
    const fresh = await product("retention_fresh");
    await trashProduct(strapi, fresh.id, admin());

    const summary = await runTrashRetentionSweep(strapi, { env: { PRODUCT_TRASH_RETENTION_DAYS: "30" } });

    expect(summary.status).toBe("completed");
    expect((await row(due.id)).purged_at).not.toBeNull();
    expect((await row(fresh.id)).purged_at).toBeNull();
    await store.set({ key: "enabledSince", value: null });
  });
});
