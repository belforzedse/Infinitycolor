// @ts-nocheck
import { factories } from "@strapi/strapi";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";
import { CatalogEditError, catalogMutationContext } from "../../../utils/catalogEdit";
import { saveEditorStock } from "../../product/controllers/product-editor";

export default factories.createCoreController("api::product-stock.product-stock", ({ strapi }) => ({
  async create(ctx) {
    const data = ctx.request?.body?.data || {};
    if ("StockRevision" in data || "reservedCount" in data) throw new CatalogEditError("EDITOR_PROTECTED_FIELD", 400);
    if (!(await enforceOperationalDataFields(ctx, strapi, ["Count", "product_variation"]))) {
      return;
    }
    const id = Number(data.product_variation?.id ?? data.product_variation?.connect?.[0]?.id ?? data.product_variation?.connect?.[0] ?? data.product_variation);
    const variation = await strapi.db.query("api::product-variation.product-variation").findOne({ where: { id }, populate: { product_stock: true } });
    if (variation?.product_stock) throw new CatalogEditError("PRODUCT_STOCK_ALREADY_EXISTS", 409);
    return super.create(ctx);
  },

  async update(ctx) {
    if (!(await enforceOperationalDataFields(ctx, strapi, ["Count"]))) return;
    const context = catalogMutationContext();
    if (!context) throw new CatalogEditError("CATALOG_GUARD_REQUIRED", 500);
    const stock = await strapi.db.query("api::product-stock.product-stock").findOne({ where: { id: Number(ctx.params.id) }, populate: { product_variation: true } });
    const data = ctx.request?.body?.data || {};
    if (Object.keys(data).some((key) => key !== "Count")) throw new CatalogEditError("EDITOR_PROTECTED_FIELD", 400);
    await saveEditorStock(strapi, context.ids[0], stock.product_variation.id, {
      id: Number(ctx.params.id), Count: data.Count,
      expectedStockRevision: context.writer.kind === "system" ? stock.StockRevision : ctx.get("X-Product-Expected-Stock-Revision"),
    });
    const updated = await strapi.db.query("api::product-stock.product-stock").findOne({ where: { id: Number(ctx.params.id) } });
    return this.transformResponse(await this.sanitizeOutput(updated, ctx));
  },

  async delete(ctx) {
    const context = catalogMutationContext();
    if (!context) throw new CatalogEditError("CATALOG_GUARD_REQUIRED", 500);
    const id = Number(ctx.params.id);
    const row = await context.trx(strapi.db.metadata.get("api::product-stock.product-stock").tableName)
      .where({ id }).forUpdate().first();
    if (!row) return ctx.notFound("Product stock not found");
    if (Number(row.reserved_count || 0) > 0) throw new CatalogEditError("PRODUCT_STOCK_RESERVED", 409);
    const deleted = await strapi.db.query("api::product-stock.product-stock").delete({ where: { id } });
    return this.transformResponse(await this.sanitizeOutput(deleted, ctx));
  },
}));
