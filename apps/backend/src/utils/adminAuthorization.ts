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
import { isTrustedWordPressMigrationRequest } from "./migration-context";
import { resolveUserFullName } from "./userDisplayName";

export type AdminActor = {
  user: any;
  role: AdminRoleId;
  capabilities: readonly AdminCapability[];
};

/**
 * Custom API tokens must list every action a capability maps to. Full-access
 * tokens and trusted WordPress migration requests skip this table.
 */
export const CAPABILITY_API_TOKEN_ACTIONS: Partial<Record<AdminCapability, readonly string[]>> = {
  "content.stories.manage": [
    "api::story.story.create",
    "api::story.story.update",
    "api::story.story.delete",
  ],
  "content.categoryEditorial.manage": [
    "api::product-category-content.product-category-content.targets",
    "api::product-category-content.product-category-content.editable",
    "api::product-category-content.product-category-content.upsert",
  ],
  "product.publish": ["api::product.product.publication"],
  "product.schedule": [
    "api::product.product.publication",
    "api::product.product.updateDisplayDate",
  ],
  "product.variation.manage": [
    "api::product.product.generateVariationCombinations",
    "api::product.product.replaceVariationColor",
  ],
};

type ApiTokenCredentials = {
  id?: number;
  name?: string;
  type?: string;
  permissions?: unknown;
};

export async function resolveAdminActor(
  strapi: Strapi,
  tokenUser: any,
): Promise<AdminActor | null> {
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

function strategyName(ctx: any): string {
  const strategy = ctx?.state?.auth?.strategy;
  if (typeof strategy === "string") return strategy;
  return String(strategy?.name || "");
}

export function apiTokenCredentials(ctx: any): ApiTokenCredentials | null {
  const credentials = ctx?.state?.auth?.credentials;
  if (!credentials || typeof credentials !== "object") return null;
  const type = String((credentials as ApiTokenCredentials).type || "").toLowerCase();
  const isApiTokenStrategy =
    strategyName(ctx) === "api-token" || strategyName(ctx).includes("api-token");
  if (!isApiTokenStrategy && type !== "full-access" && type !== "custom" && type !== "read-only") {
    return null;
  }
  return credentials as ApiTokenCredentials;
}

function tokenPermissionActions(token: ApiTokenCredentials): Set<string> {
  const raw = token.permissions;
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw.flatMap((entry) => {
      if (typeof entry === "string" && entry) return [entry];
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { action?: string }).action === "string"
      ) {
        return [(entry as { action: string }).action];
      }
      return [];
    }),
  );
}

export function apiTokenAllowsCapability(
  token: ApiTokenCredentials,
  capability: AdminCapability,
): boolean {
  const type = String(token.type || "").toLowerCase();
  if (type === "full-access") return true;
  if (type !== "custom") return false;
  const required = CAPABILITY_API_TOKEN_ACTIONS[capability];
  if (!required?.length) return false;
  const granted = tokenPermissionActions(token);
  return required.every((action) => granted.has(action));
}

function acceptServiceActor(
  ctx: any,
  capability: AdminCapability,
  label: string,
  tokenId = 0,
): AdminActor {
  const actor: AdminActor = {
    user: {
      id: tokenId,
      username: label,
      IsActive: true,
      blocked: false,
      role: { name: "Service", type: "service" },
    },
    role: "superadmin",
    capabilities: [capability],
  };
  ctx.state.adminActor = actor;
  return actor;
}

export async function requireCapability(
  ctx: any,
  strapi: Strapi,
  capability: AdminCapability,
): Promise<AdminActor | null> {
  if (isTrustedWordPressMigrationRequest()) {
    return acceptServiceActor(ctx, capability, "wordpress-migration");
  }

  const token = apiTokenCredentials(ctx);
  if (token) {
    if (apiTokenAllowsCapability(token, capability)) {
      return acceptServiceActor(
        ctx,
        capability,
        String(token.name || "api-token"),
        Number(token.id) || 0,
      );
    }
    deny(ctx, "forbidden", 403, "You do not have permission to perform this action");
    return null;
  }

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
