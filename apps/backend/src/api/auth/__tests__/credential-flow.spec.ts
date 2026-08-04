import { readFileSync } from "node:fs";
import path from "node:path";
import { RedisClient } from "../../../index";
import {
  assertUserMayStartSession,
  createOtpChallenge,
  hasUserForPhone,
  OTP_INVALID_MESSAGE,
  consumeOtpChallenge,
  isAcceptedPhone,
  normalizeOtpPhone,
  phoneStorageVariants,
  verifyOtpIdentityWithStatus,
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

  test.each(["09123456789", "+989123456789"])(
    "looks up both persisted forms for %s",
    async (phone) => {
      const findMany = jest.fn().mockResolvedValue([{ id: 17 }]);
      const originalQuery = (global as any).strapi.query;
      (global as any).strapi.query = jest.fn(() => ({ findMany }));

      try {
        expect(phoneStorageVariants(phone)).toEqual(["+989123456789", "09123456789"]);
        await expect(hasUserForPhone(phone)).resolves.toBe(true);
        expect(findMany).toHaveBeenCalledWith({
          where: {
            phone: { $in: ["+989123456789", "09123456789"] },
          },
          limit: 2,
        });
      } finally {
        (global as any).strapi.query = originalQuery;
      }
    },
  );

  test("refuses OTP when both persisted forms point at different users", async () => {
    const originalQuery = (global as any).strapi.query;
    (global as any).strapi.query = jest.fn(() => ({
      findMany: jest.fn().mockResolvedValue([{ id: 17 }, { id: 20 }]),
    }));

    try {
      await expect(createOtpChallenge({}, "09123456789")).rejects.toMatchObject({
        code: "PHONE_IDENTITY_AMBIGUOUS",
        status: 409,
      });
    } finally {
      (global as any).strapi.query = originalQuery;
    }
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

  test.each([
    {
      label: "existing",
      existingUser: { id: 17, confirmed: true },
      expectedIsNewUser: false,
    },
    {
      label: "new",
      existingUser: null,
      expectedIsNewUser: true,
    },
  ])(
    "reports the authoritative $label-user result after OTP verification",
    async ({ existingUser, expectedIsNewUser }) => {
      ((await RedisClient).eval as jest.Mock) = jest.fn().mockResolvedValue([
        "OK",
        JSON.stringify({
          code: "012345",
          phone: "+989123456789",
          ...(existingUser ? { merchant: existingUser.id } : {}),
          attempts: 0,
        }),
      ]);
      const createdUser = { id: 20, confirmed: true };
      const userQuery = {
        findMany: jest.fn().mockResolvedValue(existingUser ? [existingUser] : []),
      };
      const roleQuery = {
        findOne: jest.fn().mockResolvedValue({ id: 1, name: "Customer" }),
      };
      const userDbQuery = {
        create: jest.fn().mockResolvedValue(createdUser),
        update: jest.fn(),
      };
      const profileDbQuery = {
        create: jest.fn().mockResolvedValue({ id: 30 }),
      };
      const originalStrapi = (global as any).strapi;
      (global as any).strapi = {
        ...originalStrapi,
        query: jest.fn((uid: string) =>
          uid === "plugin::users-permissions.role" ? roleQuery : userQuery,
        ),
        db: {
          ...originalStrapi.db,
          connection: { client: { config: { client: "sqlite" } } },
          transaction: jest.fn(async (callback) => callback({ trx: {} })),
          query: jest.fn((uid: string) =>
            uid === "plugin::users-permissions.user" ? userDbQuery : profileDbQuery,
          ),
        },
      };

      try {
        const result = await verifyOtpIdentityWithStatus("challenge.value", "012345");
        expect(result).toEqual({
          user: existingUser ?? createdUser,
          isNewUser: expectedIsNewUser,
        });
      } finally {
        (global as any).strapi = originalStrapi;
      }
    },
  );

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
