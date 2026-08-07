import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { RedisClient } from "../../..";
import {
  canonicalCustomerPhone,
  customerPhoneAdvisoryKey,
  customerPhoneStorageVariants,
} from "../../../utils/customerPhoneIdentity";
import { ROLE_NAMES, fetchRoleByName } from "../../../utils/roles";

export const OTP_INVALID_MESSAGE = "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.";
export const USER_NOT_FOUND_OR_PASSWORD_INCORRECT = "شماره همراه یا رمز عبور اشتباه است.";
export const PHONE_PASSWORD_REQUIRED_MESSAGE = "شماره همراه و رمز عبور الزامی است.";
export const OTP_MAX_ATTEMPTS = 5;
const ACCOUNT_UNAVAILABLE_MESSAGE = "احراز هویت ناموفق بود. دوباره تلاش کنید.";
const PHONE_IDENTITY_AMBIGUOUS_MESSAGE =
  "این شماره همراه به بیش از یک حساب متصل است. لطفا با پشتیبانی تماس بگیرید.";

interface OtpChallenge {
  code: string;
  merchant?: number;
  phone: string;
  IsVerified?: boolean;
  attempts?: number;
}

export class CredentialFlowError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "CredentialFlowError";
  }
}

export function isAcceptedPhone(value: unknown): value is string {
  return typeof value === "string" && /^(?:09[0-9]{9}|\+989[0-9]{9})$/.test(value.trim());
}

export function normalizeOtpPhone(phone: string): string {
  return canonicalCustomerPhone(phone) || phone.trim();
}

export function phoneStorageVariants(phone: string): [string, string] {
  return customerPhoneStorageVariants(phone);
}

async function findUsersByPhone(phone: string, transacting?: any): Promise<any[]> {
  const users = await strapi.query("plugin::users-permissions.user").findMany({
    where: { phone: { $in: phoneStorageVariants(phone) } },
    limit: 2,
    ...(transacting ? { transacting } : {}),
  });
  return Array.isArray(users) ? users : [];
}

function requireUnambiguousPhoneIdentity(users: any[]): any | null {
  if (users.length > 1) {
    throw new CredentialFlowError(
      PHONE_IDENTITY_AMBIGUOUS_MESSAGE,
      409,
      "PHONE_IDENTITY_AMBIGUOUS",
    );
  }
  return users[0] ?? null;
}

async function findUserByPhone(phone: string, transacting?: any): Promise<any | null> {
  return requireUnambiguousPhoneIdentity(await findUsersByPhone(phone, transacting));
}

export async function hasUserForPhone(phone: string): Promise<boolean> {
  return (await findUsersByPhone(phone)).length > 0;
}

export async function createOtpChallenge(ctx: any, phone: string): Promise<string> {
  const normalizedPhone = normalizeOtpPhone(phone);
  const merchant = await findUserByPhone(normalizedPhone);
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const challengeId = `${Date.now().toString(36)}.${crypto.randomBytes(24).toString("base64url")}`;
  const redis = await RedisClient;

  const stored = await redis.set(
    challengeId,
    JSON.stringify({
      code,
      merchant: merchant?.id,
      phone: normalizedPhone,
      IsVerified: merchant?.IsVerified,
      attempts: 0,
    } satisfies OtpChallenge),
    { EX: 300, NX: true },
  );
  if (stored !== "OK") {
    throw new CredentialFlowError(
      "ارسال کد تایید ناموفق بود. دوباره تلاش کنید.",
      503,
      "OTP_STORE_FAILED",
    );
  }

  const smsStatus = await strapi.service("api::messaging.messaging").sendSMS(ctx, {
    phone,
    message: code,
    isOTP: true,
  });
  if (smsStatus !== 200) {
    await redis.del(challengeId);
    throw new CredentialFlowError(
      "ارسال کد تایید ناموفق بود. دوباره تلاش کنید.",
      502,
      "OTP_SEND_FAILED",
    );
  }
  return challengeId;
}

const CONSUME_OTP_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'MISSING'} end
local value = cjson.decode(raw)
local attempts = tonumber(value.attempts or 0)
local maximum = tonumber(ARGV[2])
if attempts >= maximum then
  redis.call('DEL', KEYS[1])
  return {'LOCKED'}
end
if tostring(value.code or '') ~= tostring(ARGV[1]) then
  attempts = attempts + 1
  value.attempts = attempts
  if attempts >= maximum then
    redis.call('DEL', KEYS[1])
    return {'LOCKED'}
  end
  redis.call('SET', KEYS[1], cjson.encode(value), 'KEEPTTL', 'XX')
  return {'INVALID'}
end
redis.call('DEL', KEYS[1])
return {'OK', raw}
`;

export async function consumeOtpChallenge(challengeId: string, otp: string): Promise<OtpChallenge> {
  if (!challengeId.includes(".") || !/^[0-9]{6}$/.test(otp)) {
    throw new CredentialFlowError(OTP_INVALID_MESSAGE, 400, "OTP_INVALID");
  }
  const result = (await (
    await RedisClient
  ).eval(CONSUME_OTP_SCRIPT, {
    keys: [challengeId],
    arguments: [otp, String(OTP_MAX_ATTEMPTS)],
  })) as unknown;
  if (!Array.isArray(result) || result[0] !== "OK" || typeof result[1] !== "string") {
    throw new CredentialFlowError(OTP_INVALID_MESSAGE, 400, "OTP_INVALID");
  }
  try {
    const challenge = JSON.parse(result[1]) as OtpChallenge;
    if (!challenge.phone || !challenge.code) throw new Error("malformed challenge");
    return challenge;
  } catch {
    throw new CredentialFlowError(OTP_INVALID_MESSAGE, 400, "OTP_INVALID");
  }
}

interface OtpIdentityResolution {
  user: any;
  isNewUser: boolean;
  needsProfileCompletion: boolean;
}

async function markUserClaimed(user: any, transacting?: any): Promise<any> {
  const now = new Date().toISOString();
  const data = {
    confirmed: true,
    IsVerified: true,
    ClaimedAt: user.ClaimedAt || now,
    ProfileManagedByCustomer: true,
  };
  const saved = await strapi.db.query("plugin::users-permissions.user").update({
    where: { id: user.id },
    data,
    ...(transacting ? { transacting } : {}),
  } as any);
  return saved || { ...user, ...data };
}

async function resolveOrCreateOtpUser(challenge: OtpChallenge): Promise<OtpIdentityResolution> {
  const customerRole = await fetchRoleByName(strapi, ROLE_NAMES.CUSTOMER);
  return strapi.db.transaction(async ({ trx }) => {
    const databaseClient = String(
      (strapi.db.connection as any)?.client?.config?.client || "",
    ).toLowerCase();
    if (databaseClient.includes("pg") || databaseClient.includes("postgres")) {
      await trx.raw("select pg_advisory_xact_lock(?)", [customerPhoneAdvisoryKey(challenge.phone)]);
    }

    let user = await findUserByPhone(challenge.phone, trx);
    if (user) {
      if (challenge.merchant && Number(user.id) !== Number(challenge.merchant)) {
        throw new CredentialFlowError(
          PHONE_IDENTITY_AMBIGUOUS_MESSAGE,
          409,
          "PHONE_IDENTITY_CHANGED",
        );
      }
      user = await markUserClaimed(user, trx);
      return {
        user,
        isNewUser: false,
        needsProfileCompletion: !user.ProfileCompletedAt,
      };
    }

    const email = `${challenge.phone.replace(/\D/g, "") || "user"}@identity.invalid`;
    const now = new Date().toISOString();
    user = await strapi.db.query("plugin::users-permissions.user").create({
      data: {
        username: challenge.phone,
        email,
        phone: challenge.phone,
        role: customerRole?.id,
        confirmed: true,
        blocked: false,
        IsActive: true,
        IsVerified: true,
        AccountOrigin: "Native",
        ClaimedAt: now,
        ProfileCompletedAt: null,
        ProfileManagedByCustomer: true,
      },
      transacting: trx,
    } as any);
    await strapi.db.query("api::local-user-info.local-user-info").create({
      data: { user: user.id },
      transacting: trx,
    } as any);
    return { user, isNewUser: true, needsProfileCompletion: true };
  });
}

export async function verifyOtpIdentity(challengeId: string, otp: string): Promise<any> {
  return (await verifyOtpIdentityWithStatus(challengeId, otp)).user;
}

export async function verifyOtpIdentityWithStatus(
  challengeId: string,
  otp: string,
): Promise<OtpIdentityResolution> {
  const challenge = await consumeOtpChallenge(challengeId, otp);
  return resolveOrCreateOtpUser(challenge);
}

export async function verifyPasswordIdentity(phone: string, password: string): Promise<any> {
  if (!phone || !password) {
    throw new CredentialFlowError(PHONE_PASSWORD_REQUIRED_MESSAGE, 400, "CREDENTIALS_REQUIRED");
  }
  const sanitizedPhone = String(phone).trim();

  let user = await strapi.query("plugin::users-permissions.user").findOne({
    where: { phone: { $eq: sanitizedPhone } },
    select: ["id", "password", "confirmed", "blocked"],
  });
  if (!user) {
    const matchingUsers = await strapi.query("plugin::users-permissions.user").findMany({
      where: { phone: { $in: phoneStorageVariants(sanitizedPhone) } },
      select: ["id", "password", "confirmed", "blocked"],
      limit: 2,
    });
    user = requireUnambiguousPhoneIdentity(Array.isArray(matchingUsers) ? matchingUsers : []);
  }

  if (!user?.password) {
    throw new CredentialFlowError(USER_NOT_FOUND_OR_PASSWORD_INCORRECT, 401, "INVALID_CREDENTIALS");
  }
  const valid = await strapi
    .plugin("users-permissions")
    .service("user")
    .validatePassword(password, user.password);
  if (!valid) {
    throw new CredentialFlowError(USER_NOT_FOUND_OR_PASSWORD_INCORRECT, 401, "INVALID_CREDENTIALS");
  }
  return markUserClaimed(user);
}

/** Mirrors the native Users & Permissions account-state checks before a BA session exists. */
export async function assertUserMayStartSession(user: any): Promise<void> {
  if (!user?.id || user.blocked) {
    throw new CredentialFlowError(
      ACCOUNT_UNAVAILABLE_MESSAGE,
      401,
      user?.blocked ? "USER_BLOCKED" : "USER_NOT_FOUND",
    );
  }
  const settings = (await strapi
    .store({ type: "plugin", name: "users-permissions" })
    .get({ key: "advanced" })) as { email_confirmation?: boolean };
  if (settings.email_confirmation && !user.confirmed) {
    throw new CredentialFlowError(ACCOUNT_UNAVAILABLE_MESSAGE, 401, "USER_UNCONFIRMED");
  }
}

export async function updatePasswordAndLegacyHash(
  pluginUserId: number,
  password: string,
  transacting?: any,
): Promise<string> {
  const passwordHash = await bcrypt.hash(password, 10);
  const userQuery = strapi.db.query("plugin::users-permissions.user");
  const legacyQuery = strapi.db.query("api::local-user.local-user");
  await userQuery.update({
    where: { id: pluginUserId },
    data: { password: passwordHash },
    ...(transacting ? { transacting } : {}),
  } as any);
  const legacy = await legacyQuery.findOne({
    where: { strapi_user: pluginUserId },
    ...(transacting ? { transacting } : {}),
  } as any);
  if (legacy) {
    await legacyQuery.update({
      where: { id: legacy.id },
      data: { Password: passwordHash },
      ...(transacting ? { transacting } : {}),
    } as any);
  }
  return passwordHash;
}

export async function resetPasswordWithOtp(
  challengeId: string,
  otp: string,
  newPassword: string,
): Promise<any> {
  const challenge = await consumeOtpChallenge(challengeId, otp);
  if (!challenge.merchant) {
    throw new CredentialFlowError(
      "احراز هویت ناموفق بود. دوباره تلاش کنید.",
      401,
      "USER_NOT_FOUND",
    );
  }
  const pluginUser = await strapi.entityService.findOne(
    "plugin::users-permissions.user",
    challenge.merchant,
  );
  if (!pluginUser) {
    throw new CredentialFlowError(
      "احراز هویت ناموفق بود. دوباره تلاش کنید.",
      401,
      "USER_NOT_FOUND",
    );
  }
  await strapi.db.transaction(async ({ trx }) => {
    await updatePasswordAndLegacyHash(Number(pluginUser.id), newPassword, trx);
  });
  return pluginUser;
}

export async function issueLegacyJwt(userId: number): Promise<string> {
  if (process.env.LEGACY_AUTH_JWT_ISSUANCE_ENABLED === "false") {
    throw new CredentialFlowError("صدور توکن قدیمی غیرفعال شده است", 503, "LEGACY_JWT_DISABLED");
  }
  return strapi.plugin("users-permissions").service("jwt").issue({ id: userId });
}
