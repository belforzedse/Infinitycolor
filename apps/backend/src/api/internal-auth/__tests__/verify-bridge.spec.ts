import { createBridgeHeaders, BRIDGE_BODY_DIGEST_HEADER } from "@repo/auth-core";
import { RedisClient } from "../../..";
import createBridgeMiddleware from "../middlewares/verify-bridge";

const secret = "test-bridge-secret-at-least-32-characters";
const path = "/api/internal/auth/password/verify";

function context(body: unknown, headers: Record<string, string>) {
  return {
    request: {
      body,
      method: "POST",
      path,
      headers,
    },
    status: 200,
    body: undefined as unknown,
  };
}

describe("internal Better Auth bridge authentication", () => {
  beforeEach(async () => {
    process.env.BETTER_AUTH_BRIDGE_ENABLED = "true";
    process.env.AUTH_STRAPI_BRIDGE_SECRET = secret;
    ((await RedisClient).set as jest.Mock).mockReset().mockResolvedValue("OK");
  });

  test("accepts a fresh, correctly signed request once", async () => {
    const body = { phone: "09123456789", password: "never-log-this" };
    const signed = createBridgeHeaders(secret, "POST", path, body);
    const ctx = context(body, signed.headers);
    const next = jest.fn();

    await createBridgeMiddleware()(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((await RedisClient).set).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:bridge:nonce:/),
      "1",
      { EX: 60, NX: true },
    );
  });

  test("rejects body tampering before reserving the nonce", async () => {
    const body = { phone: "09123456789", password: "first-value" };
    const signed = createBridgeHeaders(secret, "POST", path, body);
    const ctx = context({ ...body, password: "tampered-value" }, signed.headers);
    const next = jest.fn();

    await createBridgeMiddleware()(ctx, next);

    expect(ctx.status).toBe(401);
    expect(ctx.body).toEqual(expect.objectContaining({ error: "BRIDGE_BODY_TAMPERED" }));
    expect(next).not.toHaveBeenCalled();
    expect((await RedisClient).set).not.toHaveBeenCalled();
  });

  test("rejects stale timestamps and nonce replay", async () => {
    const body = { phone: "09123456789" };
    const stale = createBridgeHeaders(secret, "POST", path, body, Date.now() - 31_000);
    const staleCtx = context(body, stale.headers);
    await createBridgeMiddleware()(staleCtx, jest.fn());
    expect(staleCtx.status).toBe(401);

    const fresh = createBridgeHeaders(secret, "POST", path, body);
    ((await RedisClient).set as jest.Mock).mockResolvedValueOnce(null);
    const replayCtx = context(body, fresh.headers);
    await createBridgeMiddleware()(replayCtx, jest.fn());
    expect(replayCtx.status).toBe(409);
    expect(replayCtx.body).toEqual(expect.objectContaining({ error: "BRIDGE_NONCE_REPLAY" }));
  });

  test("rejects a forged digest header", async () => {
    const body = { phone: "09123456789" };
    const signed = createBridgeHeaders(secret, "POST", path, body);
    signed.headers[BRIDGE_BODY_DIGEST_HEADER] = "forged";
    const ctx = context(body, signed.headers);
    await createBridgeMiddleware()(ctx, jest.fn());
    expect(ctx.status).toBe(401);
    expect(ctx.body).toEqual(expect.objectContaining({ error: "BRIDGE_BODY_TAMPERED" }));
  });
});
