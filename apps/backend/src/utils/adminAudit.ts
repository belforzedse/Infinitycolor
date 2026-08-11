import type { Strapi } from "@strapi/strapi";

import { resolveAuditActor } from "./audit";
import { getAuditContext } from "./audit-context";
import { redactSensitive } from "./redactSensitive";
import { writeAuditEvent } from "../audit/writer";
import {
  MANAGEMENT_ROLES,
  normalizeRoleName,
  roleIsAllowed,
  fetchUserWithRole,
  type RoleName,
} from "./roles";

export type AuditSeverity = "info" | "success" | "warning" | "error";

/**
 * Actions recorded in the canonical admin audit log. Mirrors the `Action` enum of
 * `api::manual-admin-activity.manual-admin-activity`.
 */
export type AdminAuditAction =
  | "Create"
  | "Update"
  | "Delete"
  | "Publish"
  | "Unpublish"
  | "Adjust"
  | "Import"
  | "Refund"
  | "StatusChange"
  | "Other";

export type AdminAuditResourceType =
  | "Order"
  | "Product"
  | "User"
  | "Contract"
  | "Discount"
  | "Stock"
  | "Other";

/**
 * Explicit actor, used by HTTP handlers that already loaded the plugin user (+ role) so the
 * choke-point doesn't have to re-resolve it from the request context.
 */
export type AdminAuditActor = {
  id: number;
  name?: string | null;
  role?: string | null;
};

export type RecordAdminAuditParams = {
  resourceType: AdminAuditResourceType;
  resourceId?: string | number | null;
  action: AdminAuditAction;
  title?: string;
  message?: string;
  messageEn?: string;
  severity?: AuditSeverity;
  changes?: Record<string, { from?: unknown; to?: unknown }>;
  description?: string;
  metadata?: Record<string, unknown>;
  /** Lifecycle/programmatic event used to resolve the acting user. */
  event?: unknown;
  /** Explicit actor override (takes priority over `event`). */
  actor?: AdminAuditActor;
  ip?: string | null;
  userAgent?: string | null;
  /** Existing business transaction. Required for high-risk mutations. */
  trx?: unknown;
};

type VerifiedAdmin = {
  userId: number;
  name: string | null;
  role: RoleName;
  ip: string | null;
  userAgent: string | null;
};

function extractName(user: any): string | null {
  if (!user) return null;
  const info = user.user_info;
  const fullName =
    info?.FirstName || info?.LastName
      ? `${info?.FirstName || ""} ${info?.LastName || ""}`.trim()
      : null;
  return (
    fullName ||
    user.username ||
    user.email ||
    user.phone ||
    (user.id ? `User ${user.id}` : null)
  );
}

/**
 * Resolve the acting user and verify they are an admin (Superadmin / Store manager / Editor).
 * Returns `null` for anonymous traffic, background jobs, customers, and any non-management role —
 * which is what keeps the audit log free of false positives.
 *
 * Anonymous/job traffic (no userId) bails out before any DB query. For authenticated requests the
 * role lookup is memoized on the request's audit context, so multiple audit writes in the same
 * request hit the DB at most once.
 */
async function resolveVerifiedAdmin(
  strapi: Strapi,
  params: RecordAdminAuditParams,
): Promise<VerifiedAdmin | null> {
  // 1) Explicit actor (HTTP handlers that already know who acted).
  if (params.actor?.id) {
    const providedRole = normalizeRoleName(params.actor.role || null);
    if (providedRole && roleIsAllowed(providedRole, MANAGEMENT_ROLES)) {
      let name = params.actor.name ?? null;
      if (!name) {
        const user = await fetchUserWithRole(strapi, params.actor.id);
        name = extractName(user);
      }
      return {
        userId: params.actor.id,
        name,
        role: providedRole,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
      };
    }
    // Role not supplied (or not recognized): verify against the DB before trusting it.
    if (!params.actor.role) {
      const user = await fetchUserWithRole(strapi, params.actor.id);
      const role = normalizeRoleName((user as any)?.role?.name ?? null);
      if (role && roleIsAllowed(role, MANAGEMENT_ROLES)) {
        return {
          userId: params.actor.id,
          name: params.actor.name ?? extractName(user),
          role,
          ip: params.ip ?? null,
          userAgent: params.userAgent ?? null,
        };
      }
    }
    return null;
  }

  // 2) Resolve from the lifecycle/request context.
  const actor = resolveAuditActor(params.event as any);
  if (!actor.userId) return null;

  const ctx = getAuditContext();
  const memoHit =
    ctx && ctx.userId === actor.userId && ctx.roleName !== undefined;

  let role: RoleName | null;
  let name: string | null = actor.label ?? null;

  if (memoHit) {
    role = (ctx!.roleName as RoleName | null) ?? null;
    name = ctx!.resolvedName ?? name;
  } else {
    const user = await fetchUserWithRole(strapi, actor.userId);
    role = normalizeRoleName((user as any)?.role?.name ?? null);
    name = extractName(user) ?? name;
    if (ctx && ctx.userId === actor.userId) {
      ctx.roleName = role; // memoize for the rest of this request
      ctx.resolvedName = name;
    }
  }

  if (!role || !roleIsAllowed(role, MANAGEMENT_ROLES)) return null;

  return {
    userId: actor.userId,
    name,
    role,
    ip: params.ip ?? actor.ip ?? null,
    userAgent: params.userAgent ?? actor.userAgent ?? null,
  };
}

/**
 * The single, canonical writer for the admin audit log (`manual_admin_activities`).
 *
 * Compatibility adapter for existing direct-admin call sites. New code should use
 * `writeAuditEvent` and state initiator/executor/source explicitly. Persistence failures throw;
 * callers must await this function so sensitive mutations cannot silently lose accountability.
 *
 * @returns `true` if an entry was written (actor is a verified admin), otherwise `false`.
 */
export async function recordAdminAudit(
  strapi: Strapi,
  params: RecordAdminAuditParams,
): Promise<boolean> {
  const admin = await resolveVerifiedAdmin(strapi, params);
  if (!admin) return false;

  const resource = params.resourceType.toLowerCase();
  const category = ({
    order: "orders", product: "products", user: "customers", contract: "contracts",
    discount: "discounts", stock: "products", other: "administration",
  } as Record<string, string>)[resource] || "administration";
  const operation = ({
    Create: "create", Update: "update", Delete: "delete", Publish: "publish",
    Unpublish: "unpublish", Adjust: "adjust", Import: "import", Refund: "refund",
    StatusChange: "status_change", Other: "other",
  } as const)[params.action];
  let eventKey = `${category}.${operation}`;
  if (params.resourceType === "Order" && params.action === "Create") eventKey = "orders.created_by_admin";
  if (params.resourceType === "Order" && params.action === "StatusChange") eventKey = "orders.status_changed";
  if (params.resourceType === "Order" && params.action === "Refund") eventKey = "orders.refund_recorded";
  if (params.resourceType === "Product" && params.action === "StatusChange") eventKey = "products.status_changed";
  if (params.resourceType === "User" && params.action === "StatusChange") eventKey = "customers.status_changed";
  if (params.resourceType === "Stock" && params.action === "Adjust") eventKey = "products.inventory_changed";

  await writeAuditEvent(strapi, {
    eventKey,
    domain: resource,
    operation,
    importance:
      params.action === "Refund" || params.resourceType === "Contract" ? "critical" :
      params.severity === "warning" || params.severity === "error" ? "important" : undefined,
    result: params.severity === "error" ? "failure" : "success",
    initiator: {
      type: "human",
      id: admin.userId,
      label: admin.name || `User ${admin.userId}`,
      role: admin.role,
    },
    actor: {
      type: "human",
      id: admin.userId,
      label: admin.name || `User ${admin.userId}`,
      role: admin.role,
    },
    origin: "admin_ui",
    target: {
      type: resource,
      id: params.resourceId,
      label: params.resourceId == null ? null : String(params.resourceId),
    },
    changes: params.changes ? redactSensitive(params.changes) : null,
    metadata: params.metadata ? redactSensitive(params.metadata) : null,
    description: params.description,
    summaryFa: params.message || params.title,
    summaryEn: params.messageEn,
    ip: admin.ip,
    userAgent: admin.userAgent,
  }, { trx: params.trx });
  return true;
}

/**
 * Stamp a product's dedicated `last_edited_by_admin_at` column. Uses a raw query so it does NOT
 * re-trigger the product lifecycle and does NOT touch the generic `updated_at`. Call this only
 * after confirming the actor is a verified admin (e.g. when `recordAdminAudit` returned `true`).
 */
export async function markProductEditedByAdmin(
  strapi: Strapi,
  productRef: number | string | null | undefined,
): Promise<void> {
  const id = Number(productRef);
  if (!id || Number.isNaN(id)) return;
  try {
    await strapi.db.connection("products").where({ id }).update({
      last_edited_by_admin_at: new Date(),
    });
  } catch (error: any) {
    strapi.log.warn("[AdminAudit] Failed to stamp last_edited_by_admin_at", {
      productId: id,
      error: error?.message || error,
    });
  }
}
