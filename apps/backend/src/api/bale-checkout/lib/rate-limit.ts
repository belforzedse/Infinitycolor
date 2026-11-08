import { RedisClient } from "../../..";
import { consumeRedisTokenBucket } from "../../issue-report/lib/token-bucket";
import { BaleApiError, baleUnavailable } from "./protocol";

const limits = {
  inventory: { capacity: 120, refillMs: 500 },
  create: { capacity: 30, refillMs: 2_000 },
  status: { capacity: 120, refillMs: 500 },
  claim: { capacity: 12, refillMs: 5_000 },
  read: { capacity: 60, refillMs: 1_000 },
};

export async function limitBaleRequest(route: keyof typeof limits, userId?: number) {
  const config = limits[route];
  let result: Awaited<ReturnType<typeof consumeRedisTokenBucket>>;
  try {
    const redis = await RedisClient;
    if (!redis.isReady) throw new Error("Bale rate limiter is unavailable");
    result = await consumeRedisTokenBucket(redis, `bale:rate:v1:${route}:${userId ?? "bot"}`, {
      ...config,
      ttlMs: 2 * config.capacity * config.refillMs,
    });
  } catch {
    throw baleUnavailable();
  }
  if (!result.allowed) {
    throw new BaleApiError(429, "BALE_RATE_LIMITED", "Try again shortly.", {
      retryAfterSeconds: Math.max(1, result.retryAfterSeconds),
    });
  }
}
