import { hasCapability } from "@repo/auth-core";
import {
  CatalogEditError, catalogMutationContext, changeEditLease, parseEditProof,
  readEditPresence, runCatalogMutation, sendCatalogEditError, staffEditor,
  rejectCatalogMutationAudit, type StaffEditor,
} from "../../../utils/catalogEdit";
import { requireCapability } from "../../../utils/adminAuthorization";
import { loadEditorSnapshot } from "../services/product-editor-snapshot";
import { canonicalizeAdminSignature } from "../../product-variation/controllers/product-variation";
import { saveEditorHomepage } from "../services/product-editor-homepage";
import { recordAdminAudit } from "../../../utils/adminAudit";
import { resolveAuditActor } from "../../../utils/audit";
import { resolveUserFullName } from "../../../utils/userDisplayName";
import { isTrustedWordPressMigrationRequest } from "../../../utils/migration-context";

const VARIATION = "api::product-variation.product-variation";
const STOCK = "api::product-stock.product-stock";
const HELPER = "api::product-size-helper.product-size-helper";
const idOf = (row: any) => Number(row?.id ?? row?.data?.id ?? row);

async function limitClaims(ctx: any, productId: number, takeover: boolean) {
  const { RedisClient } = await import("../../../index");
  const { consumeRedisTokenBucket } = await import("../../issue-report/lib/token-bucket");
  const redis = await RedisClient;
  const userId = Number(ctx.state.user.id);
  const result = await consumeRedisTokenBucket(redis, `product-edit:claim:${userId}`, { capacity: 10, refillMs: 6000, ttlMs: 120000 });
  if (!result.allowed) throw new CatalogEditError("EDIT_LEASE_RATE_LIMITED", 429, { retryAfterSeconds: Math.ceil(result.retryAfterSeconds) });
  if (takeover) {
    const perProduct = await consumeRedisTokenBucket(redis, `product-edit:take:${userId}:${productId}`, { capacity: 3, refillMs: 20000, ttlMs: 120000 });
    if (!perProduct.allowed) throw new CatalogEditError("EDIT_LEASE_RATE_LIMITED", 429, { retryAfterSeconds: Math.ceil(perProduct.retryAfterSeconds) });
  }
}

function object(value: any): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CatalogEditError("EDITOR_PAYLOAD_INVALID", 400);
  return value;
}

function requireFields(data: Record<string, any>, fields: string[]) {
  if (Object.keys(data).some((key) => !fields.includes(key))) throw new CatalogEditError("EDITOR_PROTECTED_FIELD", 400);
}

/**
 * The editor writes stock with a revision-guarded raw update, which skips the product-stock
 * lifecycle. Record what that lifecycle used to: a stock log row and, for staff, the
 * "from X to Y" admin audit row. Both join the catalog transaction, so a rolled-back save
 * leaves no trace and a committed one always has its record.
 */
async function recordEditorStockChange(strapi: any, context: any, change: { stockId: number; productId: number; variationId: number; previous: number; current: number; created: boolean }) {
  const { stockId, productId, variationId, previous, current, created } = change;
  if (previous === current || isTrustedWordPressMigrationRequest()) return; // the lifecycle skipped importer writes too
  const delta = Math.abs(current - previous);
  const type = current > previous ? "Add" : "Minus";
  // A created stock row already gets its "Initial stock" log from the product-stock lifecycle.
  if (!created) {
    await strapi.entityService.create("api::product-stock-log.product-stock-log", {
      data: { product_stock: stockId, Count: delta, Type: type, Description: "Stock updated" },
    });
  }
  const editor: StaffEditor | undefined = context.writer.kind === "system" ? undefined : context.writer.editor;
  if (!editor) return; // Jobs and imports have no staff actor; the old lifecycle skipped them too.
  const request = resolveAuditActor();
  await recordAdminAudit(strapi, {
    resourceType: "Stock",
    resourceId: stockId,
    action: "Adjust", // a created row is logged as 0 → N so it keeps the inventory_changed event
    title: "موجودی تغییر کرد",
    message: `موجودی ${stockId} از ${previous} به ${current} تغییر یافت`,
    messageEn: `Stock ${stockId} changed from ${previous} to ${current}`,
    severity: "info",
    changes: { Count: { from: previous, to: current } },
    metadata: { previous, current, delta, type, productId, variationId, source: "product-editor" },
    actor: { id: Number(editor.actor.user.id), role: editor.actor.role, name: resolveUserFullName(editor.actor.user) || editor.actor.user.username || null },
    ip: request.ip,
    userAgent: request.userAgent,
    trx: context.trx,
  });
}

export async function saveEditorStock(strapi: any, productId: number, variationId: number, input: any): Promise<any> {
  const context = catalogMutationContext();
  if (!context?.ids.includes(productId)) throw new CatalogEditError("CATALOG_GUARD_REQUIRED", 500);
  const data = object(input);
  requireFields(data, ["id", "Count", "expectedStockRevision"]);
  if (!Number.isInteger(data.Count) || data.Count < 0 || data.Count > 1000) throw new CatalogEditError("PRODUCT_STOCK_INVALID", 400);
  const variation = await strapi.db.query(VARIATION).findOne({ where: { id: variationId }, populate: { product: true, product_stock: true } });
  if (idOf(variation?.product) !== productId) throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
  const existing = variation.product_stock;
  if (existing) {
    if (data.id !== undefined && Number(data.id) !== existing.id) throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
    const expected = Number(data.expectedStockRevision);
    if (!Number.isSafeInteger(expected) || expected < 0 || data.expectedStockRevision === undefined) throw new CatalogEditError("PRODUCT_STOCK_VERSION_CONFLICT");
    // Lock first so the count read here is the one this update replaces.
    const before = await context.trx("product_stocks").where({ id: existing.id }).forUpdate().first("count");
    const rows = await context.trx("product_stocks").where({ id: existing.id, stock_revision: expected })
      .whereRaw("COALESCE(reserved_count, 0) <= ?", [data.Count]).update({ count: data.Count }).returning(["id", "count", "stock_revision"]);
    if (!rows.length) throw new CatalogEditError("PRODUCT_STOCK_VERSION_CONFLICT");
    await recordEditorStockChange(strapi, context, { stockId: existing.id, productId, variationId, previous: Number(before?.count ?? 0), current: data.Count, created: false });
    return rows[0];
  }
  if (data.id !== undefined) throw new CatalogEditError("PRODUCT_STOCK_VERSION_CONFLICT");
  const created = await strapi.entityService.create(STOCK, { data: { Count: data.Count, product_variation: variationId } });
  await recordEditorStockChange(strapi, context, { stockId: Number(created.id), productId, variationId, previous: 0, current: data.Count, created: true });
  return created;
}

async function saveVariation(strapi: any, ctx: any, productId: number, variationId: number | null, input: any, stock?: any) {
  const data = object(input);
  requireFields(data, ["SKU", "Price", "DiscountPrice", "IsPublished", "product_variation_color", "product_variation_size", "product_variation_model", "selected_attribute_terms"]);
  if (("Price" in data || "DiscountPrice" in data || "SKU" in data) && !(await requireCapability(ctx, strapi, "product.variation.manage"))) throw new CatalogEditError("PRODUCT_VARIATION_FORBIDDEN", 403);
  if (stock && !(await requireCapability(ctx, strapi, "product.stock.update"))) throw new CatalogEditError("PRODUCT_STOCK_FORBIDDEN", 403);
  if (!(await requireCapability(ctx, strapi, "product.variation.manage"))) throw new CatalogEditError("PRODUCT_VARIATION_FORBIDDEN", 403);
  if (variationId) {
    const existing = await strapi.db.query(VARIATION).findOne({ where: { id: variationId }, populate: { product: true } });
    if (idOf(existing?.product) !== productId) throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
  }
  const signatureCtx = Object.create(ctx);
  Object.defineProperty(signatureCtx, "params", { value: { id: variationId }, writable: true });
  const signatureRequest = Object.create(ctx.request);
  Object.defineProperty(signatureRequest, "body", { value: { data: { ...data, ...(!variationId ? { product: productId } : {}) } }, writable: true });
  Object.defineProperty(signatureCtx, "request", { value: signatureRequest });
  if (!(await canonicalizeAdminSignature(signatureCtx, strapi, !variationId))) throw new CatalogEditError("PRODUCT_VARIATION_INVALID", 400);
  const canonical = signatureCtx.request.body.data;
  const row = variationId
    ? await strapi.entityService.update(VARIATION, variationId, { data: canonical })
    : await strapi.entityService.create(VARIATION, { data: canonical });
  if (stock) await saveEditorStock(strapi, productId, row.id, stock);
  return row;
}

export function productEditorActions(strapi: any) {
  const leaseAction = (action: string) => async (ctx: any) => {
    let editor: StaffEditor | undefined;
    const productId = Number(ctx.params.id);
    try {
      editor = await staffEditor(ctx, strapi);
      if (!hasCapability(editor.actor.role, "product.update")) throw new CatalogEditError(action === "takeover" ? "EDIT_TAKEOVER_FORBIDDEN" : "PRODUCT_EDIT_FORBIDDEN", 403);
      if (action === "acquire" || action === "takeover") await limitClaims(ctx, productId, action === "takeover");
      const result = await changeEditLease(strapi, productId, editor, action, ctx.request.body?.data || ctx.request.body,
        ["renew", "release"].includes(action) ? parseEditProof(ctx, false) : undefined,
        () => loadEditorSnapshot(strapi, productId));
      ctx.set("Cache-Control", "private, no-store");
      ctx.body = { data: result };
    } catch (error) {
      if (error instanceof CatalogEditError) {
        if (action === "acquire" || action === "takeover") await rejectCatalogMutationAudit(strapi, editor, [productId], error);
        sendCatalogEditError(ctx, error);
      }
      else { ctx.status = 503; ctx.body = { error: { status: 503, name: "CatalogEditUnavailable", message: "EDIT_LEASE_UNAVAILABLE", details: { code: "EDIT_LEASE_UNAVAILABLE" } } }; }
    }
  };
  return {
    editAcquire: leaseAction("acquire"), editRenew: leaseAction("renew"), editTakeover: leaseAction("takeover"), editRelease: leaseAction("release"),
    async editLease(ctx: any) {
      try {
        const editor = await staffEditor(ctx, strapi);
        let proof;
        try { proof = parseEditProof(ctx, false); } catch { /* Authorized observers have no proof. */ }
        ctx.body = { data: await readEditPresence(strapi, Number(ctx.params.id), editor, proof) };
        ctx.set("Cache-Control", "private, no-store");
      } catch (error) { sendCatalogEditError(ctx, error); }
    },
    async editSnapshot(ctx: any) {
      try {
        await staffEditor(ctx, strapi);
        const id = Number(ctx.params.id);
        ctx.body = await strapi.db.transaction(async ({ trx }: any) => {
          const product = await trx("products").where({ id }).forUpdate().first();
          if (!product || product.purged_at) throw new CatalogEditError("PRODUCT_NOT_FOUND", 404);
          return { data: await loadEditorSnapshot(strapi, id) };
        });
        ctx.set("Cache-Control", "private, no-store");
      } catch (error) { sendCatalogEditError(ctx, error); }
    },
    async editorVariation(ctx: any) {
      const body = object(ctx.request.body);
      await saveVariation(strapi, ctx, Number(ctx.params.id), Number(ctx.params.variationId), body.data, body.stock);
      ctx.state.catalogSnapshotRequested = true;
      ctx.body = { data: {} };
    },
    async editorHomepage(ctx: any) {
      const data = await saveEditorHomepage(strapi, Number(ctx.params.id), ctx.request.body?.data);
      ctx.body = { data, meta: { homepageProductsRevision: Number(data.attributes.HomepageProductsRevision) } };
    },
    async editorBulkStock(ctx: any) {
      if (!(await requireCapability(ctx, strapi, "product.stock.update"))) return;
      try {
        const editor = await staffEditor(ctx, strapi);
        const items = ctx.request.body?.data?.items;
        if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new CatalogEditError("PRODUCT_STOCK_BATCH_INVALID", 400);
        const results: any[] = [];
        for (const item of items) {
          const stockId = Number(item.stockId);
          try {
            const stock = await strapi.db.query(STOCK).findOne({ where: { id: stockId }, populate: { product_variation: { populate: { product: true } } } });
            const productId = idOf(stock?.product_variation?.product);
            const result = await runCatalogMutation(strapi, [productId], { kind: "transient", editor }, () => saveEditorStock(strapi, productId, stock.product_variation.id, { id: stockId, Count: item.Count, expectedStockRevision: item.expectedStockRevision }));
            results.push({ stockId, success: true, editRevision: result.revisions.get(productId), StockRevision: Number(result.value.stock_revision) });
          } catch (error) {
            if (!(error instanceof CatalogEditError)) throw error;
            await rejectCatalogMutationAudit(strapi, editor, [], error);
            results.push({ stockId, success: false, errorCode: error.code });
          }
        }
        ctx.body = { data: { results } };
      } catch (error) { sendCatalogEditError(ctx, error); }
    },
  };
}

export async function saveProductEditor(ctx: any, strapi: any, saveTopLevel: () => Promise<unknown>) {
  const body = object(ctx.request.body);
  const productId = Number(ctx.params.id);
  const response = await saveTopLevel();
  // The core controller returns its response. The outer route adapter normally
  // installs it, but this aggregate command must do so before checking Koa's
  // initial 404 status and performing the related writes.
  if (response !== undefined && ctx.body == null) ctx.body = response;
  if (ctx.status >= 400) return;
  if (body.sizeGuide) {
    if (!(await requireCapability(ctx, strapi, "product.size-guide.manage"))) throw new CatalogEditError("PRODUCT_SIZE_GUIDE_FORBIDDEN", 403);
    const guide = object(body.sizeGuide);
    requireFields(guide, ["id", "Helper"]);
    const existing = await strapi.db.query(HELPER).findOne({ where: { product: { id: productId } } });
    if (guide.id !== undefined && Number(guide.id) !== existing?.id) throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
    if (existing) await strapi.entityService.update(HELPER, existing.id, { data: { Helper: guide.Helper } });
    else await strapi.entityService.create(HELPER, { data: { product: productId, Helper: guide.Helper } });
  }
  if (body.simpleVariation) {
    const simple = object(body.simpleVariation);
    const { id, stock, ...data } = simple;
    if (!id && !data.SKU) data.SKU = `INFINITY-${productId}`;
    const product = await strapi.db.query("api::product.product").findOne({ where: { id: productId }, populate: { product_variations: true } });
    if (product.ProductType !== "Simple" && !product.IsSimpleProduct) throw new CatalogEditError("SIMPLE_PRODUCT_REQUIRED", 400);
    const variation = await saveVariation(strapi, ctx, productId, id ? Number(id) : null, data, stock);
    for (const other of product.product_variations || []) {
      if (other.id !== variation.id && other.IsPublished) await strapi.entityService.update(VARIATION, other.id, { data: { IsPublished: false } });
    }
  }
  ctx.state.catalogSnapshotRequested = true;
  ctx.body = { data: {} };
}
