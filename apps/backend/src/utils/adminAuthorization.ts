import type { Strapi } from "@strapi/strapi";
import {
  capabilitiesForRole,
  hasCapability,
  normalizeAdminRole,
  type AdminCapability,
  type AdminRoleId,
} from "@repo/auth-core";

export type AdminActor = {
  user: any;
  role: AdminRoleId;
  capabilities: readonly AdminCapability[];
};

export async function resolveAdminActor(strapi: Strapi, tokenUser: any): Promise<AdminActor | null> {
  const userId = Number(tokenUser?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;

  const user = await strapi.query("plugin::users-permissions.user").findOne({
    where: { id: userId },
    populate: ["role", "user_info"],
  });
  if (!user || user.blocked || user.IsActive === false) return null;

  const role = normalizeAdminRole(user.role?.type) ?? normalizeAdminRole(user.role?.name);
  if (!role) return null;
  return { user, role, capabilities: capabilitiesForRole(role) };
}

function deny(ctx: any, method: "unauthorized" | "forbidden", status: number, message: string) {
  if (typeof ctx?.[method] === "function") {
    return ctx[method](message);
  }
  ctx.status = status;
  ctx.body = { error: message };
  return false;
}

export async function requireCapability(
  ctx: any,
  strapi: Strapi,
  capability: AdminCapability,
): Promise<AdminActor | null> {
  if (!ctx?.state?.user?.id) {
    deny(ctx, "unauthorized", 401, "Authentication required");
    return null;
  }
  const actor = await resolveAdminActor(strapi, ctx.state.user);
  if (!actor || !hasCapability(actor.role, capability)) {
    deny(ctx, "forbidden", 403, "You do not have permission to perform this action");
    return null;
  }
  ctx.state.user = actor.user;
  ctx.state.adminActor = actor;
  return actor;
}
