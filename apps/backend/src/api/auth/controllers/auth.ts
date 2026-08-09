/**
 * A set of functions called "actions" for `auth`
 * All user-facing error messages are in Persian.
 */

const OTP_INVALID_MESSAGE = "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.";
const LOGIN_FAILED_MESSAGE = "ورود ناموفق بود. دوباره تلاش کنید.";
const OTP_SEND_FAILED_MESSAGE = "ارسال کد تایید ناموفق بود. دوباره تلاش کنید.";
const UNAUTHORIZED_MESSAGE = "احراز هویت ناموفق بود. دوباره تلاش کنید.";
const PHONE_PASSWORD_REQUIRED_MESSAGE = "شماره همراه و رمز عبور الزامی است.";
const USER_NOT_FOUND_OR_PASSWORD_INCORRECT = "شماره همراه یا رمز عبور اشتباه است.";
const PASSWORD_RESET_FAILED_MESSAGE = "تغییر رمز عبور ناموفق بود. دوباره تلاش کنید.";

import { validatePhone } from "../utils/validations";
import { normalizeRequiredProfileName } from "../utils/profile-names";
import {
  CredentialFlowError,
  issueLegacyJwt,
  resetPasswordWithOtp,
  verifyOtpIdentity,
  verifyPasswordIdentity,
} from "../services/credential-flow";
import { recordAdminAudit } from "../../../utils/adminAudit";
import {
  capabilitiesForRole,
  normalizeAdminRole,
} from "@repo/auth-core";

export default {
  otp,
  login,
  self,
  updateSelf,
  welcome,
  registerInfo,
  loginWithPassword,
  resetPassword,
};

async function welcome(ctx) {
  const { phone } = ctx.request.body;

  const validation = validatePhone(ctx, phone);

  if (validation !== 200) {
    return validation;
  }

  const hasUser = await strapi.service("api::auth.auth").hasUser(ctx, { phone });

  ctx.body = {
    message: "welcome",
    hasUser,
  };
}

async function otp(ctx) {
  try {
    const { phone } = ctx.request.body;

    const validation = validatePhone(ctx, phone);

    if (validation !== 200) {
      return validation;
    }

    const otpToken = await strapi.service("api::auth.auth").otp(ctx, { phone });

    ctx.body = {
      message: "otp sent",
      otpToken,
    };
  } catch (err) {
    strapi.log.error("Failed to send OTP", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    ctx.status = 500;
    ctx.body = {
      message: OTP_SEND_FAILED_MESSAGE,
      error: "OTP_SEND_FAILED",
    };
  }
}

async function login(ctx) {
  try {
    const { otp, otpToken } = ctx.request.body;

    if (String(otp || "").length !== 6 || !otpToken?.includes(".")) {
      ctx.badRequest(OTP_INVALID_MESSAGE);
      return;
    }

    const upUser = await verifyOtpIdentity(otpToken, String(otp));
    const token = await issueLegacyJwt(Number(upUser.id));

    ctx.body = { message: "login successful", token };
  } catch (err) {
    if (err instanceof CredentialFlowError && err.status === 400) {
      ctx.badRequest(err.message);
      return;
    }
    strapi.log.error("Login failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    ctx.status = 500;
    ctx.body = {
      message: LOGIN_FAILED_MESSAGE,
      error: "LOGIN_FAILED",
    };
  }
}

/**
 * Responds with the authenticated plugin user's merged profile and role information.
 *
 * Loads the plugin user (including role) and any linked local-user-info profile, computes an `isAdmin`
 * flag from the user's role name (case-insensitive, treating "superadmin", "store manager", and "editor" as admin),
 * and sets `ctx.body` to a merged object containing existing `ctx.state.user`, profile fields, and these explicit fields:
 * `Phone`, `phone`, `UserName`, `Email`, `isAdmin`, and `roleName`.
 *
 * If no authenticated plugin user can be resolved or the user record is missing, the function responds with 401 Unauthorized.
 * On unexpected errors the function responds with status 500 and a body of the form `{ message: string }`.
 *
 * @param ctx - Koa request/response context used to resolve the current user and to set the HTTP response
 */
async function self(ctx) {
  try {
    let pluginUserId = await resolvePluginUserId(ctx);
    if (!pluginUserId) {
      return ctx.unauthorized(UNAUTHORIZED_MESSAGE);
    }

    const fullUser = await strapi.entityService.findOne(
      "plugin::users-permissions.user",
      Number(pluginUserId),
      {
        populate: { role: { populate: ["permissions"] } },
      },
    );

    if (!fullUser) {
      return ctx.unauthorized(UNAUTHORIZED_MESSAGE);
    }

    // Resolve the live plugin role. Better Auth proves identity; Strapi remains
    // the authorization authority and capabilities are never embedded in JWTs.
    const roleName = fullUser?.role?.name;
    const adminRole = normalizeAdminRole(fullUser?.role?.type) ?? normalizeAdminRole(roleName);
    const capabilities = adminRole ? [...capabilitiesForRole(adminRole)] : [];
    const isAdmin = adminRole !== null;

    // Load profile from local-user-info which now points to plugin user
    const localUserInfo = await strapi.db
      .query("api::local-user-info.local-user-info")
      .findOne({ where: { user: pluginUserId } });
    const profile = localUserInfo ? { ...localUserInfo } : {};
    if (profile && (profile as any).id) delete (profile as any).id;

    const phone =
      typeof fullUser?.phone === "string" && fullUser.phone.trim().length > 0
        ? fullUser.phone.trim()
        : undefined;
    const effectivePermissions = Array.from(
      new Set(
        (Array.isArray(fullUser?.role?.permissions) ? fullUser.role.permissions : [])
          .map((permission: any) => permission?.action)
          .filter((action: unknown): action is string => typeof action === "string" && action.length > 0),
      ),
    ).sort();
    const lifecycle = fullUser as any;

    ctx.body = {
      ...ctx.state.user,
      ...profile,
      Phone: phone || profile?.Phone || null,
      phone: phone || profile?.phone || null,
      UserName: fullUser?.username ?? profile?.UserName,
      Email: fullUser?.email ?? profile?.Email,
      confirmed: Boolean(fullUser?.confirmed),
      isAdmin,
      roleName: roleName ?? null,
      adminRole,
      capabilities,
      effectivePermissions,
      AccountOrigin: lifecycle?.AccountOrigin ?? "Native",
      ClaimedAt: lifecycle?.ClaimedAt ?? null,
      ProfileCompletedAt: lifecycle?.ProfileCompletedAt ?? null,
      ProfileManagedByCustomer: Boolean(lifecycle?.ProfileManagedByCustomer),
      needsProfileCompletion: !lifecycle?.ProfileCompletedAt,
    };
  } catch (err) {
    strapi.log.error(err);
    ctx.status = 500;
    ctx.body = {
      message: err.message,
    };
  }
}

async function updateSelf(ctx) {
  try {
    const pluginUserId = await resolvePluginUserId(ctx);
    if (!pluginUserId) {
      return ctx.unauthorized(UNAUTHORIZED_MESSAGE);
    }

    const body = ctx.request.body ?? {};
    const allowedFields = new Set([
      "FirstName",
      "LastName",
      "NationalCode",
      "BirthDate",
      "Sex",
      "Bio",
    ]);
    const rejectedFields =
      body && typeof body === "object" && !Array.isArray(body)
        ? Object.keys(body).filter((field) => !allowedFields.has(field))
        : ["requestBody"];
    if (rejectedFields.length > 0) {
      await recordAdminAudit(strapi, {
        resourceType: "User",
        resourceId: pluginUserId,
        action: "Update",
        title: "Rejected self-profile field update",
        messageEn: "A self-profile update attempted to write protected or unknown fields.",
        severity: "warning",
        actor: { id: pluginUserId },
        metadata: { rejectedFields: rejectedFields.sort() },
      });
      ctx.status = 400;
      ctx.body = {
        message: "فقط فیلدهای مجاز پروفایل قابل ویرایش هستند.",
        error: "PROFILE_FIELDS_NOT_ALLOWED",
        fields: rejectedFields.sort(),
      };
      return;
    }
    const profilePayload: Record<string, any> = {};
    const hasOwn = Object.prototype.hasOwnProperty.call.bind(Object.prototype.hasOwnProperty);

    if (hasOwn(body, "FirstName")) {
      const firstName = normalizeRequiredProfileName(body.FirstName);
      if (!firstName) {
        ctx.status = 400;
        ctx.body = { message: "نام الزامی است" };
        return;
      }
      profilePayload.FirstName = firstName;
    }
    if (hasOwn(body, "LastName")) {
      const lastName = normalizeRequiredProfileName(body.LastName);
      if (!lastName) {
        ctx.status = 400;
        ctx.body = { message: "نام خانوادگی الزامی است" };
        return;
      }
      profilePayload.LastName = lastName;
    }
    if (hasOwn(body, "NationalCode")) {
      profilePayload.NationalCode =
        typeof body.NationalCode === "string" && body.NationalCode.trim().length > 0
          ? body.NationalCode.trim()
          : null;
    }
    if (hasOwn(body, "BirthDate")) {
      const normalizedBirthDate =
        typeof body.BirthDate === "string" && body.BirthDate.trim().length > 0
          ? body.BirthDate.trim()
          : null;
      profilePayload.BirthDate = normalizedBirthDate;
    }
    if (hasOwn(body, "Sex")) {
      const rawSex = body.Sex;
      if (rawSex === null || rawSex === undefined || rawSex === "") {
        profilePayload.Sex = null;
      } else if (typeof rawSex === "boolean") {
        profilePayload.Sex = rawSex;
      } else if (typeof rawSex === "string") {
        profilePayload.Sex = rawSex === "true" || rawSex === "1";
      } else {
        profilePayload.Sex = Boolean(rawSex);
      }
    }
    if (hasOwn(body, "Bio")) {
      profilePayload.Bio =
        typeof body.Bio === "string" && body.Bio.trim().length > 0 ? body.Bio.trim() : null;
    }

    let profileRecord = await strapi.db
      .query("api::local-user-info.local-user-info")
      .findOne({ where: { user: pluginUserId } });

    if (!profileRecord) {
      if (Object.keys(profilePayload).length > 0) {
        profileRecord = await strapi.entityService.create("api::local-user-info.local-user-info", {
          data: {
            user: pluginUserId,
            ...profilePayload,
          },
        });
      }
    } else if (Object.keys(profilePayload).length > 0) {
      await strapi.entityService.update("api::local-user-info.local-user-info", profileRecord.id, {
        data: profilePayload,
      });
    }

    await recordAdminAudit(strapi, {
      resourceType: "User",
      resourceId: pluginUserId,
      action: "Update",
      title: "Self-profile updated",
      messageEn: "An administrator updated their own allowed profile fields.",
      severity: "success",
      actor: { id: pluginUserId },
      metadata: { fields: Object.keys(profilePayload).sort() },
    });

    await self(ctx);
  } catch (err) {
    strapi.log.error(err);
    ctx.status = 500;
    ctx.body = {
      message: err.message,
    };
  }
}

async function registerInfo(ctx) {
  const { firstName, lastName, birthDate } = ctx.request.body;
  const user = ctx.state.user;
  const normalizedFirstName = normalizeRequiredProfileName(firstName);
  const normalizedLastName = normalizeRequiredProfileName(lastName);
  const normalizedBirthDate =
    typeof birthDate === "string" && birthDate.trim().length > 0 ? birthDate.trim() : null;

  // Validation applies only to this request; does not modify existing records except via the update below after validation passes.
  if (!normalizedFirstName) {
    ctx.status = 400;
    ctx.body = { message: "نام الزامی است" };
    return;
  }
  if (!normalizedLastName) {
    ctx.status = 400;
    ctx.body = { message: "نام خانوادگی الزامی است" };
    return;
  }

  try {
    if (!user?.id) {
      return ctx.unauthorized(UNAUTHORIZED_MESSAGE);
    }

    const pluginUserId = Number(user.id);
    const currentUser = await strapi.db
      .query("plugin::users-permissions.user")
      .findOne({ where: { id: pluginUserId } });
    if (!currentUser) return ctx.unauthorized(UNAUTHORIZED_MESSAGE);

    // Find profile record that points to plugin user
    let profileRecord = await strapi.db
      .query("api::local-user-info.local-user-info")
      .findOne({ where: { user: pluginUserId } });

    const wasFirstCompletion = !currentUser.ProfileCompletedAt;

    await strapi.db.transaction(async ({ trx }) => {
      if (!profileRecord) {
        profileRecord = await strapi.db.query("api::local-user-info.local-user-info").create({
          data: {
            user: pluginUserId,
            FirstName: normalizedFirstName,
            LastName: normalizedLastName,
            BirthDate: normalizedBirthDate,
          },
          transacting: trx,
        } as any);
      } else {
        await strapi.db.query("api::local-user-info.local-user-info").update({
          where: { id: profileRecord.id },
          data: {
            FirstName: normalizedFirstName,
            LastName: normalizedLastName,
            BirthDate: normalizedBirthDate ?? profileRecord?.BirthDate ?? null,
          },
          transacting: trx,
        } as any);
      }

      await strapi.db.query("plugin::users-permissions.user").update({
        where: { id: pluginUserId },
        data: {
          ProfileCompletedAt: currentUser.ProfileCompletedAt || new Date().toISOString(),
          ProfileManagedByCustomer: true,
        },
        transacting: trx,
      } as any);
    });

    if (wasFirstCompletion) {
      await strapi.service("api::notification.notification").createWelcome(pluginUserId);
    }

    ctx.body = {
      message: "info updated",
    };
    return ctx;
  } catch (err) {
    strapi.log.error(err);
    ctx.status = 500;
    ctx.body = {
      message: err.message,
    };
  }
}

export const __authControllerTestUtils = {
  normalizeRequiredProfileName,
};

async function loginWithPassword(ctx) {
  const { phone, password } = ctx.request.body;

  if (!phone || !password) {
    ctx.badRequest(PHONE_PASSWORD_REQUIRED_MESSAGE);
    return;
  }

  if (validatePhone(ctx, phone) !== 200) return;

  try {
    const finalUser = await verifyPasswordIdentity(phone, password);
    const token = await issueLegacyJwt(Number(finalUser.id));
    ctx.body = { message: "login successful", token };
  } catch (err) {
    if (err instanceof CredentialFlowError) {
      if (err.status === 401) ctx.unauthorized(err.message);
      else ctx.badRequest(err.message);
      return;
    }
    throw err;
  }
}

async function resetPassword(ctx) {
  const { otp, otpToken, newPassword } = ctx.request.body;

  if (String(otp || "").length !== 6 || !otpToken?.includes(".")) {
    ctx.badRequest(OTP_INVALID_MESSAGE);
    return;
  }

  try {
    await resetPasswordWithOtp(otpToken, String(otp), newPassword);
    ctx.body = { message: "رمز عبور با موفقیت تغییر کرد." };
  } catch (err) {
    if (err instanceof CredentialFlowError) {
      if (err.status === 401) ctx.unauthorized(err.message);
      else ctx.badRequest(err.message);
      return;
    }
    strapi.log.error(err);
    ctx.status = 500;
    ctx.body = { message: PASSWORD_RESET_FAILED_MESSAGE };
  }
}

async function resolvePluginUserId(ctx) {
  const pluginUserId = ctx.state.user?.id;
  return pluginUserId ? Number(pluginUserId) : undefined;
}
