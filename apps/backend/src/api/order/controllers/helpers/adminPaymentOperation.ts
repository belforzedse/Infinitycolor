import type { Strapi } from "@strapi/strapi";
import { OPERATIONAL_ROLES, roleIsAllowed } from "../../../../utils/roles";

export async function adminPaymentOperationHandler(strapi: Strapi, ctx: any) {
  const orderId = Number(ctx.params.id);
  const operationId = Number(ctx.params.operationId);
  if (!Number.isFinite(orderId) || !Number.isFinite(operationId)) {
    return ctx.badRequest("Invalid payment operation");
  }

  const pluginUser = ctx.state.user;
  if (!pluginUser) return ctx.forbidden("Admin access required");
  const fullUser: any = await strapi.db
    .query("plugin::users-permissions.user")
    .findOne({ where: { id: pluginUser.id }, populate: ["role"] } as any);
  if (!fullUser || !roleIsAllowed(fullUser?.role?.name, OPERATIONAL_ROLES)) {
    return ctx.forbidden("Admin access required");
  }

  const operation: any = await strapi.db
    .query("api::payment-operation.payment-operation" as any)
    .findOne({
      where: {
        id: operationId,
        order: { id: orderId },
      },
    } as any);
  if (!operation) return ctx.notFound("Payment operation not found");

  return {
    data: {
      id: Number(operation.id),
      operationType: String(operation.OperationType),
      status: String(operation.Status),
      providerStatus: operation.providerStatus || null,
      httpStatus: Number.isInteger(operation.httpStatus) ? Number(operation.httpStatus) : null,
      providerCode: Number.isInteger(operation.providerCode)
        ? Number(operation.providerCode)
        : null,
      retryCount: Number(operation.retryCount || 0),
      nextRunAt: operation.nextRunAt || null,
      failureMessage: operation.failureMessage || null,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    },
  };
}
