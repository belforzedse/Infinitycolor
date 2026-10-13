import { hasCapability } from "@repo/auth-core";
import {
  CatalogEditError, parseEditProof, rejectCatalogMutationAudit, runCatalogMutation,
  sendCatalogEditError, staffEditor, type StaffEditor,
} from "../utils/catalogEdit";
import { apiTokenCredentials } from "../utils/adminAuthorization";
import { isTrustedWordPressMigrationRequest } from "../utils/migration-context";
import { loadEditorSnapshot } from "../api/product/services/product-editor-snapshot";

const idOf = (value: any): number => Number(value?.id ?? value?.data?.id ?? value?.connect?.[0]?.id ?? value?.connect?.[0] ?? value);

export async function catalogProductIds(ctx: any, strapi: any, resource: string, uid?: string): Promise<number[]> {
  if (resource === "product") return [Number(ctx.params.id)];
  if (resource === "category-associations") {
    const rows = await strapi.db.query("api::product.product").findMany({
      where: { $or: [{ product_main_category: { id: Number(ctx.params.id) } }, { product_other_categories: { id: Number(ctx.params.id) } }] }, select: ["id"],
    });
    return rows.map((row: any) => Number(row.id));
  }
  const creating = ctx.request.method === "POST";
  const data = ctx.request?.body?.data || {};
  const row = creating ? data : await strapi.db.query(uid).findOne({
    where: { id: Number(ctx.params.id) },
    populate: resource === "stock" ? { product_variation: { populate: { product: true } } }
      : resource === "term" ? { product_attribute: { populate: { owner_product: true } } }
      : resource === "attribute" ? { owner_product: true } : { product: true },
  });
  if (!row) throw new CatalogEditError("CATALOG_ENTITY_NOT_FOUND", 404);
  if (!creating) {
    for (const key of ["product", "product_variation", "owner_product", "product_attribute"]) {
      if (key in data && idOf(data[key]) !== idOf(row[key])) throw new CatalogEditError("CATALOG_PARENT_CHANGE_FORBIDDEN", 400);
    }
  }
  if (resource === "stock") {
    const variation = creating
      ? await strapi.db.query("api::product-variation.product-variation").findOne({ where: { id: idOf(data.product_variation) }, populate: { product: true } })
      : row.product_variation;
    return [idOf(variation?.product)];
  }
  if (resource === "attribute") return row.owner_product ? [idOf(row.owner_product)] : [];
  if (resource === "term") {
    const attribute = creating
      ? await strapi.db.query("api::product-attribute.product-attribute").findOne({ where: { id: idOf(data.product_attribute) }, populate: { owner_product: true } })
      : row.product_attribute;
    return attribute?.owner_product ? [idOf(attribute.owner_product)] : [];
  }
  return [idOf(row.product)];
}

export default (config: { resource: string; uid?: string }, { strapi }: any) => async (ctx: any, next: () => Promise<unknown>) => {
  let editor: StaffEditor | undefined;
  let ids: number[] = [];
  try {
    ids = await catalogProductIds(ctx, strapi, config.resource, config.uid);
    // Global taxonomy definitions have their own existing authorization. Only
    // attributes owned by one product participate in its editing session.
    if (!ids.length) {
      if (config.resource !== "category-associations") return next();
      return strapi.db.transaction(async ({ trx }: any) => {
        await trx(strapi.db.metadata.get("api::product-category.product-category").tableName).where({ id: Number(ctx.params.id) }).forUpdate().first();
        if ((await catalogProductIds(ctx, strapi, config.resource)).length) throw new CatalogEditError("CATALOG_ASSOCIATIONS_CHANGED", 409);
        ctx.state.catalogEmptyCategoryDelete = true;
        await next();
        if (ctx.status >= 400) throw new CatalogEditError("CATALOG_MUTATION_REJECTED", ctx.status, { response: ctx.body });
      });
    }
    const system = isTrustedWordPressMigrationRequest() || apiTokenCredentials(ctx);
    const writer = system ? { kind: "system" as const, command: "catalog-import" as const }
      : config.resource === "category-associations"
        ? { kind: "transient" as const, editor: editor = await staffEditor(ctx, strapi) }
        : { kind: "human" as const, editor: editor = await staffEditor(ctx, strapi), proof: parseEditProof(ctx) };
    if (editor && !hasCapability(editor.actor.role, "product.update")) throw new CatalogEditError("PRODUCT_EDIT_FORBIDDEN", 403);
    const result = await runCatalogMutation(strapi, ids, writer, async () => {
      if (config.resource === "category-associations") {
        await catalogMutationCategoryLock(ctx, strapi, ids);
      }
      await next();
      if (ctx.status >= 400) throw new CatalogEditError("CATALOG_MUTATION_REJECTED", ctx.status, { response: ctx.body });
      return undefined;
    }, async () => {
      if (ctx.state.catalogSnapshotRequested) ctx.body = { data: await loadEditorSnapshot(strapi, ids[0]) };
    });
    if (ctx.body && typeof ctx.body === "object") ctx.body.meta = { ...(ctx.body.meta || {}), editRevision: result.revisions.get(ids[0]) };
    ctx.set("Cache-Control", "private, no-store");
  } catch (error) {
    if (error instanceof CatalogEditError) {
      await rejectCatalogMutationAudit(strapi, editor, ids, error);
      if (error.code === "CATALOG_MUTATION_REJECTED" && error.details.response) {
        ctx.status = error.status; ctx.body = error.details.response; return;
      }
    }
    sendCatalogEditError(ctx, error);
  }
};

async function catalogMutationCategoryLock(ctx: any, strapi: any, ids: number[]) {
  const { catalogMutationContext } = await import("../utils/catalogEdit");
  const context = catalogMutationContext()!;
  await context.trx(strapi.db.metadata.get("api::product-category.product-category").tableName).where({ id: Number(ctx.params.id) }).forUpdate().first();
  if ((await catalogProductIds(ctx, strapi, "category-associations")).some((id) => !ids.includes(id))) throw new CatalogEditError("CATALOG_ASSOCIATIONS_CHANGED", 409);
}
