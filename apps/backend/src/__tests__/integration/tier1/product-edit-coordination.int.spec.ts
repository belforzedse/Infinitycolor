import { randomUUID } from "node:crypto";
import {
  CatalogEditError, changeEditLease, readEditPresence, runCatalogMutation,
  runCatalogSystemMutation, staffEditor, type EditProof, type StaffEditor,
} from "../../../utils/catalogEdit";
import { markProductEditedByAdmin } from "../../../utils/adminAudit";
import { saveEditorStock } from "../../../api/product/controllers/product-editor";
import { loadEditorSnapshot } from "../../../api/product/services/product-editor-snapshot";
import { deleteVariationWithStock } from "../../../api/product-variation/services/variation-removal";
import { validateProductOwnedRelations } from "../../../utils/catalogOwnership";
import { makeFactories, type Factories } from "../factories";
import { stockCountChange } from "../../../api/report-export/lib/semantics";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;
let f: Factories;
let ids: number[];
beforeAll(async () => { strapi = await setupStrapi(); });
afterAll(async () => { await teardownStrapi(); });
beforeEach(() => { f = makeFactories(strapi); ids = []; });
afterEach(async () => {
  if (ids.length) await strapi.db.connection("product_edit_leases").whereIn("product_id", ids).delete();
  await f.cleanup();
});

async function fixture() {
  const product = await f.createProduct(); ids.push(product.id);
  const variation = await f.createVariation({ productId: product.id, stockCount: 10 });
  const a = await f.createUser(); const b = await f.createUser();
  let role = await strapi.db.query("plugin::users-permissions.role").findOne({ where: { type: "seller-1" } });
  if (!role) role = await strapi.db.query("plugin::users-permissions.role").create({ data: { name: "Seller 1", type: "seller-1", description: "Disposable test staff" } });
  for (const user of [a, b]) await strapi.db.query("plugin::users-permissions.user").update({ where: { id: user.id }, data: { role: role.id } });
  const editor = (id: number, name: string): StaffEditor => ({
    actor: { user: { id, user_info: { FirstName: name } }, role: "seller1", capabilities: ["product.update"] },
    sessionId: `test-staff-${id}`,
  });
  return { product, variation, a: editor(a.id, "شیوا"), b: editor(b.id, "مریم") };
}
async function acquire(id: number, editor: StaffEditor) {
  const result: any = await changeEditLease(strapi, id, editor, "acquire", { editorInstanceId: randomUUID() }, undefined, () => loadEditorSnapshot(strapi, id));
  return { result, proof: { token: result.lease.token, instanceId: result.lease.editorInstanceId, generation: result.lease.generation, expectedRevision: result.snapshot.revision } as EditProof };
}
const title = async (id: number) => (await strapi.db.query("api::product.product").findOne({ where: { id } })).Title;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

describe("product edit coordination on real PostgreSQL", () => {
  it("gives exactly one simultaneous claimant ownership and exposes no observer secrets", async () => {
    const { product, a, b } = await fixture();
    const results = await Promise.allSettled([acquire(product.id, a), acquire(product.id, b)]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((row) => row.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("EDIT_LEASE_CONFLICT");
    const status = await readEditPresence(strapi, product.id, b);
    expect(status.owner).toBeTruthy();
    expect(JSON.stringify(status)).not.toMatch(/token|session_id|token_hash/);
    const persisted = await strapi.db.connection("product_edit_leases").where({ product_id: product.id }).first();
    const winner = results.find((row) => row.status === "fulfilled") as PromiseFulfilledResult<any>;
    expect(persisted.token_hash).not.toBe(winner.value.proof.token);
  });

  it("only one takeover of the displayed generation succeeds and fences the former editor", async () => {
    const { product, a, b } = await fixture(); const original = await acquire(product.id, a);
    const results = await Promise.allSettled([1, 2].map(() => changeEditLease(strapi, product.id, b, "takeover", { editorInstanceId: randomUUID(), expectedGeneration: original.proof.generation })));
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    await expect(runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, () => strapi.entityService.update("api::product.product", product.id, { data: { Title: "stale overwrite" } }))).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
    expect(await title(product.id)).not.toBe("stale overwrite");
  });

  it("a takeover returns a fresh snapshot instead of blessing previously loaded fields", async () => {
    const { product, a, b } = await fixture(); const original = await acquire(product.id, a);
    await runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, () => strapi.entityService.update("api::product.product", product.id, { data: { Title: "new committed title" } }));
    const takeover: any = await changeEditLease(strapi, product.id, b, "takeover", { editorInstanceId: randomUUID(), expectedGeneration: original.proof.generation }, undefined, () => loadEditorSnapshot(strapi, product.id));
    expect(takeover.snapshot.revision).toBe(1);
    expect(takeover.snapshot.product.attributes.Title).toBe("new committed title");
    expect(takeover.snapshot.product.attributes.product_variations.data).toHaveLength(1);
  });

  it("rejects expired renewal, stale release, another tab and another authenticated session", async () => {
    const { product, a, b } = await fixture(); const original = await acquire(product.id, a);
    await expect(changeEditLease(strapi, product.id, a, "renew", {}, { ...original.proof, instanceId: randomUUID() })).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
    await expect(changeEditLease(strapi, product.id, { ...a, sessionId: "different-session" }, "release", {}, original.proof)).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
    await strapi.db.connection("product_edit_leases").where({ product_id: product.id }).update({ expires_at: new Date(0) });
    await expect(changeEditLease(strapi, product.id, a, "renew", {}, original.proof)).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
    const next = await acquire(product.id, b);
    expect(next.proof.generation).toBeGreaterThan(original.proof.generation);
    await expect(changeEditLease(strapi, product.id, a, "release", {}, original.proof)).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
  });

  it("serializes a save and takeover without partially committed data", async () => {
    const { product, a, b } = await fixture(); const original = await acquire(product.id, a);
    const entered = deferred(); const proceed = deferred();
    const save = runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, async () => {
      await strapi.entityService.update("api::product.product", product.id, { data: { Title: "saved before transfer" } });
      entered.resolve(); await proceed.promise;
    });
    await entered.promise;
    const takeover = changeEditLease(strapi, product.id, b, "takeover", { editorInstanceId: randomUUID(), expectedGeneration: original.proof.generation }, undefined, () => loadEditorSnapshot(strapi, product.id));
    proceed.resolve(); await save;
    expect((await takeover as any).snapshot.product.attributes.Title).toBe("saved before transfer");
  });

  it("rejects stale revisions after named system edits even while the lease remains owned", async () => {
    const { product, a } = await fixture(); const original = await acquire(product.id, a);
    // Use the explicit transaction, including for raw jobs.
    await runCatalogSystemMutation(strapi, [product.id], "publication", (trx) => trx("products").where({ id: product.id }).update({ title: "system title" }));
    await expect(runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, () => Promise.resolve())).rejects.toMatchObject({ code: "PRODUCT_VERSION_CONFLICT" });
    expect(await title(product.id)).toBe("system title");
  });

  it("rolls back product, variation, stock revision and timestamp writes together without deadlock", async () => {
    const { product, variation, a } = await fixture(); const original = await acquire(product.id, a);
    const before = await title(product.id);
    await expect(runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, async () => {
      await strapi.entityService.update("api::product.product", product.id, { data: { Title: "rolled back" } });
      await markProductEditedByAdmin(strapi, product.id);
      await strapi.entityService.update("api::product-variation.product-variation", variation.id, { data: { Price: 2 } });
      await saveEditorStock(strapi, product.id, variation.id, { id: variation.stockId, Count: 8, expectedStockRevision: 0 });
      throw new Error("injected failure");
    })).rejects.toThrow("injected failure");
    expect(await title(product.id)).toBe(before);
    const stock = await strapi.db.connection("product_stocks").where({ id: variation.stockId }).first();
    expect(stock.count).toBe(10); expect(stock.stock_revision).toBe(0);
    expect((await strapi.db.connection("products").where({ id: product.id }).first()).edit_revision).toBe(0);
  });

  it("records who changed stock from what to what, and nothing when the save rolls back", async () => {
    const { product, variation, a } = await fixture(); const original = await acquire(product.id, a);
    const stockAudit = () => strapi.db.connection("manual_admin_activities").where({ resource_type: "Stock", resource_id: String(variation.stockId) });
    const stockLogs = () => strapi.db.connection("product_stock_logs as l")
      .join("product_stock_logs_product_stock_links as k", "k.product_stock_log_id", "l.id").where("k.product_stock_id", variation.stockId).select("l.*");
    const logsBefore = (await stockLogs()).length;

    await expect(runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, async () => {
      await saveEditorStock(strapi, product.id, variation.id, { id: variation.stockId, Count: 4, expectedStockRevision: 0 });
      throw new Error("injected failure");
    })).rejects.toThrow("injected failure");
    expect(await stockAudit()).toHaveLength(0);
    expect(await stockLogs()).toHaveLength(logsBefore);

    await runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof },
      () => saveEditorStock(strapi, product.id, variation.id, { id: variation.stockId, Count: 8, expectedStockRevision: 0 }));
    const [audit] = await stockAudit();
    expect(audit).toMatchObject({ message_en: `Stock ${variation.stockId} changed from 10 to 8`, initiator_id: String(a.actor.user.id), event_key: "products.inventory_changed" });
    expect(stockCountChange(audit.changes)).toEqual({ from: 10, to: 8 }); // what the staff-changes report reads
    expect(String(audit.metadata)).toContain(`"productId": ${product.id}`);
    const logs = await stockLogs();
    expect(logs).toHaveLength(logsBefore + 1);
    expect(logs.at(-1)).toMatchObject({ count: 2, type: "Minus" });

    // An unchanged save and a system job leave no staff audit row.
    await runCatalogSystemMutation(strapi, [product.id], "fixture", () => saveEditorStock(strapi, product.id, variation.id, { id: variation.stockId, Count: 8, expectedStockRevision: 1 }));
    await runCatalogSystemMutation(strapi, [product.id], "fixture", () => saveEditorStock(strapi, product.id, variation.id, { id: variation.stockId, Count: 6, expectedStockRevision: 1 }));
    expect(await stockAudit()).toHaveLength(1);
    expect(await stockLogs()).toHaveLength(logsBefore + 2);
  });

  it("never resets a sale or reservation with an old absolute stock value", async () => {
    const { product, variation, a } = await fixture(); const original = await acquire(product.id, a);
    await strapi.db.connection("product_stocks").where({ id: variation.stockId }).update({ count: 9, reserved_count: 2 });
    await expect(runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, () => saveEditorStock(strapi, product.id, variation.id, { id: variation.stockId, Count: 10, expectedStockRevision: 0 }))).rejects.toMatchObject({ code: "PRODUCT_STOCK_VERSION_CONFLICT" });
    await expect(runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, () => saveEditorStock(strapi, product.id, variation.id, { id: variation.stockId, Count: 1, expectedStockRevision: 1 }))).rejects.toMatchObject({ code: "PRODUCT_STOCK_VERSION_CONFLICT" });
    const stock = await strapi.db.connection("product_stocks").where({ id: variation.stockId }).first();
    expect(stock.count).toBe(9); expect(stock.stock_revision).toBe(1);
  });

  it("rejects variation deletion after a reservation and allows no transient takeover", async () => {
    const { product, variation, a, b } = await fixture(); const original = await acquire(product.id, a);
    await expect(runCatalogMutation(strapi, [product.id], { kind: "transient", editor: b }, () => Promise.resolve())).rejects.toMatchObject({ code: "EDIT_LEASE_CONFLICT" });
    await strapi.db.connection("product_stocks").where({ id: variation.stockId }).update({ reserved_count: 1 });
    await expect(runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, (trx) => deleteVariationWithStock(strapi, variation.id, trx))).rejects.toMatchObject({ status: 409 });
    expect(await strapi.db.query("api::product-variation.product-variation").findOne({ where: { id: variation.id } })).toBeTruthy();
  });

  it("requires verified staff sessions and retains the coordination table across schema sync", async () => {
    const { product, a } = await fixture(); const original = await acquire(product.id, a);
    await expect(staffEditor({ state: { user: { id: a.actor.user.id } } }, strapi)).rejects.toBeInstanceOf(CatalogEditError);
    const store = await strapi.db.connection("strapi_core_store_settings").where({ key: "core_persisted_tables" }).first();
    expect(store.value).toContain("product_edit_leases");
    await strapi.db.schema.sync();
    expect((await readEditPresence(strapi, product.id, a, original.proof)).owned).toBe(true);
  });

  it("rejects taking another product's owned relation through a guarded parent update", async () => {
    const { product, a } = await fixture(); const other = await f.createProduct(); ids.push(other.id);
    const faq = await strapi.db.query("api::product-faq.product-faq").create({ data: { Title: "owned question", product: other.id } });
    try {
      const original = await acquire(product.id, a);
      await expect(runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, () => validateProductOwnedRelations(strapi, product.id, { product_faqs: { connect: [faq.id] } }))).rejects.toMatchObject({ code: "CATALOG_PARENT_CHANGE_FORBIDDEN" });
      expect((await strapi.db.query("api::product-faq.product-faq").findOne({ where: { id: faq.id }, populate: { product: true } })).product.id).toBe(other.id);
    } finally { await strapi.db.query("api::product-faq.product-faq").delete({ where: { id: faq.id } }); }
  });

  it("commits the actual aggregate editor controller and rejects missing or stale proof", async () => {
    const { product, variation, a } = await fixture();
    let role = await strapi.db.query("plugin::users-permissions.role").findOne({ where: { type: "seller-1" } });
    if (!role) role = await strapi.db.query("plugin::users-permissions.role").create({ data: { name: "Seller 1", type: "seller-1", description: "Disposable test staff" } });
    await strapi.db.query("plugin::users-permissions.user").update({ where: { id: a.actor.user.id }, data: { role: role.id } });
    await strapi.db.query("api::product.product").update({ where: { id: product.id }, data: { ProductType: "Simple", IsSimpleProduct: true } });
    const original = await acquire(product.id, a);
    const headers: Record<string, string> = {
      "x-product-edit-token": original.proof.token, "x-product-edit-instance": original.proof.instanceId,
      "x-product-edit-generation": String(original.proof.generation), "x-product-expected-revision": "0",
    };
    const makeCtx = (proofHeaders: Record<string, string>) => ({
      params: { id: String(product.id) }, query: {}, status: 200, body: undefined as any,
      state: { user: { id: a.actor.user.id }, betterAuthSessionId: a.sessionId },
      request: { method: "PUT", headers: proofHeaders, body: { data: { Title: "atomic editor title" }, simpleVariation: { id: variation.id, Price: 75000, stock: { id: variation.stockId, Count: 12, expectedStockRevision: 0 } } } },
      get: (key: string) => proofHeaders[key.toLowerCase()] || "", set: jest.fn(),
      is: () => false,
      badRequest: (message: string) => { throw new Error(message); },
      forbidden: (message: string) => { throw new Error(message); },
      notFound: (message: string) => { throw new Error(message); },
    });
    // Use the same compiled middleware/ALS as the actual loaded controller.
    const compiled = require(`${process.env.INTEGRATION_DIST_DIR}/src/utils/catalogEdit`);
    const compiledAcquisition: any = await compiled.changeEditLease(strapi, product.id, a, "takeover", { editorInstanceId: original.proof.instanceId, expectedGeneration: original.proof.generation });
    headers["x-product-edit-token"] = compiledAcquisition.lease.token;
    headers["x-product-edit-generation"] = String(compiledAcquisition.lease.generation);
    const middleware = require(`${process.env.INTEGRATION_DIST_DIR}/src/middlewares/catalog-edit`).default({ resource: "product" }, { strapi });
    const ctx = makeCtx(headers);
    await middleware(ctx, () => strapi.controller("api::product.product").editor(ctx));
    expect(ctx.status).toBe(200);
    expect(ctx.body.data.product.attributes.Title).toBe("atomic editor title");
    expect(ctx.body.data.revision).toBe(1); expect(ctx.body.meta.editRevision).toBe(1);
    const committed = ctx.body.data.product.attributes.product_variations.data[0].attributes;
    expect(Number(committed.Price)).toBe(75000);
    expect(committed.product_stock.data.attributes.StockRevision).toBe(1);
    const rejected = makeCtx({});
    await middleware(rejected, () => Promise.reject(new Error("must not execute")));
    expect(rejected.status).toBe(409); expect(rejected.body.error.details.code).toBe("EDIT_LEASE_LOST");
    const stale = makeCtx(headers);
    await middleware(stale, () => Promise.reject(new Error("must not execute")));
    expect(stale.status).toBe(409); expect(stale.body.error.details.code).toBe("PRODUCT_VERSION_CONFLICT");
  });

  it("rechecks permission after locking instead of trusting an older staff role", async () => {
    const { product, a } = await fixture(); const original = await acquire(product.id, a);
    await strapi.db.query("plugin::users-permissions.user").update({ where: { id: a.actor.user.id }, data: { blocked: true } });
    await expect(runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, () => Promise.reject(new Error("must not run")))).rejects.toMatchObject({ code: "PRODUCT_EDIT_FORBIDDEN" });
    await expect(changeEditLease(strapi, product.id, a, "takeover", { editorInstanceId: randomUUID(), expectedGeneration: original.proof.generation })).rejects.toMatchObject({ code: "EDIT_TAKEOVER_FORBIDDEN" });
  });

  it("rejects native Content Manager bulk deletes and unguarded homepage changes", async () => {
    const { product, variation, a } = await fixture(); await acquire(product.id, a);
    const ctx = { state: { user: { id: a.actor.user.id } } };
    await expect(strapi.requestContext.run(ctx, () => strapi.db.query("api::product.product").deleteMany({ where: { id: product.id } }))).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
    await expect(strapi.requestContext.run(ctx, () => strapi.db.query("api::product-stock.product-stock").deleteMany({ where: { id: variation.stockId } }))).rejects.toMatchObject({ code: "EDIT_LEASE_LOST" });
    let settings = await strapi.db.query("api::settings.settings").findOne({ where: {} });
    if (!settings) settings = await strapi.db.query("api::settings.settings").create({ data: {} });
    await expect(strapi.requestContext.run(ctx, () => strapi.entityService.update("api::settings.settings", settings.id, { data: { homeNewestProductIds: [product.id], HomepageProductsRevision: 500 } }))).rejects.toMatchObject({ code: "HOMEPAGE_EDITOR_REQUIRED" });
    expect(await title(product.id)).toBeTruthy();
  });

  it("protects shared media through the upload service used by both admin surfaces", async () => {
    const { product, a } = await fixture(); const original = await acquire(product.id, a);
    const file = await strapi.db.query("plugin::upload.file").create({ data: { name: "fixture.png", hash: randomUUID(), ext: ".png", mime: "image/png", size: 1, url: "/fixture.png", provider: "local" } });
    try {
      const compiled = require(`${process.env.INTEGRATION_DIST_DIR}/src/utils/catalogEdit`);
      const ctx = { state: { user: { id: a.actor.user.id } } };
      await strapi.requestContext.run(ctx, () => compiled.runCatalogMutation(strapi, [product.id], { kind: "human", editor: a, proof: original.proof }, () => strapi.entityService.update("api::product.product", product.id, { data: { CoverImage: file.id } })));
      const upload = strapi.plugin("upload").service("upload");
      await expect(upload.remove(file)).rejects.toMatchObject({ code: "PRODUCT_MEDIA_IN_USE" });
      await expect(upload.replace(file.id, { data: {}, file: {} })).rejects.toMatchObject({ code: "PRODUCT_MEDIA_IN_USE" });
      await expect(upload.upload({ data: { ref: "api::product.product", refId: product.id, field: "Media" }, files: [] })).rejects.toMatchObject({ code: "PRODUCT_MEDIA_EDITOR_REQUIRED" });
      await expect(upload.uploadToEntity({ model: "api::product.product", id: product.id, field: "Media" }, [])).rejects.toMatchObject({ code: "PRODUCT_MEDIA_EDITOR_REQUIRED" });
    } finally {
      await strapi.db.query("api::product.product").update({ where: { id: product.id }, data: { CoverImage: null } });
      await strapi.db.query("plugin::upload.file").delete({ where: { id: file.id } });
    }
  });

  it("allows deletion of an empty category while rejecting inverse membership writes", async () => {
    const { a } = await fixture(); const category = await f.createCategory();
    const middleware = require(`${process.env.INTEGRATION_DIST_DIR}/src/middlewares/catalog-edit`).default({ resource: "category-associations" }, { strapi });
    const ctx: any = { params: { id: String(category.id) }, status: 200, state: { user: { id: a.actor.user.id }, betterAuthSessionId: a.sessionId }, request: { method: "DELETE", body: {} }, set: jest.fn() };
    await strapi.requestContext.run(ctx, () => middleware(ctx, () => strapi.db.query("api::product-category.product-category").delete({ where: { id: category.id } })));
    expect(ctx.status).toBe(200);
    expect(await strapi.db.query("api::product-category.product-category").findOne({ where: { id: category.id } })).toBeNull();
    const another = await f.createCategory();
    await expect(strapi.requestContext.run(ctx, () => strapi.db.query("api::product-category.product-category").update({ where: { id: another.id }, data: { products: [] } }))).rejects.toMatchObject({ code: "CATALOG_INVERSE_RELATION_FORBIDDEN" });
  });

  it("protects direct stock deletion from reservations on the actual guarded route", async () => {
    const { product, variation, a } = await fixture(); const original = await acquire(product.id, a);
    await strapi.db.connection("product_stocks").where({ id: variation.stockId }).update({ reserved_count: 1 });
    const headers = { "x-product-edit-token": original.proof.token, "x-product-edit-instance": original.proof.instanceId, "x-product-edit-generation": String(original.proof.generation), "x-product-expected-revision": "0" };
    const ctx: any = { params: { id: String(variation.stockId) }, status: 200, state: { user: { id: a.actor.user.id }, betterAuthSessionId: a.sessionId }, request: { method: "DELETE", body: {}, headers }, get: (key: string) => headers[key.toLowerCase()] || "", set: jest.fn() };
    const middleware = require(`${process.env.INTEGRATION_DIST_DIR}/src/middlewares/catalog-edit`).default({ resource: "stock", uid: "api::product-stock.product-stock" }, { strapi });
    await strapi.requestContext.run(ctx, () => middleware(ctx, () => strapi.controller("api::product-stock.product-stock").delete(ctx)));
    expect(ctx.status).toBe(409); expect(ctx.body.error.details.code).toBe("PRODUCT_STOCK_RESERVED");
    expect(await strapi.db.connection("product_stocks").where({ id: variation.stockId }).first()).toBeTruthy();
  });
});
