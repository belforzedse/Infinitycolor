import { readFileSync } from "node:fs";
import path from "node:path";
import { RedisClient } from "../../../index";
import {
  assertUserMayStartSession,
  OTP_INVALID_MESSAGE,
  consumeOtpChallenge,
  isAcceptedPhone,
  normalizeOtpPhone,
} from "../services/credential-flow";

describe("shared Strapi credential flow", () => {
  test.each(["09123456789", "+989123456789"])("accepts the frozen ASCII phone form %s", (phone) => {
    expect(isAcceptedPhone(phone)).toBe(true);
  });

  test.each(["9123456789", "00989123456789", "۰۹۱۲۳۴۵۶۷۸۹", "+۹۸۹۱۲۳۴۵۶۷۸۹"])(
    "rejects an unsupported phone form %s",
    (phone) => expect(isAcceptedPhone(phone)).toBe(false),
  );

  test("keeps the existing +98 normalization behavior", () => {
    expect(normalizeOtpPhone("09123456789")).toBe("+989123456789");
    expect(normalizeOtpPhone("+989123456789")).toBe("+989123456789");
  });

  test("accepts only an atomically consumed six-digit challenge", async () => {
    ((await RedisClient).eval as jest.Mock) = jest
      .fn()
      .mockResolvedValueOnce([
        "OK",
        JSON.stringify({ code: "012345", phone: "+989123456789", attempts: 0 }),
      ])
      .mockResolvedValueOnce(["MISSING"]);

    await expect(consumeOtpChallenge("challenge.value", "012345")).resolves.toEqual(
      expect.objectContaining({ code: "012345", phone: "+989123456789" }),
    );
    await expect(consumeOtpChallenge("challenge.value", "012345")).rejects.toThrow(
      OTP_INVALID_MESSAGE,
    );
    await expect(consumeOtpChallenge("challenge.value", "12345")).rejects.toThrow(
      OTP_INVALID_MESSAGE,
    );
  });

  test("production credential generation does not use Math.random", () => {
    const source = readFileSync(path.resolve(__dirname, "../services/credential-flow.ts"), "utf8");
    expect(source).not.toContain("Math.random");
    expect(source).toMatch(/crypto\.randomInt\(/);
    expect(source).toMatch(/crypto\.randomBytes\(/);
    expect(source).toContain("redis.call('DEL', KEYS[1])");
  });

  test("rejects blocked and confirmation-required users before creating a BA session", async () => {
    const storeGet = jest.fn().mockResolvedValue({ email_confirmation: true });
    (global as any).strapi.store = jest.fn(() => ({ get: storeGet }));

    await expect(
      assertUserMayStartSession({ id: 4, blocked: true, confirmed: true }),
    ).rejects.toMatchObject({ code: "USER_BLOCKED", status: 401 });
    await expect(
      assertUserMayStartSession({ id: 5, blocked: false, confirmed: false }),
    ).rejects.toMatchObject({ code: "USER_UNCONFIRMED", status: 401 });
    await expect(
      assertUserMayStartSession({ id: 6, blocked: false, confirmed: true }),
    ).resolves.toBeUndefined();
  });
});
