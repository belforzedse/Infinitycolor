import type { Strapi } from "@strapi/strapi";
import { normalizeRoleName, resolveUserRoleName, ROLE_NAMES } from "./roles";

const OPERATIONAL_MANAGER_ROLES = new Set([ROLE_NAMES.STORE_MANAGER, ROLE_NAMES.FOUNDER]);

export async function isOperationalManagerRequest(ctx: any, strapi: Strapi): Promise<boolean> {
  const populatedRole = normalizeRoleName(
    ctx?.state?.user?.role?.name || ctx?.state?.user?.role?.type || null,
  );
  const role = populatedRole || (await resolveUserRoleName(strapi, ctx?.state?.user));
  return role ? OPERATIONAL_MANAGER_ROLES.has(role as any) : false;
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
    ctx.badRequest(`Store manager cannot write protected fields: ${rejected.join(", ")}`);
    return false;
  }

  return true;
}
