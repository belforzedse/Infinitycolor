import { AsyncLocalStorage } from "async_hooks";
import type { AuditContext as CanonicalAuditContext } from "../audit/types";
import { resolveUserFullName } from "./userDisplayName";

export interface AuditContext {
  userId: number | null;
  userLabel: string | null;
  username: string | null;
  email: string | null;
  isAdmin: boolean;
  ip: string | null;
  userAgent: string | null;
  /**
   * Canonical role name for `userId`, lazily resolved by `recordAdminAudit` and memoized
   * here so repeated audit writes within a single request avoid extra DB lookups.
   * `undefined` = not yet resolved, `null` = resolved with no role.
   */
  roleName?: string | null;
  /** Display name resolved alongside `roleName` (e.g. "First Last"), memoized. */
  resolvedName?: string | null;
  /** Stable IDs used to join direct and asynchronous work caused by this request. */
  requestId: string;
  interactionId: string | null;
  correlationId: string;
  route: string | null;
  method: string | null;
  canonical?: CanonicalAuditContext;
}

// Global storage for audit context
const auditContextStorage = new AsyncLocalStorage<AuditContext>();

export const getAuditContext = (): AuditContext | undefined => {
  return auditContextStorage.getStore();
};

export const runWithAuditContext = async <T>(
  context: AuditContext,
  callback: () => Promise<T>
): Promise<T> => {
  return auditContextStorage.run(context, callback);
};

export const setAuditContext = (context: AuditContext): AuditContext => {
  // For synchronous context setting (used in middleware)
  return context;
};

export const createAuditContext = (user: any, isAdmin = false): AuditContext => {
  const userId = normalizeUserId(user?.id ?? user);
  const userLabel =
    resolveUserFullName(user) ||
    user?.fullName ||
    user?.email ||
    user?.username ||
    user?.Phone ||
    ([user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || null) ||
    null;

  return {
    userId,
    userLabel,
    username: user?.username || null,
    email: user?.email || null,
    isAdmin,
    ip: null,
    userAgent: null,
    requestId: "",
    interactionId: null,
    correlationId: "",
    route: null,
    method: null,
  };
};

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
