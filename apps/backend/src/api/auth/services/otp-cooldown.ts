import { createHmac, randomBytes } from "node:crypto";
import { RedisClient } from "../../..";

export const OTP_PHONE_COOLDOWN_SECONDS = 30;

const RELEASE_COOLDOWN_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface OtpPhoneCooldownLease {
  key: string;
  owner: string;
}

export type OtpPhoneCooldownDecision =
  | { allowed: true; lease: OtpPhoneCooldownLease }
  | { allowed: false; retryAfterSeconds: number };

export function otpPhoneCooldownKey(canonicalPhone: string): string {
  const secret = String(process.env.APP_KEYS || "")
    .split(",")[0]
    ?.trim();
  if (!secret) throw new Error("OTP_PHONE_COOLDOWN_SECRET_UNAVAILABLE");
  const digest = createHmac("sha256", secret)
    .update(`auth-otp-phone-cooldown:v1:${canonicalPhone}`, "utf8")
    .digest("hex");
  return `auth:otp-phone-cooldown:${digest}`;
}

export async function acquireOtpPhoneCooldown(
  canonicalPhone: string,
): Promise<OtpPhoneCooldownDecision> {
  const redis = await RedisClient;
  const key = otpPhoneCooldownKey(canonicalPhone);
  const owner = randomBytes(24).toString("base64url");
  const stored = await redis.set(key, owner, {
    EX: OTP_PHONE_COOLDOWN_SECONDS,
    NX: true,
  });
  if (stored === "OK") return { allowed: true, lease: { key, owner } };

  const ttl = await redis.ttl(key);
  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      1,
      Math.min(
        Number.isSafeInteger(ttl) && ttl > 0 ? ttl : OTP_PHONE_COOLDOWN_SECONDS,
        OTP_PHONE_COOLDOWN_SECONDS,
      ),
    ),
  };
}

export async function releaseOtpPhoneCooldown(lease: OtpPhoneCooldownLease): Promise<boolean> {
  const result = await (
    await RedisClient
  ).eval(RELEASE_COOLDOWN_SCRIPT, {
    keys: [lease.key],
    arguments: [lease.owner],
  });
  return Number(result) === 1;
}

export const __otpPhoneCooldownInternals = {
  RELEASE_COOLDOWN_SCRIPT,
};
