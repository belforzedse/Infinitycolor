import { Strapi } from "@strapi/strapi";

export const ROLE_NAMES = {
  SUPERADMIN: "Superadmin",
  STORE_MANAGER: "Store manager",
  EDITOR: "Editor",
  FOUNDER: "Founder",
  CUSTOMER: "Customer",
} as const;

export type RoleName = (typeof ROLE_NAMES)[keyof typeof ROLE_NAMES];

const ROLE_ALIAS_MAP: Record<string, RoleName> = {
  superadmin: ROLE_NAMES.SUPERADMIN,
  superadministrator: ROLE_NAMES.SUPERADMIN,
  manager: ROLE_NAMES.STORE_MANAGER,
  storemanager: ROLE_NAMES.STORE_MANAGER,
  "store-manager": ROLE_NAMES.STORE_MANAGER,
  editor: ROLE_NAMES.EDITOR,
  founder: ROLE_NAMES.FOUNDER,
  founders: ROLE_NAMES.FOUNDER,
  customer: ROLE_NAMES.CUSTOMER,
};

export const MANAGEMENT_ROLES: RoleName[] = [
  ROLE_NAMES.SUPERADMIN,
  ROLE_NAMES.STORE_MANAGER,
  ROLE_NAMES.FOUNDER,
  ROLE_NAMES.EDITOR,
];

export const CONTENT_EDITOR_ROLES: RoleName[] = [ROLE_NAMES.SUPERADMIN, ROLE_NAMES.EDITOR];

export const CUSTOMER_CAPABLE_ROLES: RoleName[] = [
  ROLE_NAMES.CUSTOMER,
  ROLE_NAMES.STORE_MANAGER,
  ROLE_NAMES.FOUNDER,
  ROLE_NAMES.SUPERADMIN,
];

export const STORE_MANAGER_PLUS_ROLES: RoleName[] = [
  ROLE_NAMES.STORE_MANAGER,
  ROLE_NAMES.FOUNDER,
  ROLE_NAMES.SUPERADMIN,
];

/**
 * Roles that can access core operational/order functionality
 * (orders, products, carts, shipping, sales reports).
 * Used to keep role lists centralized instead of scattering string literals.
 */
export const OPERATIONAL_ROLES: RoleName[] = STORE_MANAGER_PLUS_ROLES;

export function normalizeRoleName(name?: string | null): RoleName | null {
  if (!name) {
    return null;
  }

  const compactKey = name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const aliasMatch = ROLE_ALIAS_MAP[compactKey];
  if (aliasMatch) {
    return aliasMatch;
  }

  // If the incoming role already matches our canonical names (case-insensitive), preserve casing
  const canonical = Object.values(ROLE_NAMES).find(
    (role) => role.toLowerCase().replace(/\s+/g, "") === compactKey,
  );

  return canonical ?? (name.trim() as RoleName);
}

export function roleIsAllowed(roleName: string | null | undefined, allowed: string[]): boolean {
  const normalizedRole = normalizeRoleName(roleName || null);
  if (!normalizedRole) {
    return false;
  }

  const normalizedAllowed = allowed
    .map((role) => normalizeRoleName(role) || role)
    .filter(Boolean) as RoleName[];

  if (normalizedAllowed.length === 0) {
    return false;
  }

  return normalizedAllowed.includes(normalizedRole);
}

/**
 * Fetches a user by ID and returns the user record with role-related relations populated.
 *
 * @param userId - The ID of the user to fetch; if not provided, the function returns `null`.
 * @returns The user record with `role`, `user_role`, and `user_info` populated, or `null` if `userId` was not provided or the user does not exist.
 */
export async function fetchUserWithRole(strapi: Strapi, userId?: number) {
  if (!userId) {
    return null;
  }

  return strapi.query("plugin::users-permissions.user").findOne({
    where: { id: userId },
    populate: ["role", "user_role", "user_info"],
  });
}

export async function resolveUserRoleName(strapi: Strapi, user?: any): Promise<RoleName | null> {
  const roleName =
    user?.role?.name || user?.role?.type || user?.user_role?.Name || user?.user_role?.name;

  const normalized = normalizeRoleName(roleName);
  if (normalized) {
    return normalized;
  }

  const fullUser = await fetchUserWithRole(strapi, user?.id);
  return normalizeRoleName(
    fullUser?.role?.name ||
      fullUser?.role?.type ||
      fullUser?.user_role?.Name ||
      fullUser?.user_role?.name ||
      null,
  );
}

function readTargetUserId(ctx: any): unknown {
  return (
    ctx?.query?.targetUserId ??
    ctx?.query?.userId ??
    ctx?.request?.body?.targetUserId ??
    ctx?.request?.body?.userId ??
    ctx?.request?.body?.data?.targetUserId ??
    ctx?.request?.body?.data?.userId
  );
}

function setContextError(
  ctx: any,
  method: "badRequest" | "forbidden" | "unauthorized",
  status: number,
  message: string,
  payload?: object,
) {
  const handler = ctx?.[method];
  if (typeof handler === "function") {
    try {
      if (payload === undefined) {
        handler.call(ctx, message);
      } else {
        handler.call(ctx, message, payload);
      }
      return;
    } catch (error: any) {
      if (!error?.status) {
        throw error;
      }
    }
  }

  ctx.status = status;
  ctx.body = payload ? { error: message, ...payload } : { error: message };
}

export async function resolveCustomerTargetUserId(
  ctx: any,
  strapi: Strapi,
): Promise<number | null> {
  const actorId = Number(ctx?.state?.user?.id);
  if (!Number.isInteger(actorId) || actorId <= 0) {
    setContextError(ctx, "unauthorized", 401, "Authentication required");
    return null;
  }

  const requested = readTargetUserId(ctx);
  if (requested === undefined || requested === null || requested === "") {
    return actorId;
  }

  const targetUserId = Number(requested);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    setContextError(ctx, "badRequest", 400, "Target user id must be a positive integer", {
      data: { success: false, error: "INVALID_TARGET_USER" },
    });
    return null;
  }

  if (targetUserId === actorId) {
    return targetUserId;
  }

  const roleName = await resolveUserRoleName(strapi, ctx.state.user);
  if (roleIsAllowed(roleName, [ROLE_NAMES.SUPERADMIN])) {
    return targetUserId;
  }

  setContextError(ctx, "forbidden", 403, "You do not have permission to target another user", {
    data: { success: false, error: "TARGET_USER_FORBIDDEN" },
  });
  return null;
}

/**
 * Retrieve a Strapi role by its canonical name.
 *
 * @param roleName - The canonical role name to look up
 * @returns The role record matching `roleName`, or `null` if no matching role is found
 */
export async function fetchRoleByName(strapi: Strapi, roleName: RoleName) {
  return strapi.query("plugin::users-permissions.role").findOne({ where: { name: roleName } });
}
