import { createClient } from "redis";
import { consumeRedisTokenBucket } from "../src/api/issue-report/lib/token-bucket";

async function main() {
  const redisUrl = process.env.ISSUE_REPORT_TEST_REDIS_URL || "";
  const target = new URL(redisUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(target.hostname)) {
    throw new Error("Rate-limit verification only accepts a loopback Redis URL");
  }

  const redis = createClient({ url: redisUrl });
  await redis.connect();
  try {
    const runId = `${Date.now()}:${process.pid}`;
    const startedAt = performance.now();
    const sameSource = await Promise.all(
      Array.from({ length: 100 }, () =>
        consumeRedisTokenBucket(redis, `issue-report-test:${runId}:same`, {
          capacity: 20,
          refillMs: 3_600_000,
          ttlMs: 7_200_000,
        }),
      ),
    );
    const sameAllowed = sameSource.filter((result) => result.allowed).length;
    if (sameAllowed !== 20) {
      throw new Error(`Concurrent source bypassed allowance: expected 20, received ${sameAllowed}`);
    }

    const independent = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        consumeRedisTokenBucket(redis, `issue-report-test:${runId}:source:${index}`, {
          capacity: 1,
          refillMs: 3_600_000,
          ttlMs: 7_200_000,
        }),
      ),
    );
    const independentAllowed = independent.filter((result) => result.allowed).length;
    if (independentAllowed !== 100) {
      throw new Error(
        `Independent sources hit an aggregate cap: ${independentAllowed}/100 allowed`,
      );
    }

    const elapsedMs = performance.now() - startedAt;
    console.log(
      JSON.stringify({
        sameSource: { attempted: 100, allowed: sameAllowed, rejected: 100 - sameAllowed },
        independentSources: {
          attempted: 100,
          allowed: independentAllowed,
          rejected: 100 - independentAllowed,
        },
        elapsedMs: Math.round(elapsedMs * 100) / 100,
      }),
    );
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Rate-limit verification failed");
  process.exitCode = 1;
});
