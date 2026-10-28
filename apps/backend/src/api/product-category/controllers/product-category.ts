// @ts-nocheck
/**
 * product-category controller
 */

import { factories } from "@strapi/strapi";
import { rejectCatalogInverseRelations } from "../../../utils/catalogOwnership";
import { writeAuditEvent } from "../../../audit/writer";
import { getAuditContext } from "../../../utils/audit-context";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";
import {
  OPERATIONAL_CATEGORY_FIELDS,
  remapLegacyCategoryParentField,
} from "../lib/write-payload";

export default factories.createCoreController(
  "api::product-category.product-category",
  ({ strapi }) => ({
    async create(ctx) {
      rejectCatalogInverseRelations("api::product-category.product-category", ctx.request?.body?.data || {});
      remapLegacyCategoryParentField(ctx?.request?.body?.data);
      if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_CATEGORY_FIELDS))) return;
      return super.create(ctx);
    },

    async update(ctx) {
      rejectCatalogInverseRelations("api::product-category.product-category", ctx.request?.body?.data || {});
      remapLegacyCategoryParentField(ctx?.request?.body?.data);
      if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_CATEGORY_FIELDS))) return;
      return super.update(ctx);
    },

    /**
     * Delete a category and reassign its products to a target category.
     * Requires targetCategoryId in request body.
     * Blocks deletion if category has child categories.
     */
    async deleteWithReassign(ctx) {
      const id = Number(ctx.params.id);
      const { targetCategoryId } = ctx.request.body ?? {};

      if (!Number.isInteger(id) || id <= 0) {
        return ctx.badRequest("Invalid category ID");
      }

      const targetId =
        typeof targetCategoryId === "number" ? targetCategoryId : Number(targetCategoryId);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return ctx.badRequest("targetCategoryId is required and must be a positive integer");
      }

      if (id === targetId) {
        return ctx.badRequest("Target category must differ from the category being deleted");
      }

      const category = await strapi.entityService.findOne(
        "api::product-category.product-category",
        id,
        { populate: ["children"] },
      );

      if (!category) {
        return ctx.notFound("Category not found");
      }

      const targetCategory = await strapi.entityService.findOne(
        "api::product-category.product-category",
        targetId,
      );

      if (!targetCategory) {
        return ctx.badRequest("Target category not found");
      }

      const children = (category as { children?: unknown[] }).children;
      if (children && Array.isArray(children) && children.length > 0) {
        return ctx.badRequest(
          "امکان حذف دسته‌بندی دارای فرزند وجود ندارد. ابتدا دسته‌های فرزند را حذف کنید.",
        );
      }

      const categoryLabel = String((category as any).Title || (category as any).Slug || `#${id}`);
      const targetLabel = String(
        (targetCategory as any).Title || (targetCategory as any).Slug || `#${targetId}`,
      );
      const requestId = getAuditContext()?.requestId;

      const { reassignedCount } = await strapi.db.transaction(async ({ trx }) => {
        const productsWithMain = await strapi.db.query("api::product.product").findMany({
          where: { product_main_category: id },
          select: ["id"],
          transacting: trx,
        });

        for (const product of productsWithMain) {
          await strapi.entityService.update("api::product.product", product.id, {
            data: { product_main_category: targetId },
            transacting: trx,
          });
        }

        const productsWithOther = await strapi.db.query("api::product.product").findMany({
          where: {
            product_other_categories: {
              id,
            },
          },
          populate: ["product_other_categories"],
          transacting: trx,
        });

        for (const product of productsWithOther) {
          const others =
            (product as { product_other_categories?: { id: number }[] })
              .product_other_categories ?? [];
          const newOthers = others.filter((item) => item.id !== id).map((item) => item.id);
          await strapi.entityService.update("api::product.product", product.id, {
            data: { product_other_categories: newOthers },
            transacting: trx,
          });
        }

        const contents = await strapi.db
          .query("api::product-category-content.product-category-content")
          .findMany({
            where: { product_category: id },
            select: ["id"],
            transacting: trx,
          });

        for (const content of contents) {
          await strapi.db
            .query("api::product-category-content.product-category-content")
            .delete({ where: { id: content.id }, transacting: trx });
        }

        await strapi.db
          .query("api::product-category.product-category")
          .delete({ where: { id }, transacting: trx });

        const affectedProductCount = new Set([
          ...productsWithMain.map((product) => String(product.id)),
          ...productsWithOther.map((product) => String(product.id)),
        ]).size;

        await writeAuditEvent(
          strapi,
          {
            eventKey: "categories.deleted_with_reassignment",
            result: "success",
            target: {
              type: "category",
              id,
              label: categoryLabel,
              snapshot: { title: categoryLabel, slug: (category as any).Slug || null },
            },
            related: {
              type: "category",
              id: targetId,
              label: targetLabel,
              snapshot: {
                title: targetLabel,
                slug: (targetCategory as any).Slug || null,
              },
            },
            changes: [
              ...(productsWithMain.length > 0
                ? [{
                    field: "product_main_category",
                    label: "دسته‌بندی اصلی محصولات",
                    from: { id, label: categoryLabel },
                    to: { id: targetId, label: targetLabel },
                  }]
                : []),
              ...(productsWithOther.length > 0
                ? [{
                    field: "product_other_categories",
                    label: "ارجاع دسته‌بندی جانبی",
                    from: { id, label: categoryLabel },
                    to: null,
                  }]
                : []),
              {
                field: "category_status",
                label: "وضعیت دسته‌بندی",
                from: "موجود",
                to: "حذف‌شده",
              },
            ],
            metadata: {
              affectedProductCount,
              mainCategoryReassignedCount: productsWithMain.length,
              otherCategoryReferencesRemoved: productsWithOther.length,
              categoryContentRecordsDeleted: contents.length,
            },
            summaryFa: `دسته‌بندی «${categoryLabel}» حذف شد؛ دسته‌بندی اصلی ${productsWithMain.length} محصول به «${targetLabel}» منتقل و ارجاع جانبی از ${productsWithOther.length} محصول حذف شد`,
            summaryEn: `Category “${categoryLabel}” was deleted; ${productsWithMain.length} products moved to “${targetLabel}” as their main category and ${productsWithOther.length} secondary references were removed`,
            dedupeKey: requestId
              ? `category-delete-reassign:${id}:${targetId}:${requestId}`
              : null,
          },
          { trx },
        );

        return { reassignedCount: productsWithMain.length };
      });

      return {
        data: { success: true, reassignedCount },
      };
    },
  }),
);
