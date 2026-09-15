import { resolveAuditActor } from "../../../../utils/audit";
import {
  recordAdminAudit,
  markProductEditedByAdmin,
  type AdminAuditAction,
} from "../../../../utils/adminAudit";
import { generateUniqueProductSlug } from "../../../../utils/productSlug";
import { scheduleHomeProductsRevalidation } from "../../../../utils/homepageRevalidation";
import { isTrustedWordPressMigrationRequest } from "../../../../utils/migration-context";
import { triggerFrontendRevalidation } from "../../../../utils/revalidate";

type AuditAction = "Create" | "Update" | "Delete";
const PRODUCT_COUNTER_ONLY_FIELDS = new Set(["SeenCount"]);
const UPDATE_METADATA_FIELDS = new Set([
  "updatedAt",
  "updated_at",
  "updatedBy",
  "updated_by",
  "publishedAt",
  "published_at",
]);

function isCounterOnlyProductUpdate(data: Record<string, unknown> | undefined): boolean {
  if (!data || typeof data !== "object") return false;
  const fields = Object.keys(data).filter((field) => !UPDATE_METADATA_FIELDS.has(field));
  if (fields.length === 0) return false;
  return fields.every((field) => PRODUCT_COUNTER_ONLY_FIELDS.has(field));
}

// Mirrors OPERATIONAL_PRODUCT_FIELDS (controllers/product.ts) — every field an admin can
// actually write via `PUT /products/:id`. The before/after diff used to only cover a handful
// of these (Title/Slug/Status/Description/CleaningTips/ReturnConditions/removedAt + main
// category/tags), so a save that only touched e.g. CoverImage or Media produced an empty diff:
// no product-log entry, no admin-audit entry, and no LastEditedByAdminAt stamp. beforeUpdate
// and afterUpdate must fetch byte-identical shapes or the diff sees phantom changes.
const PRODUCT_DIFF_SNAPSHOT_SPEC = {
  fields: [
    "Title",
    "Slug",
    "Status",
    "Description",
    "CleaningTips",
    "ReturnConditions",
    "removedAt",
    "Weight",
    "ProductType",
    "IsSimpleProduct",
  ] as const,
  populate: {
    product_main_category: true,
    product_tags: true,
    // Relation-only fields: populated by id so the diff tracks the attached set/order
    // (an edit) without picking up unrelated metadata drift on the related records.
    CoverImage: { fields: ["id"] },
    Media: { fields: ["id"] },
    Files: { fields: ["id"] },
    product_other_categories: { fields: ["id"] },
    product_faqs: { fields: ["id"] },
    discounts: { fields: ["id"] },
    product_attribute_assignments: { fields: ["id"] },
    owned_product_attributes: { fields: ["id"] },
    product_size_helper: { fields: ["id"] },
  },
} as const;

/**
 * Invalidate the storefront caches that depend on a single product.
 *
 * Delegates to the shared helper so the storefront origins come from
 * configuration. This function previously hardcoded both the staging and the
 * production hostnames, which made every environment invalidate the other one's
 * cache with its own bearer token.
 */
async function triggerProductRevalidation(slug: string) {
  await triggerFrontendRevalidation({ path: slug, type: "product" }, "Product Lifecycle");
}

/**
 * Compute the field-level differences between two record snapshots.
 *
 * @param previous - The prior state of the record (field name → value).
 * @param current - The new state of the record (field name → value).
 * @returns An object mapping each changed field name to an object with `from` (previous value) and `to` (current value). The fields `"updatedAt"`, `"createdAt"`, `"id"`, and `"documentId"` are ignored.
 */
function diffChanges(
  previous: Record<string, any>,
  current: Record<string, any>
) {
  const changes: Record<string, { from: any; to: any }> = {};
  const keys = new Set([
    ...Object.keys(previous || {}),
    ...Object.keys(current || {}),
  ]);
  for (const key of keys) {
    if (
      key === "updatedAt" ||
      key === "createdAt" ||
      key === "id" ||
      key === "documentId"
    )
      continue;
    const beforeVal = previous?.[key];
    const afterVal = current?.[key];
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      changes[key] = { from: beforeVal, to: afterVal };
    }
  }
  return changes;
}

export default {
  async beforeCreate(event) {
    const { data } = event.params;

    // Trusted WooCommerce migrations preserve the source slug exactly,
    // including an empty value. Never invoke local slug generation here.
    if (isTrustedWordPressMigrationRequest()) {
      event.state = { ...(event.state || {}), migrationWrite: true };
      return;
    }

    // Seed the dedicated admin-edit timestamp at creation so it is never NULL (creation is the
    // baseline "last edited" moment). Real admin edits update it later; non-admin events never do.
    if (!data.LastEditedByAdminAt) {
      data.LastEditedByAdminAt = new Date();
    }

    // Auto-generate slug from Title if not provided
    // This must run BEFORE Strapi's uid field auto-generation to preserve Persian characters
    if (!data.Slug && data.Title) {
      try {
        data.Slug = await generateUniqueProductSlug(strapi, data.Title);
        strapi.log.info(`[Product Lifecycle] Auto-generated Persian slug for new product: "${data.Title}" -> "${data.Slug}"`);
      } catch (error) {
        strapi.log.error("[Product Lifecycle] Failed to generate product slug:", error);
        // Fallback to timestamp-based slug
        data.Slug = `product-${Date.now()}`;
      }
    } else if (data.Slug) {
      strapi.log.info(`[Product Lifecycle] Using provided slug: "${data.Slug}"`);
    }
  },

  async afterCreate(event) {
    const { result } = event;
    if (!result?.id) return;
    if (isTrustedWordPressMigrationRequest()) return;
    const actor = resolveAuditActor(event as any);

    await strapi.entityService.create("api::product-log.product-log" as any, {
      data: {
        product: result.id,
        performed_by: actor.userId,
        PerformedBy: actor.label || undefined,
        IP: actor.ip || undefined,
        UserAgent: actor.userAgent || undefined,
        Action: "Create" as AuditAction,
        Description: "Product created",
      },
    });

    // LastEditedByAdminAt is already seeded in beforeCreate; just record the audit entry (gated).
    await recordAdminAudit(strapi as any, {
      event,
      resourceType: "Product",
      resourceId: result.id,
      action: "Create",
      title: "محصول ایجاد شد",
      message: `محصول «${result.Title}» ایجاد شد`,
      messageEn: `Product #${result.id} created`,
      severity: "success",
      metadata: { productId: result.id, title: result.Title },
    });

    // Trigger revalidation if product has a slug and is active
    if (result.Slug && result.Status === "Active") {
      await triggerProductRevalidation(result.Slug);
    }
    scheduleHomeProductsRevalidation("product-create", {
      productId: result.id,
      slug: result.Slug,
      status: result.Status,
    });
  },

  async beforeUpdate(event) {
    const where = event?.params?.where || {};
    const id = (where && (where.id || where.documentId)) || null;
    if (!id) return;
    if (isTrustedWordPressMigrationRequest()) {
      event.state = { ...(event.state || {}), migrationWrite: true };
      return;
    }

    const { data } = event.params;
    if (isCounterOnlyProductUpdate(data)) {
      event.state = { ...(event.state || {}), counterOnlyUpdate: true };
      return;
    }

    const previous = await strapi.entityService.findOne(
      "api::product.product",
      id,
      // NOTE: AverageRating/RatingCount are intentionally excluded — they are recomputed by
      // customer reviews (a non-admin event) and must never count as an admin edit.
      PRODUCT_DIFF_SNAPSHOT_SPEC as any,
    );

    // Auto-generate slug if product doesn't have one and has a title
    // Also regenerate if Title changed and we want to update the slug
    if (!previous?.Slug && !data.Slug && (data.Title || previous?.Title)) {
      try {
        const title = data.Title || previous?.Title;
        data.Slug = await generateUniqueProductSlug(strapi, title, id as number);
        strapi.log.info(`[Product Lifecycle] Auto-generated Persian slug for product ${id}: "${title}" -> "${data.Slug}"`);
      } catch (error) {
        strapi.log.error(`[Product Lifecycle] Failed to generate slug for product ${id}:`, error);
      }
    } else if (data.Slug) {
      strapi.log.info(`[Product Lifecycle] Using provided slug for product ${id}: "${data.Slug}"`);
    }

    event.state = { ...(event.state || {}), previousProduct: previous };
  },

  async afterUpdate(event) {
    const { result, state } = event as any;
    if (!result?.id) return;
    if (state?.migrationWrite || isTrustedWordPressMigrationRequest()) return;
    if (state?.counterOnlyUpdate || isCounterOnlyProductUpdate((event as any)?.params?.data)) {
      return;
    }
    const actor = resolveAuditActor(event as any);

    const previous = state?.previousProduct || {};
    const current = await strapi.entityService.findOne(
      "api::product.product",
      result.id,
      // NOTE: AverageRating/RatingCount are intentionally excluded — they are recomputed by
      // customer reviews (a non-admin event) and must never count as an admin edit.
      PRODUCT_DIFF_SNAPSHOT_SPEC as any,
    );

    const changes = diffChanges(previous, current);
    if (Object.keys(changes).length === 0) return;

    await strapi.entityService.create("api::product-log.product-log" as any, {
      data: {
        product: result.id,
        performed_by: actor.userId,
        PerformedBy: actor.label || undefined,
        IP: actor.ip || undefined,
        UserAgent: actor.userAgent || undefined,
        Action: "Update" as AuditAction,
        Changes: changes,
        Description: "Product updated",
      },
    });

    // Record a single gated admin-audit entry. A soft-delete (removedAt set) or restore takes
    // priority, then a Status transition (Publish/Unpublish); otherwise it is a generic edit.
    const removedChange = changes.removedAt as { from?: unknown; to?: unknown } | undefined;
    const statusChange = changes.Status as { from?: unknown; to?: unknown } | undefined;
    let action: AdminAuditAction = "Update";
    let title = "محصول ویرایش شد";
    let messageEn = `Product #${result.id} was edited`;
    let isSoftDelete = false;
    if (removedChange && removedChange.to) {
      action = "Delete";
      title = "محصول حذف شد";
      messageEn = `Product #${result.id} was deleted`;
      isSoftDelete = true;
    } else if (removedChange && !removedChange.to) {
      title = "محصول بازیابی شد";
      messageEn = `Product #${result.id} was restored`;
    } else if (statusChange) {
      if (statusChange.to === "Active") {
        action = "Publish";
        title = "محصول منتشر شد";
        messageEn = `Product #${result.id} was published`;
      } else if (statusChange.to === "InActive") {
        action = "Unpublish";
        title = "محصول از انتشار خارج شد";
        messageEn = `Product #${result.id} was unpublished`;
      }
    }
    const changedFields = Object.keys(changes);
    const recordedUpdate = await recordAdminAudit(strapi as any, {
      event,
      resourceType: "Product",
      resourceId: result.id,
      action,
      title,
      message:
        action === "Update"
          ? `محصول #${result.id} ویرایش شد. تغییرات: ${changedFields.join("، ")}`
          : title,
      messageEn,
      severity: isSoftDelete ? "warning" : "info",
      changes,
      metadata: { productId: result.id, changedFields, isSoftDelete },
    });
    if (recordedUpdate) await markProductEditedByAdmin(strapi as any, result.id);

    // Trigger revalidation if product has a slug and is active
    // Get the current slug (may have changed in the update)
    // Use result.Slug first (updated value), then fallback to current.Slug
    const currentSlug = result.Slug || current?.Slug;
    const currentStatus = result.Status || current?.Status;

    // Every PDP URL that could still be serving stale content after this write must be
    // invalidated — not just the "became Active" case. A rename leaves the OLD slug's
    // cached response stale; an unpublish or soft-delete leaves the product's own PDP
    // stale (previously nothing fired revalidation for either, so the storefront could
    // keep serving a since-unpublished/deleted product until the 30s ISR window expired
    // on its own). Dedupe into a Set since some of these conditions can overlap.
    const slugsToRevalidate = new Set<string>();
    if (currentSlug && currentStatus === "Active") slugsToRevalidate.add(currentSlug);
    if (previous?.Slug && previous.Slug !== currentSlug) slugsToRevalidate.add(previous.Slug);
    if (statusChange && statusChange.from === "Active" && statusChange.to !== "Active") {
      const staleSlug = previous?.Slug || currentSlug;
      if (staleSlug) slugsToRevalidate.add(staleSlug);
    }
    if (removedChange?.to) {
      const staleSlug = previous?.Slug || currentSlug;
      if (staleSlug) slugsToRevalidate.add(staleSlug);
    }
    for (const slug of slugsToRevalidate) {
      await triggerProductRevalidation(slug);
    }
    scheduleHomeProductsRevalidation("product-update", {
      productId: result.id,
      slug: currentSlug,
      status: currentStatus,
      changedFields,
    });
  },

  async beforeDelete(event) {
    const where = event?.params?.where || {};
    const id = (where && (where.id || where.documentId)) || null;
    if (!id) return;
    if (isTrustedWordPressMigrationRequest()) {
      event.state = { ...(event.state || {}), migrationWrite: true };
      return;
    }
    // Capture the slug before the row disappears — afterDelete has nothing left to
    // query, and without it the deleted product's PDP was never invalidated at all.
    const existing = await strapi.entityService.findOne("api::product.product", id, {
      fields: ["Slug"],
    });
    event.state = {
      ...(event.state || {}),
      deletingProductId: id,
      deletingProductSlug: existing?.Slug,
    };
  },

  async afterDelete(event) {
    if ((event as any)?.state?.migrationWrite || isTrustedWordPressMigrationRequest()) return;
    const id = (event as any)?.state?.deletingProductId;
    if (!id) return;
    const deletingProductSlug = (event as any)?.state?.deletingProductSlug as string | undefined;
    const actor = resolveAuditActor(event as any);

    // Try to create product-log, but don't fail if product relation validation fails
    // (since the product was just deleted, the relation won't exist)
    try {
      await strapi.entityService.create("api::product-log.product-log" as any, {
        data: {
          product: id,
          performed_by: actor.userId,
          PerformedBy: actor.label || undefined,
          IP: actor.ip || undefined,
          UserAgent: actor.userAgent || undefined,
          Action: "Delete" as AuditAction,
          Description: "Product deleted",
        },
      });
    } catch (error: any) {
      // If validation fails because product doesn't exist (expected after deletion),
      // log a warning but don't fail the deletion
      if (error?.message?.includes("relation") || error?.message?.includes("do not exist")) {
        strapi.log.warn(
          `Product log creation skipped for deleted product ${id}: relation validation failed (expected)`
        );
      } else {
        // Re-throw unexpected errors
        strapi.log.error(`Failed to create product log for deleted product ${id}:`, error);
      }
    }

    await recordAdminAudit(strapi as any, {
      event,
      resourceType: "Product",
      resourceId: id,
      action: "Delete",
      title: "محصول حذف شد",
      message: `محصول #${id} برای همیشه حذف شد`,
      messageEn: `Product #${id} was permanently deleted`,
      severity: "warning",
      metadata: { productId: id, isSoftDelete: false },
    });

    if (deletingProductSlug) {
      await triggerProductRevalidation(deletingProductSlug);
    }
    scheduleHomeProductsRevalidation("product-delete", { productId: id });
  },
};
