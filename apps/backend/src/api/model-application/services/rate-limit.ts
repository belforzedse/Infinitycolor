import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { RedisClient } from "../../..";
import { consumeRedisTokenBucket, ISSUE_REPORT_TOKEN_BUCKET_SCRIPT } from "../../issue-report/lib/token-bucket";

type RateLimitContext = {
  get: (name: string) => string;
  req: { socket?: { remoteAddress?: string } };
  state?: { user?: { id?: unknown } };
};

type RateLimitConfig = {
  capacity: number;
  refillSeconds: number;
};

export type ModelApplicationRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function actorConfig(authenticated: boolean): RateLimitConfig {
  return authenticated
    ? {
        capacity: boundedInteger("MODEL_APPLICATION_USER_BURST", 8, 1, 50),
        refillSeconds: boundedInteger("MODEL_APPLICATION_USER_REFILL_SECONDS", 120, 1, 86_400),
      }
    : {
        capacity: boundedInteger("MODEL_APPLICATION_IP_BURST", 5, 1, 50),
        refillSeconds: boundedInteger("MODEL_APPLICATION_IP_REFILL_SECONDS", 120, 1, 86_400),
      };
}

function rateKey(kind: "user" | "ip", value: string): string {
  const secret = String(process.env.APP_KEYS || "")
    .split(",")[0]
    ?.trim();
  if (!secret) throw new Error("MODEL_APPLICATION_RATE_SECRET_UNAVAILABLE");
  const digest = createHmac("sha256", secret)
    .update(`model-application-rate:v1:${kind}:${value}`, "utf8")
    .digest("hex");
  return `model-application:rate:${digest}`;
}

function normalizeIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const candidate = trimmed.toLowerCase().startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  return candidate.length <= 64 && isIP(candidate) !== 0 ? candidate : null;
}

function trustedSourceIp(ctx: RateLimitContext): string | null {
  const forwarded = normalizeIp(ctx.get("x-real-ip"));
  if (forwarded) return forwarded;
  const socket = ctx.req.socket as { remoteAddress?: string };
  return normalizeIp(socket.remoteAddress);
}

export async function consumeModelApplicationRateLimit(
  ctx: RateLimitContext,
): Promise<ModelApplicationRateLimitResult> {
  const userId = Number((ctx.state as { user?: { id?: unknown } }).user?.id);
  const authenticated = Number.isSafeInteger(userId) && userId > 0;
  const ip = authenticated ? null : trustedSourceIp(ctx);
  if (!authenticated && !ip) throw new Error("MODEL_APPLICATION_SOURCE_UNAVAILABLE");

  const config = actorConfig(authenticated);
  const key = authenticated ? rateKey("user", String(userId)) : rateKey("ip", ip!);
  const ttlMs = Math.max(60_000, config.capacity * config.refillSeconds * 2_000);
  const redis = await RedisClient;
  const result = await consumeRedisTokenBucket(redis, key, {
    capacity: config.capacity,
    refillMs: config.refillSeconds * 1_000,
    ttlMs,
  });
  return result.allowed
    ? { allowed: true }
    : { allowed: false, retryAfterSeconds: Math.max(1, result.retryAfterSeconds) };
}

export const __modelApplicationRateLimitInternals = {
  TOKEN_BUCKET_SCRIPT: ISSUE_REPORT_TOKEN_BUCKET_SCRIPT,
  actorConfig,
  rateKey,
  trustedSourceIp,
};

export default () => ({});
