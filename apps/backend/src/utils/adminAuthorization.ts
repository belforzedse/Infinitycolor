import type { Strapi } from "@strapi/strapi";
import { randomUUID } from "node:crypto";
import {
  capabilitiesForRole,
  hasCapability,
  normalizeAdminRole,
  type AdminCapability,
  type AdminRoleId,
} from "@repo/auth-core";
import { writeAuditEvent } from "../audit/writer";
import { getAuditContext } from "./audit-context";
import { resolveUserFullName } from "./userDisplayName";

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
    const request = getAuditContext();
    try {
      await writeAuditEvent(strapi, {
        eventKey: "security.access_denied",
        result: "denied",
        importance: "sensitive",
        initiator: {
          type: "human",
          id: Number(ctx.state.user.id),
          label:
            resolveUserFullName(actor?.user) ||
            actor?.user?.email ||
            actor?.user?.username ||
            ctx.state.user?.username,
          role: actor?.role,
          roleId: actor?.user?.role?.id,
        },
        actor: {
          type: "service_account",
          id: "authorization-service",
          label: "سرویس کنترل دسترسی",
        },
        origin: "admin_ui",
        target: { type: "capability", id: capability, label: capability },
        reasonCode: actor ? "CAPABILITY_NOT_GRANTED" : "ADMIN_ACCOUNT_NOT_ACTIVE",
        requestId: request?.requestId,
        correlationId: request?.correlationId,
        route: ctx.request?.path || ctx.path,
        httpMethod: ctx.request?.method || ctx.method,
        ip: request?.ip || ctx.request?.ip || ctx.ip,
        userAgent: request?.userAgent || ctx.request?.headers?.["user-agent"],
        metadata: { requiredCapability: capability },
        dedupeKey: `access-denied:${request?.requestId || randomUUID()}:${capability}`,
      });
    } catch (error) {
      // Authorization must still deny when the audit database is unavailable.
      // Production Strapi always has a logger; optional chaining also keeps this
      // failure policy testable with deliberately minimal controller doubles.
      strapi.log?.error?.("Required access-denial audit write failed", {
        capability,
        reasonCode: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
    deny(ctx, "forbidden", 403, "You do not have permission to perform this action");
    return null;
  }
  ctx.state.user = actor.user;
  ctx.state.adminActor = actor;
  return actor;
}
