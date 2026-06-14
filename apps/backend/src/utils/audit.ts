import { getAuditContext } from "./audit-context";
import { getClientIp, getUserAgent } from "./getClientIp";

type EventContext = {
  state?: { user?: any };
};

type LifecycleEvent = {
  state?: { user?: any };
  params?: Record<string, unknown>;
};

export interface AuditActorInfo {
  userId: number | null;
  label: string | null;
  ip: string | null;
  userAgent: string | null;
}

const normalizeUserId = (value: unknown): number | null => {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const extractLabel = (user: any): string | null => {
  if (!user) return null;
  return (
    user.username ||
    user.email ||
    user.Phone ||
    user.fullName ||
    (user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : null) ||
    null
  );
};

/**
 * Resolve the audit actor from multiple sources with priority order:
 * 1. AsyncLocalStorage audit context (from middleware, most reliable for async operations)
 * 2. HTTP request context (fallback for direct HTTP handlers)
 * 3. Event state (for programmatic updates)
 * 4. Event data payload (explicit performed_by)
 * 5. Null (anonymous)
 */
export const resolveAuditActor = (event?: LifecycleEvent): AuditActorInfo => {
  // First check: AsyncLocalStorage audit context (highest priority for async)
  const auditContext = getAuditContext();
  if (auditContext?.userId) {
    return {
      userId: auditContext.userId,
      label: auditContext.userLabel,
      ip: auditContext.ip,
      userAgent: auditContext.userAgent,
    };
  }

  // Second check: HTTP request context (fallback for sync handlers)
  const requestCtx = (global as any)?.strapi?.requestContext?.get?.() as
    | (EventContext & { request?: any })
    | undefined;

  const user =
    requestCtx?.state?.user ||
    (event as any)?.state?.user ||
    (event as any)?.params?.data?.performed_by ||
    null;

  const userId = normalizeUserId(user?.id ?? user);
  const label = extractLabel(user) || (userId ? `User ${userId}` : null);
  // Use the centralized, proxy-aware helper so the real client IP is captured (not the
  // nginx→Strapi hop). `requestCtx` is the Koa context from `strapi.requestContext`.
  const ip = getClientIp(requestCtx as any);
  const userAgent = getUserAgent(requestCtx as any);

  return {
    userId,
    label,
    ip,
    userAgent: userAgent ? String(userAgent) : null,
  };
};
