/**
 * admin-activity controller
 */

import { factories } from "@strapi/strapi";
import { requireCapability } from "../../../utils/adminAuthorization";

export default factories.createCoreController(
  "api::admin-activity.admin-activity" as any,
  ({ strapi }) => ({
    async findMyActivities(ctx) {
      const actor = await requireCapability(ctx, strapi, "system.audit.read");
      if (!actor) return;
      const user = actor.user;

      const page = Number(ctx.query.page ?? 1);
      const pageSize = Number(ctx.query.pageSize ?? 20);

      const activities = await strapi.entityService.findMany(
        "api::manual-admin-activity.manual-admin-activity" as any,
        {
          filters: { performed_by: { id: user.id } },
          sort: { createdAt: "desc" },
          populate: ["performed_by"],
          pagination: { page, pageSize },
        },
      );

      return ctx.send(activities);
    },

    async findOrderActivities(ctx) {
      if (!(await requireCapability(ctx, strapi, "order.audit.read"))) return;

      const { orderId } = ctx.params;
      const page = Number(ctx.query.page ?? 1);
      const pageSize = Number(ctx.query.pageSize ?? 20);

      const filters = {
        ResourceType: "Order",
        ResourceId: String(orderId),
      } as const;

      // Read the canonical admin audit log (`manual-admin-activity`), which is what
      // `recordAdminAudit` writes to. (The legacy `admin-activity` table is retired.)
      const [activities, total] = await Promise.all([
        strapi.entityService.findMany("api::manual-admin-activity.manual-admin-activity" as any, {
          filters,
          sort: { createdAt: "desc" },
          populate: ["performed_by"],
          pagination: { page, pageSize },
        }),
        strapi.entityService.count("api::manual-admin-activity.manual-admin-activity" as any, {
          filters,
        }),
      ]);

      return ctx.send({
        data: activities,
        meta: {
          pagination: {
            page,
            pageSize,
            pageCount: Math.ceil(total / pageSize),
            total,
          },
        },
      });
    },

    async findUserActivities(ctx) {
      if (!(await requireCapability(ctx, strapi, "system.audit.read"))) return;

      const { userId } = ctx.params;
      const page = Number(ctx.query.page ?? 1);
      const pageSize = Number(ctx.query.pageSize ?? 20);

      const activities = await strapi.entityService.findMany(
        "api::manual-admin-activity.manual-admin-activity" as any,
        {
          filters: {
            ResourceType: "User",
            ResourceId: String(userId),
          },
          sort: { createdAt: "desc" },
          populate: ["performed_by"],
          pagination: { page, pageSize },
        },
      );

      return ctx.send(activities);
    },

    async findProductActivities(ctx) {
      if (!(await requireCapability(ctx, strapi, "system.audit.read"))) return;

      const { productId } = ctx.params;
      const page = Number(ctx.query.page ?? 1);
      const pageSize = Number(ctx.query.pageSize ?? 20);

      const activities = await strapi.entityService.findMany(
        "api::manual-admin-activity.manual-admin-activity" as any,
        {
          filters: {
            ResourceType: "Product",
            ResourceId: String(productId),
          },
          sort: { createdAt: "desc" },
          populate: ["performed_by"],
          pagination: { page, pageSize },
        },
      );

      return ctx.send(activities);
    },

    async findReport(ctx) {
      if (!(await requireCapability(ctx, strapi, "system.audit.read"))) return;

      const page = Number(ctx.query.page ?? 1);
      const pageSize = Number(ctx.query.pageSize ?? 50);
      const startDate = ctx.query.startDate as string | undefined;
      const endDate = ctx.query.endDate as string | undefined;
      const performedBy = ctx.query.performedBy as string | undefined;
      const resourceType = ctx.query.resourceType as string | undefined;

      const filters: any = {};
      if (startDate || endDate) {
        filters.createdAt = {} as any;
        if (startDate) {
          (filters.createdAt as any).$gte = new Date(startDate);
        }
        if (endDate) {
          (filters.createdAt as any).$lte = new Date(endDate);
        }
      }
      if (performedBy) {
        filters.performed_by = { id: Number(performedBy) };
      }
      if (resourceType) {
        filters.ResourceType = resourceType;
      }

      const activities = await strapi.entityService.findMany(
        "api::manual-admin-activity.manual-admin-activity" as any,
        {
          filters,
          sort: { createdAt: "desc" },
          populate: ["performed_by"],
          pagination: { page, pageSize },
        },
      );

      return ctx.send(activities);
    },
  }),
);
