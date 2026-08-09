import type { Strapi } from "@strapi/strapi";
import { hasCapability, normalizeAdminRole } from "@repo/auth-core";
import { resolveAdminActor } from "./adminAuthorization";

export async function isOperationalManagerRequest(ctx: any, strapi: Strapi): Promise<boolean> {
  const populatedRole = normalizeAdminRole(
    ctx?.state?.user?.role?.type || ctx?.state?.user?.role?.name || null,
  );
  const role = populatedRole || (await resolveAdminActor(strapi, ctx?.state?.user))?.role || null;
  return Boolean(
    role &&
      role !== "superadmin" &&
      (hasCapability(role, "product.update") || hasCapability(role, "order.read")),
  );
}

export async function enforceOperationalDataFields(
  ctx: any,
  strapi: Strapi,
  allowedFields: ReadonlyArray<string>,
): Promise<boolean> {
  if (!(await isOperationalManagerRequest(ctx, strapi))) {
    return true;
  }

  const data = ctx?.request?.body?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    ctx.badRequest("Request body must contain a data object");
    return false;
  }

  const allowed = new Set(allowedFields);
  const rejected = Object.keys(data).filter((field) => !allowed.has(field));
  if (rejected.length > 0) {
    ctx.badRequest(`This role cannot write protected fields: ${rejected.join(", ")}`);
    return false;
  }

  return true;
}
