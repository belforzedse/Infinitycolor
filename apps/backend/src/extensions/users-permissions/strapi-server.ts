import {
  MANAGEMENT_ROLES,
  normalizeRoleName,
} from "../../utils/roles";
import bcrypt from "bcryptjs";
import { normalizeRequiredProfileName } from "../../api/auth/utils/profile-names";
import { validatePhone } from "../../api/auth/utils/validations";
import { recordAdminAudit } from "../../utils/adminAudit";
import { ADMIN_ROLE_DEFINITIONS } from "@repo/auth-core";
import { requireCapability } from "../../utils/adminAuthorization";

const PROFILE_COMPLETION_PATHS = new Set([
  "/api/auth/self",
  "/auth/self",
  "/api/auth/register-info",
  "/auth/register-info",
]);

function profileHasRequiredNames(profile: any): boolean {
  return (
    typeof profile?.FirstName === "string" &&
    profile.FirstName.trim().length > 0 &&
    typeof profile?.LastName === "string" &&
    profile.LastName.trim().length > 0
  );
}

function managementRole(roleName: unknown): boolean {
  const normalized = normalizeRoleName(typeof roleName === "string" ? roleName : null);
  return normalized
    ? MANAGEMENT_ROLES.includes(normalized as (typeof MANAGEMENT_ROLES)[number])
    : false;
}

const legacyProfileGuardStrategy = {
  name: "infinity-legacy-profile-guard",
  async authenticate(ctx: any) {
    try {
      const usersPermissions = strapi.plugin("users-permissions");
      const token = await usersPermissions.service("jwt").getToken(ctx);
      if (!token || token.id === undefined) return { authenticated: false };
      const user = await usersPermissions.service("user").fetchAuthenticatedUser(token.id);
      if (!user?.role?.id || user.blocked) return { authenticated: false };
      const settings = (await strapi
        .store({ type: "plugin", name: "users-permissions" })
        .get({ key: "advanced" })) as { email_confirmation?: boolean };
      if (settings.email_confirmation && !user.confirmed) {
        return { authenticated: false };
      }
      if (managementRole(user.role.name)) return { authenticated: false };

      const profile = await strapi.db.query("api::local-user-info.local-user-info").findOne({
        where: { user: user.id },
        select: ["FirstName", "LastName"],
      });
      if (!profileHasRequiredNames(profile) && !PROFILE_COMPLETION_PATHS.has(ctx.request.path)) {
        return { error: "Profile completion required" };
      }
      // The native strategy remains authoritative for legacy JWT abilities.
      return { authenticated: false };
    } catch {
      // A Better Auth token is not a valid legacy HMAC token; let the later
      // Better Auth strategy inspect it. Malformed tokens fail closed overall.
      return { authenticated: false };
    }
  },
};

function looksLikeBcryptHash(value?: string): value is string {
  return typeof value === "string" && /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

async function withHashedPassword<T extends Record<string, unknown>>(values: T): Promise<T> {
  const password = values?.password;
  if (typeof password !== "string" || !password || looksLikeBcryptHash(password)) {
    return values;
  }
  return { ...values, password: await bcrypt.hash(password, 10) };
}

function wrapUserServiceFactory(factory: (...args: any[]) => any) {
  return (...args: any[]) => {
    const service = factory(...args);
    const add = service.add.bind(service);
    const edit = service.edit.bind(service);
    service.add = async (values: Record<string, unknown>) => add(await withHashedPassword(values));
    service.edit = async (userId: string | number, values: Record<string, unknown> = {}) =>
      edit(userId, await withHashedPassword(values));
    return service;
  };
}

function requiredProfileNames(ctx: any) {
  const body = ctx.request?.body ?? {};
  const firstName = normalizeRequiredProfileName(body.firstName ?? body.FirstName);
  const lastName = normalizeRequiredProfileName(body.lastName ?? body.LastName);
  if (!firstName || !lastName) {
    ctx.status = 400;
    ctx.body = {
      message: firstName ? "نام خانوادگی الزامی است" : "نام الزامی است",
    };
    return null;
  }
  return { firstName, lastName };
}

function stripProfileFields(body: Record<string, unknown>) {
  const sanitized = { ...body };
  for (const field of [
    "firstName",
    "lastName",
    "FirstName",
    "LastName",
    "birthDate",
    "BirthDate",
  ]) {
    delete sanitized[field];
  }
  return sanitized;
}

function createdUserId(ctx: any): number | null {
  const raw = ctx.body?.user?.id ?? ctx.body?.id;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function removeIncompleteCreatedUser(userId: number): Promise<void> {
  try {
    await strapi.query("plugin::users-permissions.user").delete({ where: { id: userId } });
  } catch (error) {
    strapi.log.error("Failed to remove user after profile creation failure", {
      reasonCode: error instanceof Error ? error.name : "UNKNOWN",
    });
  }
}

const wrapCreatedUserController =
  (controllerFn: (ctx: any, next?: any) => Promise<unknown>) => async (ctx: any, next?: any) => {
    if (validatePhone(ctx, ctx.request?.body?.phone) !== 200) return;
    const names = requiredProfileNames(ctx);
    if (!names) return;
    const birthDateRaw = ctx.request.body?.birthDate ?? ctx.request.body?.BirthDate;
    const birthDate =
      typeof birthDateRaw === "string" && birthDateRaw.trim() ? birthDateRaw.trim() : null;

    ctx.request.body = stripProfileFields(ctx.request.body ?? {});
    const result = await controllerFn(ctx, next);
    const userId = createdUserId(ctx);
    if (!userId) return result;

    try {
      const existing = await strapi
        .query("api::local-user-info.local-user-info")
        .findOne({ where: { user: userId } });
      if (!existing) {
        await strapi.entityService.create("api::local-user-info.local-user-info", {
          data: {
            user: userId,
            FirstName: names.firstName,
            LastName: names.lastName,
            BirthDate: birthDate,
          },
        });
      }
    } catch (error) {
      await removeIncompleteCreatedUser(userId);
      throw error;
    }
    return result;
  };

function wantsPluginRoleChange(ctx: any) {
  const body = ctx.request?.body || {};
  return Object.prototype.hasOwnProperty.call(body, "role") && body.role !== undefined;
}

async function assertSuperadmin(ctx: any) {
  return Boolean(await requireCapability(ctx, strapi, "system.roles.manage"));
}

async function assertAssignablePluginRole(ctx: any) {
  const rawRoleId = ctx.request?.body?.role;
  const roleId = Number(typeof rawRoleId === "object" ? rawRoleId?.id : rawRoleId);
  if (!Number.isSafeInteger(roleId) || roleId <= 0) {
    ctx.badRequest("A valid role id is required");
    return false;
  }
  const role = await strapi.query("plugin::users-permissions.role").findOne({
    where: { id: roleId },
    select: ["id", "name", "type"],
  });
  const allowedTypes = new Set([
    "customer",
    ...Object.values(ADMIN_ROLE_DEFINITIONS).map((definition) => definition.strapiType),
  ]);
  if (!role || !allowedTypes.has(role.type)) {
    ctx.badRequest("The selected role is not assignable");
    return false;
  }
  return true;
}

const wrapUserController =
  (controllerFn: (ctx: any, next?: any) => Promise<unknown>) => async (ctx: any, next?: any) => {
    if (wantsPluginRoleChange(ctx)) {
      const actorId = Number(ctx.state?.user?.id);
      const targetId = Number(ctx.params?.id);
      if (Number.isSafeInteger(actorId) && actorId > 0 && actorId === targetId) {
        await recordAdminAudit(strapi, {
          resourceType: "User",
          resourceId: targetId,
          action: "Update",
          title: "Rejected self-role change",
          messageEn: "An administrator attempted to change their own role.",
          severity: "warning",
          actor: { id: actorId },
          metadata: { rejectedFields: ["role"] },
        });
        ctx.forbidden("Administrators cannot change their own role");
        return;
      }
      const allowed = await assertSuperadmin(ctx);
      if (!allowed) {
        await recordAdminAudit(strapi, {
          resourceType: "User",
          resourceId: Number.isSafeInteger(targetId) ? targetId : null,
          action: "Update",
          title: "Rejected user role assignment",
          messageEn: "An actor without role-management capability attempted to assign a role.",
          severity: "warning",
          actor: Number.isSafeInteger(actorId) ? { id: actorId } : undefined,
          metadata: { requestedRole: ctx.request?.body?.role ?? null },
        });
        return;
      }
      if (!(await assertAssignablePluginRole(ctx))) {
        await recordAdminAudit(strapi, {
          resourceType: "User",
          resourceId: Number.isSafeInteger(targetId) ? targetId : null,
          action: "Update",
          title: "Rejected user role assignment",
          messageEn: "A Superadmin attempted to assign an unknown or non-assignable role.",
          severity: "warning",
          actor: { id: actorId },
          metadata: { requestedRole: ctx.request?.body?.role ?? null },
        });
        return;
      }
    }

    const result = await controllerFn(ctx, next);
    if (
      wantsPluginRoleChange(ctx) &&
      Number(ctx.params?.id) > 0 &&
      (!ctx.status || ctx.status < 400)
    ) {
      await recordAdminAudit(strapi, {
        resourceType: "User",
        resourceId: Number(ctx.params.id),
        action: "Update",
        title: "User role updated",
        messageEn: "A Superadmin changed another user's role.",
        severity: "success",
        actor: { id: Number(ctx.state?.user?.id) },
        metadata: { fields: ["role"] },
      });
    }
    return result;
  };

export default (plugin: any) => {
  const registerPlugin = plugin.register;
  plugin.register = async (args: any) => {
    // User extensions are applied before plugin register hooks. Prepending this
    // veto-only guard closes incomplete-profile access for legacy JWTs, then the
    // plugin registers its unchanged native strategy and the app later appends BA.
    args.strapi.container.get("auth").register("content-api", legacyProfileGuardStrategy);
    return registerPlugin.call(plugin, args);
  };
  plugin.services.user = wrapUserServiceFactory(plugin.services.user);
  plugin.controllers.user.update = wrapUserController(plugin.controllers.user.update);
  plugin.controllers.user.create = wrapCreatedUserController(
    wrapUserController(plugin.controllers.user.create),
  );
  plugin.controllers.auth.register = wrapCreatedUserController(plugin.controllers.auth.register);

  return plugin;
};

export const __usersPermissionsExtensionTestUtils = {
  looksLikeBcryptHash,
  legacyProfileGuardStrategy,
  profileHasRequiredNames,
};
