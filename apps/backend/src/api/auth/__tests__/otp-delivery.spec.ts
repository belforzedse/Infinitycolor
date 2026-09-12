import { RedisClient } from "../../../index";
import { CredentialFlowError, createOtpChallenge } from "../services/credential-flow";
import { handleCredentialError } from "../../internal-auth/controllers/internal-auth";
import {
  acquireOtpPhoneCooldown,
  otpPhoneCooldownKey,
  releaseOtpPhoneCooldown,
} from "../services/otp-cooldown";

describe("OTP delivery abuse controls", () => {
  let redis: any;

  beforeEach(async () => {
    process.env.APP_KEYS = "test-app-key-for-otp-cooldown";
    redis = await RedisClient;
    redis.set.mockReset().mockResolvedValue("OK");
    redis.ttl.mockReset().mockResolvedValue(120);
    redis.del.mockReset().mockResolvedValue(1);
    redis.eval.mockReset().mockResolvedValue(1);
    (global as any).strapi.log.info.mockReset();
    (global as any).strapi.query = jest.fn(() => ({
      findMany: jest.fn().mockResolvedValue([]),
    }));
    (global as any).strapi.service = jest.fn(() => ({
      sendSMS: jest.fn().mockResolvedValue(200),
    }));
  });

  test("HMAC cooldown keys contain neither canonical nor local phone form", () => {
    const key = otpPhoneCooldownKey("+989123456789");
    expect(key).toMatch(/^auth:otp-phone-cooldown:[a-f0-9]{64}$/);
    expect(key).not.toContain("989123456789");
    expect(key).not.toContain("09123456789");
  });

  test("returns a bounded retry duration when the phone lease already exists", async () => {
    redis.set.mockResolvedValueOnce(null);
    redis.ttl.mockResolvedValueOnce(37);
    await expect(acquireOtpPhoneCooldown("+989123456789")).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 37,
    });
  });

  test("propagates the bounded cooldown through the bridge response", () => {
    const ctx = { set: jest.fn(), status: 0, body: undefined as unknown };
    handleCredentialError(
      ctx,
      new CredentialFlowError(
        "درخواست‌های زیادی ارسال شده است. کمی بعد دوباره تلاش کنید.",
        429,
        "OTP_PHONE_COOLDOWN",
        37,
      ),
    );
    expect(ctx.set).toHaveBeenCalledWith("Retry-After", "37");
    expect(ctx.status).toBe(429);
    expect(ctx.body).toEqual({
      message: "درخواست‌های زیادی ارسال شده است. کمی بعد دوباره تلاش کنید.",
      error: "OTP_PHONE_COOLDOWN",
    });
  });

  test("releases a lease only through compare-and-delete", async () => {
    const decision = await acquireOtpPhoneCooldown("+989123456789");
    expect(decision.allowed).toBe(true);
    if (decision.allowed === false) throw new Error("expected a lease");
    await expect(releaseOtpPhoneCooldown(decision.lease)).resolves.toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      {
        keys: [decision.lease.key],
        arguments: [decision.lease.owner],
      },
    );
  });

  test("concurrent requests perform one lookup and one provider attempt", async () => {
    let cooldownHeld = false;
    redis.set.mockImplementation(async (key: string) => {
      if (!key.startsWith("auth:otp-phone-cooldown:")) return "OK";
      if (cooldownHeld) return null;
      cooldownHeld = true;
      return "OK";
    });
    redis.ttl.mockResolvedValue(120);
    const findMany = jest.fn().mockResolvedValue([]);
    const sendSMS = jest.fn().mockResolvedValue(200);
    (global as any).strapi.query = jest.fn(() => ({ findMany }));
    (global as any).strapi.service = jest.fn(() => ({ sendSMS }));

    const results = await Promise.allSettled([
      createOtpChallenge({}, "09123456789"),
      createOtpChallenge({}, "+989123456789"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { status: 429, code: "OTP_PHONE_COOLDOWN", retryAfterSeconds: 120 },
    });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(sendSMS).toHaveBeenCalledTimes(1);
  });

  test("known and unknown phones use the same lookup and provider work shape", async () => {
    const findMany = jest.fn(async ({ where }) =>
      where.phone.$in.includes("+989123456789") ? [{ id: 17 }] : [],
    );
    const sendSMS = jest.fn().mockResolvedValue(200);
    (global as any).strapi.query = jest.fn(() => ({ findMany }));
    (global as any).strapi.service = jest.fn(() => ({ sendSMS }));

    const known = await createOtpChallenge({}, "09123456789");
    const unknown = await createOtpChallenge({}, "09111234567");

    expect(known).toMatch(/^[^.]+\.[A-Za-z0-9_-]+$/);
    expect(unknown).toMatch(/^[^.]+\.[A-Za-z0-9_-]+$/);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(sendSMS).toHaveBeenCalledTimes(2);
  });

  test("provider failure deletes the challenge and releases the phone lease", async () => {
    const sendSMS = jest.fn().mockResolvedValue(false);
    (global as any).strapi.service = jest.fn(() => ({ sendSMS }));

    await expect(createOtpChallenge({}, "09123456789")).rejects.toMatchObject({
      status: 502,
      code: "OTP_SEND_FAILED",
    });
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  test("Redis failure is closed before lookup or provider delivery", async () => {
    redis.set.mockRejectedValueOnce(new Error("redis unavailable"));
    const query = jest.fn();
    const service = jest.fn();
    (global as any).strapi.query = query;
    (global as any).strapi.service = service;

    await expect(createOtpChallenge({}, "09123456789")).rejects.toMatchObject({
      status: 503,
      code: "OTP_PHONE_COOLDOWN_UNAVAILABLE",
    });
    expect(query).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
  });

  test("missing HMAC key material fails closed before lookup or delivery", async () => {
    delete process.env.APP_KEYS;
    const query = jest.fn();
    const service = jest.fn();
    (global as any).strapi.query = query;
    (global as any).strapi.service = service;

    await expect(createOtpChallenge({}, "09123456789")).rejects.toMatchObject({
      status: 503,
      code: "OTP_PHONE_COOLDOWN_UNAVAILABLE",
    });
    expect(query).not.toHaveBeenCalled();
    expect(service).not.toHaveBeenCalled();
  });

  test("provider failure releases the phone for an immediate retry", async () => {
    let cooldownOwner: string | undefined;
    redis.set.mockImplementation(async (key: string, value: string) => {
      if (!key.startsWith("auth:otp-phone-cooldown:")) return "OK";
      if (cooldownOwner) return null;
      cooldownOwner = value;
      return "OK";
    });
    redis.eval.mockImplementation(async (_script: string, input: any) => {
      if (input.arguments[0] !== cooldownOwner) return 0;
      cooldownOwner = undefined;
      return 1;
    });
    const sendSMS = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(200);
    (global as any).strapi.service = jest.fn(() => ({ sendSMS }));

    await expect(createOtpChallenge({}, "09123456789")).rejects.toMatchObject({
      status: 502,
    });
    await expect(createOtpChallenge({}, "09123456789")).resolves.toMatch(/^[^.]+\.[A-Za-z0-9_-]+$/);
    expect(sendSMS).toHaveBeenCalledTimes(2);
  });

  test("timing logs contain fixed metadata but no raw identifiers", async () => {
    await createOtpChallenge({ get: () => "00000000-0000-4000-8000-000000000004" }, "09123456789");
    const serialized = JSON.stringify((global as any).strapi.log.info.mock.calls);
    expect(serialized).toContain("00000000-0000-4000-8000-000000000004");
    expect(serialized).toContain("sms_provider");
    expect(serialized).not.toContain("09123456789");
    expect(serialized).not.toContain("+989123456789");
  });

  test("PII-shaped inbound request IDs are not accepted into timing logs", async () => {
    await createOtpChallenge({ get: () => "09123456789" }, "09123456789");
    const serialized = JSON.stringify((global as any).strapi.log.info.mock.calls);
    expect(serialized).not.toContain("09123456789");
    expect(serialized).toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
  });
});
