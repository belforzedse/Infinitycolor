import {
  assertUserMayStartSession,
  CredentialFlowError,
  createOtpChallenge,
  hasUserForPhone,
  isAcceptedPhone,
  resetPasswordWithOtp,
  verifyOtpIdentityWithStatus,
  verifyPasswordIdentity,
} from "../../auth/services/credential-flow";
import { resolveAdminActor } from "../../../utils/adminAuthorization";

async function adminSnapshot(user: any) {
  const actor = await resolveAdminActor(strapi, user);
  if (!actor) return undefined;
  const info = actor.user?.user_info;
  const fullName = `${info?.FirstName || ""} ${info?.LastName || ""}`.trim();
  return {
    label: fullName || actor.user?.username || actor.user?.email || `User ${actor.user.id}`,
    roleId: String(actor.user?.role?.id || actor.role),
    roleName: String(actor.user?.role?.name || actor.role),
  };
}

function validatePhoneOrRespond(ctx, phone: unknown): phone is string {
  if (isAcceptedPhone(phone)) return true;
  ctx.status = 400;
  ctx.body = { message: "شماره همراه وارد شده معتبر نیست", error: "PHONE_INVALID" };
  return false;
}

function handleCredentialError(ctx, error: unknown): void {
  if (error instanceof CredentialFlowError) {
    ctx.status = error.status;
    ctx.body = { message: error.message, error: error.code };
    return;
  }
  strapi.log.error("Better Auth bridge operation failed", {
    reasonCode: error instanceof Error ? error.name : "UNKNOWN",
  });
  ctx.status = 500;
  ctx.body = {
    message: "احراز هویت ناموفق بود. دوباره تلاش کنید.",
    error: "BRIDGE_OPERATION_FAILED",
  };
}

export default {
  async phoneStatus(ctx) {
    const { phone } = ctx.request.body ?? {};
    if (!validatePhoneOrRespond(ctx, phone)) return;
    try {
      ctx.body = { hasUser: await hasUserForPhone(phone) };
    } catch (error) {
      handleCredentialError(ctx, error);
    }
  },

  async otpRequest(ctx) {
    const { phone } = ctx.request.body ?? {};
    if (!validatePhoneOrRespond(ctx, phone)) return;
    try {
      ctx.body = { challengeId: await createOtpChallenge(ctx, phone) };
    } catch (error) {
      handleCredentialError(ctx, error);
    }
  },

  async otpVerify(ctx) {
    const { challengeId, otp } = ctx.request.body ?? {};
    try {
      const { user, isNewUser, needsProfileCompletion } = await verifyOtpIdentityWithStatus(
        String(challengeId ?? ""),
        String(otp ?? ""),
      );
      await assertUserMayStartSession(user);
      ctx.body = {
        strapiUserId: Number(user.id),
        confirmed: Boolean(user.confirmed),
        isNewUser,
        needsProfileCompletion,
        admin: await adminSnapshot(user),
      };
    } catch (error) {
      handleCredentialError(ctx, error);
    }
  },

  async passwordVerify(ctx) {
    const { phone, password } = ctx.request.body ?? {};
    if (!validatePhoneOrRespond(ctx, phone)) return;
    try {
      const user = await verifyPasswordIdentity(phone, String(password ?? ""));
      await assertUserMayStartSession(user);
      ctx.body = {
        strapiUserId: Number(user.id),
        confirmed: Boolean(user.confirmed),
        needsProfileCompletion: !user.ProfileCompletedAt,
        admin: await adminSnapshot(user),
      };
    } catch (error) {
      handleCredentialError(ctx, error);
    }
  },

  async passwordReset(ctx) {
    const { challengeId, otp, newPassword } = ctx.request.body ?? {};
    try {
      const user = await resetPasswordWithOtp(
        String(challengeId ?? ""),
        String(otp ?? ""),
        String(newPassword ?? ""),
      );
      ctx.body = {
        strapiUserId: Number(user.id),
        confirmed: Boolean(user.confirmed),
        admin: await adminSnapshot(user),
      };
    } catch (error) {
      handleCredentialError(ctx, error);
    }
  },
};
