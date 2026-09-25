import { resolveAuditActor } from "../../../../utils/audit";
import { logManualActivity } from "../../../../utils/manualAdminActivity";
import { clearAllProductCaches } from "../../../../utils/productOriginCache";

// A colour is a shared row with no product of its own, so the audit entry is not
// tied to one product (the old `result.product` / `result.Name` never existed and
// logged «رنگ undefined»).
const colorLabel = (result: any) => result?.Title || `#${result?.id}`;

export default {
  async afterCreate(event) {
    const { result } = event;
    const actor = resolveAuditActor(event as any);
    if (!result?.id || !actor.userId) return;

    await logManualActivity(strapi, {
      resourceType: "Product",
      resourceId: undefined,
      action: "Create",
      title: "رنگ جدید اضافه شد",
      message: `رنگ ${colorLabel(result)} اضافه شد`,
      messageEn: `Color ${colorLabel(result)} added`,
      severity: "success",
      metadata: { colorId: result.id },
      performedBy: { id: actor.userId },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  },

  async afterUpdate(event) {
    const { result } = event as any;
    // Every product using this colour renders it, and none of them was written,
    // so nothing else would refresh them before their caches expired.
    if (result?.id) await clearAllProductCaches(strapi, "product-variation-color");

    const actor = resolveAuditActor(event as any);
    if (!result?.id || !actor.userId) return;

    await logManualActivity(strapi, {
      resourceType: "Product",
      resourceId: undefined,
      action: "Update",
      title: "رنگ ویرایش شد",
      message: `رنگ ${colorLabel(result)} بروزرسانی شد`,
      messageEn: `Color ${colorLabel(result)} updated`,
      severity: "info",
      metadata: { colorId: result.id },
      performedBy: { id: actor.userId },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  },

  async afterDelete(event) {
    const id = (event as any)?.params?.where?.id;
    if (id) await clearAllProductCaches(strapi, "product-variation-color");
    const actor = resolveAuditActor(event as any);
    if (!id || !actor.userId) return;

    await logManualActivity(strapi, {
      resourceType: "Product",
      resourceId: null,
      action: "Delete",
      title: "رنگ حذف شد",
      message: `رنگ ${id} حذف شد`,
      messageEn: `Color ${id} deleted`,
      severity: "warning",
      metadata: { colorId: id },
      performedBy: { id: actor.userId },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  },
};

