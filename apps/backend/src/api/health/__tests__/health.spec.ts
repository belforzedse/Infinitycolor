import { RedisClient } from "../../../index";
import healthController from "../controllers/health";

const redis = RedisClient as unknown as Promise<any>;

beforeEach(async () => {
  process.env.REDIS_URL = "redis://test.invalid:6379";
  process.env.HEALTH_DEPENDENCY_TIMEOUT_MS = "250";
  const client = await redis;
  client.isReady = true;
  client.ping.mockReset().mockResolvedValue("PONG");
  (global as any).strapi.db.connection = {
    raw: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
  };
  (global as any).strapi.log.error.mockClear();
});

afterAll(() => {
  delete process.env.HEALTH_DEPENDENCY_TIMEOUT_MS;
});

it("returns ready only when PostgreSQL and auth Redis both respond", async () => {
  const ctx: any = {};
  await healthController.check(ctx);
  expect(ctx.status).toBe(200);
  expect(ctx.body).toMatchObject({
    ok: true,
    checks: { db: "ok", redis: "ok" },
    dependencies: { redis: { required: true, configured: true } },
  });
});

it("returns 503 when Redis is missing or unavailable", async () => {
  delete process.env.REDIS_URL;
  const missingCtx: any = {};
  await healthController.check(missingCtx);
  expect(missingCtx.status).toBe(503);
  expect(missingCtx.body.checks.redis).toBe("fail");
  expect(missingCtx.body.dependencies.redis.configured).toBe(false);

  process.env.REDIS_URL = "redis://test.invalid:6379";
  const client = await redis;
  client.ping.mockRejectedValueOnce(new Error("WRONGPASS invalid username-password pair"));
  const authCtx: any = {};
  await healthController.check(authCtx);
  expect(authCtx.status).toBe(503);
  expect(authCtx.body.checks.redis).toBe("fail");
});

it("returns 503 when PostgreSQL is unavailable", async () => {
  (global as any).strapi.db.connection.raw.mockRejectedValueOnce(
    new Error("connection refused"),
  );
  const ctx: any = {};
  await healthController.check(ctx);
  expect(ctx.status).toBe(503);
  expect(ctx.body.checks).toEqual({ db: "fail", redis: "ok" });
});

it("returns 503 while authentication Redis is disconnected", async () => {
  const client = await redis;
  client.isReady = false;
  const ctx: any = {};
  await healthController.check(ctx);
  expect(ctx.status).toBe(503);
  expect(ctx.body.checks.redis).toBe("fail");
  expect(client.ping).not.toHaveBeenCalled();
});

it("bounds Redis and PostgreSQL readiness checks with a timeout", async () => {
  process.env.HEALTH_DEPENDENCY_TIMEOUT_MS = "250";
  const client = await redis;
  client.ping.mockReturnValueOnce(new Promise(() => undefined));
  (global as any).strapi.db.connection.raw.mockReturnValueOnce(
    new Promise(() => undefined),
  );

  const startedAt = Date.now();
  const ctx: any = {};
  await healthController.check(ctx);
  expect(Date.now() - startedAt).toBeLessThan(1_000);
  expect(ctx.status).toBe(503);
  expect(ctx.body.checks).toEqual({ db: "fail", redis: "fail" });
});
