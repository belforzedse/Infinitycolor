import { MANAGEMENT_ROLES, normalizeRoleName } from "../../utils/roles";
import bcrypt from "bcryptjs";
import { normalizeRequiredProfileName } from "../../api/auth/utils/profile-names";
import { validatePhone } from "../../api/auth/utils/validations";
import { writeAuditEvent } from "../../audit/writer";
import { getAuditContext } from "../../utils/audit-context";
import { randomUUID } from "node:crypto";
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

async function resolveAssignablePluginRole(ctx: any) {
  const rawRoleId = ctx.request?.body?.role;
  const roleId = Number(typeof rawRoleId === "object" ? rawRoleId?.id : rawRoleId);
  if (!Number.isSafeInteger(roleId) || roleId <= 0) {
    ctx.badRequest("A valid role id is required");
    return null;
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
    return null;
  }
  return role;
}

async function preservesActiveSuperadmin(ctx: any, targetId: number, nextRole: any) {
  if (nextRole?.type === ADMIN_ROLE_DEFINITIONS.superadmin.strapiType) return true;

  const userQuery = strapi.query("plugin::users-permissions.user");
  const target = await userQuery.findOne({
    where: { id: targetId },
    select: ["id", "blocked", "IsActive"],
    populate: { role: { select: ["id", "name", "type"] } },
  });
  const targetIsActiveSuperadmin =
    target?.role?.type === ADMIN_ROLE_DEFINITIONS.superadmin.strapiType &&
    target.blocked !== true &&
    target.IsActive !== false;
  if (!targetIsActiveSuperadmin) return true;

  const activeAlternatives = await userQuery.count({
    where: {
      id: { $ne: targetId },
      role: target.role.id,
      blocked: { $ne: true },
      IsActive: { $ne: false },
    },
  });
  if (activeAlternatives > 0) return true;

  ctx.forbidden("At least one active Superadmin must remain");
  return false;
}

async function auditRoleDenial(
  ctx: any,
  input: { targetId: number | null; requestedRole: unknown; reasonCode: string },
) {
  const actorId = Number(ctx.state?.user?.id);
  if (!Number.isSafeInteger(actorId) || actorId <= 0) return;
  const request = getAuditContext();
  try {
    await writeAuditEvent(strapi, {
      eventKey: "security.access_denied",
      result: "denied",
      importance: "critical",
      initiator: {
        type: "human",
        id: actorId,
        label: ctx.state?.user?.username || ctx.state?.user?.email,
        role: ctx.state?.adminActor?.role,
        roleId: ctx.state?.user?.role?.id,
      },
      actor: {
        type: "service_account",
        id: "role-management-policy",
        label: "سیاست مدیریت نقش‌ها",
      },
      origin: "admin_ui",
      target: {
        type: "administrator",
        id: input.targetId,
        label: input.targetId ? `User ${input.targetId}` : "کاربر جدید",
      },
      reasonCode: input.reasonCode,
      requestId: request?.requestId,
      correlationId: request?.correlationId,
      route: ctx.request?.path || ctx.path,
      httpMethod: ctx.request?.method || ctx.method,
      ip: request?.ip || ctx.request?.ip || ctx.ip,
      userAgent: request?.userAgent || ctx.request?.headers?.["user-agent"],
      metadata: {
        requestedRoleId:
          typeof input.requestedRole === "object"
            ? (input.requestedRole as any)?.id ?? null
            : input.requestedRole ?? null,
      },
      dedupeKey: `role-denied:${request?.requestId || randomUUID()}:${input.reasonCode}`,
    });
  } catch (error) {
    strapi.log.error("Required role-denial audit write failed", {
      reasonCode: input.reasonCode,
      error: error instanceof Error ? error.name : "UNKNOWN",
    });
  }
}

const wrapUserController =
  (controllerFn: (ctx: any, next?: any) => Promise<unknown>) => async (ctx: any, next?: any) => {
    if (wantsPluginRoleChange(ctx)) {
      const actorId = Number(ctx.state?.user?.id);
      const targetId = Number(ctx.params?.id);
      const allowed = await assertSuperadmin(ctx);
      if (!allowed) {
        await auditRoleDenial(ctx, {
          targetId: Number.isSafeInteger(targetId) ? targetId : null,
          requestedRole: ctx.request?.body?.role,
          reasonCode: "ROLE_MANAGEMENT_CAPABILITY_REQUIRED",
        });
        return;
      }
      const nextRole = await resolveAssignablePluginRole(ctx);
      if (!nextRole) {
        await auditRoleDenial(ctx, {
          targetId: Number.isSafeInteger(targetId) ? targetId : null,
          requestedRole: ctx.request?.body?.role,
          reasonCode: "ROLE_NOT_ASSIGNABLE",
        });
        return;
      }
      if (
        !Number.isSafeInteger(targetId) ||
        targetId <= 0 ||
        !(await preservesActiveSuperadmin(ctx, targetId, nextRole))
      ) {
        await auditRoleDenial(ctx, {
          targetId: Number.isSafeInteger(targetId) ? targetId : null,
          requestedRole: nextRole.id,
          reasonCode: "LAST_ACTIVE_SUPERADMIN",
        });
        return;
      }
    }

    const targetId = Number(ctx.params?.id);
    const shouldAuditRoleChange = wantsPluginRoleChange(ctx) && targetId > 0;
    return strapi.db.transaction(async ({ trx }) => {
      const userQuery = strapi.query("plugin::users-permissions.user");
      const before = shouldAuditRoleChange
        ? await userQuery.findOne({
            where: { id: targetId },
            select: ["id", "username", "email"],
            populate: { role: { select: ["id", "name", "type"] } },
            transacting: trx,
          } as any)
        : null;
      const result = await controllerFn(ctx, next);
      if (shouldAuditRoleChange && (!ctx.status || ctx.status < 400)) {
        const after = await userQuery.findOne({
          where: { id: targetId },
          select: ["id", "username", "email"],
          populate: { role: { select: ["id", "name", "type"] } },
          transacting: trx,
        } as any);
        const request = getAuditContext();
        const actor = ctx.state?.adminActor;
        await writeAuditEvent(strapi, {
          eventKey: "administrators.role_changed",
          result: "success",
          initiator: {
            type: "human",
            id: Number(ctx.state?.user?.id),
            label: actor?.user?.username || actor?.user?.email,
            role: actor?.role,
            roleId: actor?.user?.role?.id,
          },
          actor: {
            type: "human",
            id: Number(ctx.state?.user?.id),
            label: actor?.user?.username || actor?.user?.email,
            role: actor?.role,
            roleId: actor?.user?.role?.id,
          },
          origin: "admin_ui",
          target: {
            type: "administrator",
            id: targetId,
            label: after?.username || after?.email || `User ${targetId}`,
          },
          changes: [{
            field: "role",
            label: "نقش و سطح دسترسی",
            from: before?.role
              ? { id: before.role.id, name: before.role.name, type: before.role.type }
              : null,
            to: after?.role
              ? { id: after.role.id, name: after.role.name, type: after.role.type }
              : null,
          }],
          requestId: request?.requestId,
          correlationId: request?.correlationId,
          ip: request?.ip || ctx.request?.ip || ctx.ip,
          userAgent: request?.userAgent || ctx.request?.headers?.["user-agent"],
          dedupeKey: `role-change:${request?.requestId || randomUUID()}:${targetId}`,
        }, { trx });
      }
      return result;
    });
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
