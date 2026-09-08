import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Context } from "koa";

import { RedisClient } from "../../..";
import { consumeRedisTokenBucket, ISSUE_REPORT_TOKEN_BUCKET_SCRIPT } from "../lib/token-bucket";

type RateLimitConfig = {
  capacity: number;
  refillSeconds: number;
};

export type IssueReportRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function actorConfig(authenticated: boolean): RateLimitConfig {
  return authenticated
    ? {
        capacity: boundedInteger("ISSUE_REPORT_USER_BURST", 6, 1, 100),
        refillSeconds: boundedInteger("ISSUE_REPORT_USER_REFILL_SECONDS", 300, 1, 86_400),
      }
    : {
        capacity: boundedInteger("ISSUE_REPORT_IP_BURST", 20, 1, 1_000),
        refillSeconds: boundedInteger("ISSUE_REPORT_IP_REFILL_SECONDS", 30, 1, 86_400),
      };
}

function rateKey(kind: "user" | "ip", value: string): string {
  const secret = String(process.env.APP_KEYS || "")
    .split(",")[0]
    ?.trim();
  if (!secret) throw new Error("ISSUE_REPORT_RATE_SECRET_UNAVAILABLE");
  const digest = createHmac("sha256", secret)
    .update(`issue-report-rate:v1:${kind}:${value}`, "utf8")
    .digest("hex");
  return `issue-report:rate:${digest}`;
}

function normalizeIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const candidate = trimmed.toLowerCase().startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
  return candidate.length <= 64 && isIP(candidate) !== 0 ? candidate : null;
}

function trustedSourceIp(ctx: Context): string | null {
  // The edge proxy overwrites X-Real-IP, and the internal gateway forwards that
  // exact value. Do not use client-supplied forwarding or CDN headers here.
  const forwarded = normalizeIp(ctx.get("x-real-ip"));
  if (forwarded) return forwarded;
  return normalizeIp((ctx.req as any)?.socket?.remoteAddress);
}

export async function consumeIssueReportRateLimit(
  ctx: Context,
): Promise<IssueReportRateLimitResult> {
  const userId = Number((ctx.state as any)?.user?.id);
  const authenticated = Number.isSafeInteger(userId) && userId > 0;
  const ip = authenticated ? null : trustedSourceIp(ctx);
  if (!authenticated && !ip) throw new Error("ISSUE_REPORT_SOURCE_UNAVAILABLE");

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

export const __issueReportRateLimitInternals = {
  TOKEN_BUCKET_SCRIPT: ISSUE_REPORT_TOKEN_BUCKET_SCRIPT,
  actorConfig,
  rateKey,
  trustedSourceIp,
};

// This module lives beside the generated content-type service so Strapi can
// discover it safely while controllers import the named limiter above.
export default () => ({});
