import type { Strapi } from "@strapi/strapi";

import { recordAdminAudit } from "../utils/adminAudit";
import { resolveAuditActor } from "../utils/audit";
import { logAdminEvent, logOrderEvent } from "../utils/eventLogger";
import { scheduleHomeProductsRevalidation } from "../utils/homepageRevalidation";
import { asEntityId } from "../utils/lastEdited";
import {
  getTrustedWordPressMigrationSourceTimestamps,
  isTrustedWordPressMigrationRequest,
} from "../utils/migration-context";
import {
  notifyOrderCreatedSms,
  notifyOrderStatusSms,
  notifyShipmentTrackingSms,
} from "../services/sms";

type AuditAction = "Create" | "Update" | "Delete";

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
    ) {
      continue;
    }

    const beforeVal = previous?.[key];
    const afterVal = current?.[key];
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      changes[key] = { from: beforeVal, to: afterVal };
    }
  }

  return changes;
}

function registerOrderLifecycle(strapi: Strapi) {
  strapi.db.lifecycles.subscribe({
    models: ["api::order.order"],

    async afterCreate(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const { result } = event as any;
      if (!result?.id) return;

      const actor = resolveAuditActor(event as any);
      const userId = actor.userId || (event as any)?.state?.user?.id;

      await strapi.entityService.create("api::order-log.order-log" as any, {
        data: {
          order: result.id,
          performed_by: userId || null,
          Action: "Create" as AuditAction,
          Description: "Order created",
        },
      });

      const orderUserId = typeof result.user === "object" && result.user?.id
        ? result.user.id
        : typeof result.user === "number"
        ? result.user
        : userId;

      if (orderUserId) {
        await logOrderEvent(strapi as any, {
          category: "Action",
          orderId: result.id,
          orderStatus: result.Status,
          newStatus: result.Status,
          userId: orderUserId,
          performedBy: {
            id: actor.userId || undefined,
            name: actor.label || undefined,
          },
          audience: "user",
          metadata: {
            orderType: result.Type,
          },
        });

        try {
          const activityService = strapi.service("api::user-activity.user-activity") as any;
          const orderWithContract = await strapi.entityService.findOne(
            "api::order.order",
            result.id,
            {
              populate: { contract: true, order_items: true },
            }
          ) as any;
          const totalAmount = orderWithContract?.contract?.Amount
            ? Number(orderWithContract.contract.Amount)
            : orderWithContract?.Total
            ? Number(orderWithContract.Total)
            : 0;

          if (activityService?.logOrderPlaced) {
            await activityService.logOrderPlaced(orderUserId, result.id, totalAmount);
          }
        } catch (activityError) {
          strapi.log.error("Failed to log order placed to user activity", {
            orderId: result.id,
            userId: orderUserId,
            error: (activityError as Error).message,
          });
        }
      }

      void notifyOrderCreatedSms(strapi as any, Number(result.id)).catch((smsError) => {
        strapi.log.error("Failed to queue order-created SMS", {
          orderId: result.id,
          error: (smsError as Error)?.message || smsError,
        });
      });

      if (actor.userId && actor.label) {
        await logAdminEvent(strapi as any, {
          category: "Action",
          resourceType: "Order",
          resourceId: result.id,
          action: "Create",
          adminName: actor.label,
          adminId: actor.userId,
          audience: "admin",
          metadata: {
            orderType: result.Type,
            orderStatus: result.Status,
          },
        });
      }
    },

    async beforeUpdate(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const where = (event as any)?.params?.where || {};
      const id = (where && (where.id || where.documentId)) || null;
      if (!id) return;

      const previous = await strapi.entityService.findOne(
        "api::order.order",
        id,
        {
          fields: [
            "Status",
            "Date",
            "Type",
            "ShippingCost",
            "Description",
            "Note",
            "ShippingBarcode",
          ],
          populate: {
            user: true,
            contract: {
              populate: { contract_transactions: true },
            },
            shipping: true,
          },
        }
      );

      (event as any).state = { ...((event as any).state || {}), previousOrder: previous };
    },

    async afterUpdate(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const { result, state } = event as any;
      if (!result?.id) return;

      const previous = state?.previousOrder || {};
      const current = await strapi.entityService.findOne(
        "api::order.order",
        result.id,
        {
          fields: [
            "Status",
            "Date",
            "Type",
            "ShippingCost",
            "Description",
            "Note",
            "ShippingBarcode",
          ],
          populate: { user: true, contract: true, shipping: true },
        }
      );

      const changes = diffChanges(previous, current as any);
      if (Object.keys(changes).length === 0) return;

      const actor = resolveAuditActor(event as any);
      const userId = actor.userId || (event as any)?.state?.user?.id;

      await strapi.entityService.create("api::order-log.order-log" as any, {
        data: {
          order: result.id,
          performed_by: userId || null,
          Action: "Update" as AuditAction,
          Changes: changes,
          Description: "Order updated",
        },
      });

      const orderUserId = typeof (current as any)?.user === "object" && (current as any).user?.id
        ? (current as any).user.id
        : typeof (current as any)?.user === "number"
        ? (current as any).user
        : userId;

      const oldStatus = previous?.Status;
      const newStatus = (current as any)?.Status;
      const trackingChange = changes.ShippingBarcode as
        | { from?: unknown; to?: unknown }
        | undefined;
      const trackingCode =
        trackingChange?.to !== undefined && trackingChange.to !== null
          ? String(trackingChange.to)
          : (current as any)?.ShippingBarcode
          ? String((current as any).ShippingBarcode)
          : undefined;

      if (oldStatus !== newStatus && newStatus && orderUserId) {
        await logOrderEvent(strapi as any, {
          category: "StatusChange",
          orderId: result.id,
          orderStatus: newStatus,
          oldStatus,
          newStatus,
          userId: orderUserId,
          performedBy: {
            id: actor.userId || undefined,
            name: actor.label || undefined,
          },
          audience: "user",
          metadata: {
            changes,
          },
        });

        try {
          const activityService = strapi.service("api::user-activity.user-activity") as any;
          const normalizedStatus = newStatus?.toLowerCase();

          if (normalizedStatus === "shipment" && activityService?.logOrderShipped) {
            await activityService.logOrderShipped(orderUserId, result.id, trackingCode);
          } else if (normalizedStatus === "done" && activityService?.logOrderDelivered) {
            await activityService.logOrderDelivered(orderUserId, result.id);
          } else if (normalizedStatus === "cancelled" && activityService?.logOrderCancelled) {
            const reason = changes?.Description || changes?.Note || undefined;
            await activityService.logOrderCancelled(orderUserId, result.id, reason);
          }
        } catch (activityError) {
          strapi.log.error("Failed to log status change to user activity", {
            orderId: result.id,
            userId: orderUserId,
            oldStatus,
            newStatus,
            error: (activityError as Error).message,
          });
        }

        void notifyOrderStatusSms(strapi as any, {
          orderId: Number(result.id),
          oldStatus,
          newStatus,
          trackingCode,
          reason:
            typeof changes?.Description?.to === "string"
              ? changes.Description.to
              : typeof changes?.Note?.to === "string"
              ? changes.Note.to
              : undefined,
        }).catch((smsError) => {
          strapi.log.error("Failed to queue order-status SMS", {
            orderId: result.id,
            oldStatus,
            newStatus,
            error: (smsError as Error)?.message || smsError,
          });
        });
      } else if (trackingChange?.to && newStatus === "Shipment" && orderUserId) {
        void notifyShipmentTrackingSms(strapi as any, {
          orderId: Number(result.id),
          trackingCode: String(trackingChange.to),
        }).catch((smsError) => {
          strapi.log.error("Failed to queue shipment tracking SMS", {
            orderId: result.id,
            trackingCode: String(trackingChange.to),
            error: (smsError as Error)?.message || smsError,
          });
        });
      }

      if (actor.userId && actor.label && Object.keys(changes).length > 0) {
        await logAdminEvent(strapi as any, {
          category: "Action",
          resourceType: "Order",
          resourceId: result.id,
          action: "Update",
          adminName: actor.label,
          adminId: actor.userId,
          audience: "admin",
          metadata: {
            changes,
            oldStatus,
            newStatus,
          },
        });
      }
    },

    async beforeDelete(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const where = (event as any)?.params?.where || {};
      const id = (where && (where.id || where.documentId)) || null;
      if (!id) return;
      (event as any).state = { ...((event as any).state || {}), deletingOrderId: id };
    },

    async afterDelete(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const id = (event as any)?.state?.deletingOrderId;
      if (!id) return;

      const actor = resolveAuditActor(event as any);
      const userId = actor.userId || (event as any)?.state?.user?.id;

      await strapi.entityService.create("api::order-log.order-log" as any, {
        data: {
          order: id,
          performed_by: userId || null,
          Action: "Delete" as AuditAction,
          Description: "Order deleted",
        },
      });

      await recordAdminAudit(strapi as any, {
        event,
        resourceType: "Order",
        resourceId: id,
        action: "Delete",
        title: "سفارش حذف شد",
        message: `سفارش #${id} حذف شد`,
        messageEn: `Order #${id} deleted`,
        severity: "warning",
        metadata: { orderId: id },
      });

      if (actor.userId && actor.label) {
        await logAdminEvent(strapi as any, {
          category: "Action",
          resourceType: "Order",
          resourceId: id,
          action: "Delete",
          adminName: actor.label,
          adminId: actor.userId,
          audience: "admin",
          metadata: {
            orderId: id,
          },
        });
      }
    },
  });
}

function registerContractLifecycle(strapi: Strapi) {
  strapi.db.lifecycles.subscribe({
    models: ["api::contract.contract"],

    async afterCreate(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const { result } = event as any;
      if (!result?.id) return;
      const actor = resolveAuditActor(event as any);

      await strapi.entityService.create("api::contract-log.contract-log" as any, {
        data: {
          contract: result.id,
          performed_by: actor.userId,
          PerformedBy: actor.label || undefined,
          IP: actor.ip || undefined,
          UserAgent: actor.userAgent || undefined,
          Action: "Create" as AuditAction,
          Description: "Contract created",
        },
      });

      await recordAdminAudit(strapi as any, {
        event,
        resourceType: "Contract",
        resourceId: result.id,
        action: "Create",
        title: "قرارداد ایجاد شد",
        message: `قرارداد #${result.id} ایجاد شد`,
        messageEn: `Contract #${result.id} created`,
        severity: "info",
        metadata: {
          contractId: result.id,
          contractType: result.Type,
          contractStatus: result.Status,
          amount: result.Amount,
        },
      });
    },

    async beforeUpdate(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const where = (event as any)?.params?.where || {};
      const id = (where && (where.id || where.documentId)) || null;
      if (!id) return;

      const previous = await strapi.entityService.findOne(
        "api::contract.contract",
        id,
        {
          fields: ["Type", "Status", "Amount", "TaxPercent", "Date"],
          populate: { local_user: true, order: true },
        }
      );

      (event as any).state = { ...((event as any).state || {}), previousContract: previous };
    },

    async afterUpdate(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const { result, state } = event as any;
      if (!result?.id) return;
      const actor = resolveAuditActor(event as any);

      const previous = state?.previousContract || {};
      const current = await strapi.entityService.findOne(
        "api::contract.contract",
        result.id,
        {
          fields: ["Type", "Status", "Amount", "TaxPercent", "Date"],
          populate: { local_user: true, order: true },
        }
      );

      const changes = diffChanges(previous, current as any);
      if (Object.keys(changes).length === 0) return;

      await strapi.entityService.create("api::contract-log.contract-log" as any, {
        data: {
          contract: result.id,
          performed_by: actor.userId,
          PerformedBy: actor.label || undefined,
          IP: actor.ip || undefined,
          UserAgent: actor.userAgent || undefined,
          Action: "Update" as AuditAction,
          Changes: changes,
          Description: "Contract updated",
        },
      });

      await recordAdminAudit(strapi as any, {
        event,
        resourceType: "Contract",
        resourceId: result.id,
        action: "Update",
        title: "قرارداد بروزرسانی شد",
        message: `قرارداد #${result.id} بروزرسانی شد`,
        messageEn: `Contract #${result.id} updated`,
        severity: "info",
        changes,
        metadata: { contractId: result.id },
      });
    },

    async beforeDelete(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const where = (event as any)?.params?.where || {};
      const id = (where && (where.id || where.documentId)) || null;
      if (!id) return;

      const existing = await strapi.db.query("api::contract.contract").findOne({
        where: { id },
        populate: { order: true },
      });

      (event as any).state = {
        ...((event as any).state || {}),
        deletingContractId: id,
        deletingOrderId: asEntityId((existing as any)?.order),
      };
    },

    async afterDelete(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const id = (event as any)?.state?.deletingContractId;
      if (!id) return;
      const actor = resolveAuditActor(event as any);

      await strapi.entityService.create("api::contract-log.contract-log" as any, {
        data: {
          contract: id,
          performed_by: actor.userId,
          PerformedBy: actor.label || undefined,
          IP: actor.ip || undefined,
          UserAgent: actor.userAgent || undefined,
          Action: "Delete" as AuditAction,
          Description: "Contract deleted",
        },
      });

      await recordAdminAudit(strapi as any, {
        event,
        resourceType: "Contract",
        resourceId: id,
        action: "Delete",
        title: "قرارداد حذف شد",
        message: `قرارداد #${id} حذف شد`,
        messageEn: `Contract #${id} deleted`,
        severity: "warning",
        metadata: { contractId: id },
      });
    },
  });
}

function registerProductStockLifecycle(strapi: Strapi) {
  strapi.db.lifecycles.subscribe({
    models: ["api::product-stock.product-stock"],

    async afterCreate(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const { result } = event as any;

      const initialCount = result?.Count ?? 0;
      if (result?.id && initialCount > 0) {
        await strapi.entityService.create(
          "api::product-stock-log.product-stock-log" as any,
          {
            data: {
              product_stock: result.id,
              Count: initialCount,
              Type: "Add",
              Description: "Initial stock",
            },
          }
        );
      }

      scheduleHomeProductsRevalidation("product-stock-create", {
        stockId: result?.id,
        count: initialCount,
      });
    },

    async beforeUpdate(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const where = (event as any)?.params?.where || {};
      const id = (where && (where.id || where.documentId)) || null;
      if (!id) return;

      const existing = await strapi.entityService.findOne(
        "api::product-stock.product-stock",
        id,
        {
          fields: ["Count"],
          populate: { product_variation: true },
        }
      );

      (event as any).state = {
        ...((event as any).state || {}),
        previousCount: (existing as any)?.Count ?? 0,
        productVariationId: asEntityId((existing as any)?.product_variation),
      };
    },

    async afterUpdate(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const { result, state } = event as any;
      const previous = state?.previousCount;
      const current = result?.Count;

      if (typeof previous !== "number" || typeof current !== "number") return;
      if (!result?.id || previous === current) return;

      const delta = Math.abs(current - previous);
      const type = current > previous ? "Add" : "Minus";

      await strapi.entityService.create(
        "api::product-stock-log.product-stock-log" as any,
        {
          data: {
            product_stock: result.id,
            Count: delta,
            Type: type,
            Description: "Stock updated",
          },
        }
      );

      // Only a verified admin's manual stock change is audited; purchases (stock decrement on
      // payment) and reservation-expiry jobs have no admin actor and are skipped.
      await recordAdminAudit(strapi as any, {
        event,
        resourceType: "Stock",
        resourceId: result.id,
        action: "Adjust",
        title: "موجودی تغییر کرد",
        message: `موجودی ${result.id} از ${previous} به ${current} تغییر یافت`,
        messageEn: `Stock ${result.id} changed from ${previous} to ${current}`,
        severity: "info",
        changes: { Count: { from: previous, to: current } },
        metadata: { previous, current, delta, type },
      });

      scheduleHomeProductsRevalidation("product-stock-update", {
        stockId: result.id,
        previous,
        current,
        delta,
        type,
      });
    },

    async afterDelete(event) {
      if (isTrustedWordPressMigrationRequest()) return;
      const stockId = (event as any)?.result?.id ?? (event as any)?.params?.where?.id;
      scheduleHomeProductsRevalidation("product-stock-delete", { stockId });
    },
  });
}

const WORDPRESS_MIGRATION_TIMESTAMP_MODELS = [
  "api::product.product",
  "api::product-category.product-category",
  "api::product-variation.product-variation",
  "api::product-stock.product-stock",
  "api::product-size-helper.product-size-helper",
  "api::product-tag.product-tag",
  "api::product-variation-color.product-variation-color",
  "api::product-variation-size.product-variation-size",
  "api::product-variation-model.product-variation-model",
  "api::product-attribute.product-attribute",
  "api::product-attribute-term.product-attribute-term",
  "api::product-attribute-assignment.product-attribute-assignment",
  "plugin::users-permissions.user",
  "api::local-user-info.local-user-info",
  "api::local-user-wallet.local-user-wallet",
  "api::order.order",
  "api::order-item.order-item",
  "api::contract.contract",
  "api::blog-post.blog-post",
  "api::blog-category.blog-category",
  "api::blog-tag.blog-tag",
  "api::blog-author.blog-author",
  "plugin::upload.file",
];

function registerWordPressMigrationTimestampLifecycle(strapi: Strapi) {
  const applySourceTimestamps = (event: any) => {
    const timestamps = getTrustedWordPressMigrationSourceTimestamps();
    if (!timestamps) return;
    event.params ||= {};
    event.params.data ||= {};
    event.params.data.createdAt = timestamps.createdAt;
    event.params.data.updatedAt = timestamps.updatedAt;
  };

  strapi.db.lifecycles.subscribe({
    models: WORDPRESS_MIGRATION_TIMESTAMP_MODELS,
    beforeCreate: applySourceTimestamps,
    beforeCreateMany: (event: any) => {
      const timestamps = getTrustedWordPressMigrationSourceTimestamps();
      if (!timestamps || !Array.isArray(event?.params?.data)) return;
      for (const row of event.params.data) {
        row.createdAt = timestamps.createdAt;
        row.updatedAt = timestamps.updatedAt;
      }
    },
    beforeUpdate: applySourceTimestamps,
    beforeUpdateMany: (event: any) => {
      const timestamps = getTrustedWordPressMigrationSourceTimestamps();
      if (!timestamps || !Array.isArray(event?.params?.data)) return;
      for (const row of event.params.data) {
        row.createdAt = timestamps.createdAt;
        row.updatedAt = timestamps.updatedAt;
      }
    },
  });
}

export function registerAppLifecycles(strapi: Strapi) {
  registerOrderLifecycle(strapi);
  registerContractLifecycle(strapi);
  registerProductStockLifecycle(strapi);
  // Register last so these values override Strapi's default "now" timestamp
  // subscriber after the request has passed the migration trust gate.
  registerWordPressMigrationTimestampLifecycle(strapi);
}
