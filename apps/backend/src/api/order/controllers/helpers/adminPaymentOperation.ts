import type { Strapi } from "@strapi/strapi";
import { hasCapability, type AdminCapability } from "@repo/auth-core";
import { requireCapability, resolveAdminActor } from "../../../../utils/adminAuthorization";

/**
 * Raw payment operations are financial records, so reading any of them needs
 * `order.financial.read`. The exception is the kind of operation an operator
 * can queue: the admin polls it to learn whether SnappPay accepted the cancel
 * or item update. Without this, Seller 2 and Store Manager cancels went
 * through at SnappPay while the admin showed them a 403 error, and their
 * retries then failed on the already-cancelled order.
 */
const OPERATION_TYPES_BY_CAPABILITY: ReadonlyArray<readonly [AdminCapability, string]> = [
  ["order.cancel", "CANCEL"],
  ["order.items.adjust", "UPDATE"],
];

/**
 * Operation types readable without `order.financial.read`. Empty when the
 * operator holds it (every type is readable) or holds none of the capabilities
 * above; either way `requireCapability` then decides.
 */
async function operatorReadableTypes(strapi: Strapi, ctx: any): Promise<string[]> {
  if (!ctx?.state?.user?.id) return [];
  const actor = await resolveAdminActor(strapi, ctx.state.user);
  if (!actor || hasCapability(actor.role, "order.financial.read")) return [];
  return OPERATION_TYPES_BY_CAPABILITY.filter(([capability]) =>
    hasCapability(actor.role, capability),
  ).map(([, type]) => type);
}

export async function adminPaymentOperationHandler(strapi: Strapi, ctx: any) {
  const orderId = Number(ctx.params.id);
  const operationId = Number(ctx.params.operationId);
  if (!Number.isFinite(orderId) || !Number.isFinite(operationId)) {
    return ctx.badRequest("Invalid payment operation");
  }

  const readableTypes = await operatorReadableTypes(strapi, ctx);
  if (
    readableTypes.length === 0 &&
    !(await requireCapability(ctx, strapi, "order.financial.read"))
  ) {
    return;
  }

  const operation: any = await strapi.db
    .query("api::payment-operation.payment-operation" as any)
    .findOne({
      where: {
        id: operationId,
        order: { id: orderId },
        ...(readableTypes.length > 0 ? { OperationType: { $in: readableTypes } } : {}),
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
