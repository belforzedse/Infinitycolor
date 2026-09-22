import { RedisClient } from "../../../index";
import { metricsSnapshot } from "../../../utils/metrics";

type HealthCheckStatus = "ok" | "fail";

const dependencyTimeoutMs = () => {
  const configured = Number(process.env.HEALTH_DEPENDENCY_TIMEOUT_MS || 1_500);
  return Number.isFinite(configured)
    ? Math.min(4_000, Math.max(250, configured))
    : 1_500;
};

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          dependencyTimeoutMs(),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pingDatabase(): Promise<HealthCheckStatus> {
  try {
    await withTimeout(strapi.db.connection.raw("SELECT 1"), "database ping");
    return "ok";
  } catch (error) {
    strapi.log.error("Healthcheck database ping failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return "fail";
  }
}

async function pingRedis(): Promise<HealthCheckStatus> {
  if (!process.env.REDIS_URL) return "fail";

  try {
    const client: any = await withTimeout(RedisClient as any, "redis connect");
    if (typeof client?.isReady === "boolean" && !client.isReady) return "fail";
    const response = await withTimeout(client.ping(), "redis ping");
    return response === "PONG" ? "ok" : "fail";
  } catch (error) {
    strapi.log.error("Healthcheck redis ping failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return "fail";
  }
}

export default {
  async check(ctx: any) {
    const [db, redis] = await Promise.all([pingDatabase(), pingRedis()]);
    const ok = db === "ok" && redis === "ok";

    ctx.status = ok ? 200 : 503;
    ctx.body = {
      ok,
      service: "strapi",
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      checks: { db, redis },
      dependencies: {
        redis: {
          required: true,
          configured: Boolean(process.env.REDIS_URL),
        },
      },
      // In-process counters since the last restart. Operational only: nothing
      // decides anything from them, and anything a decision depends on lives in
      // `payment_attempt_evidence`.
      metrics: metricsSnapshot(strapi),
    };
  },
};
