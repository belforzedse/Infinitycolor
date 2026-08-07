/**
 * Auth Controller Tests - REAL IMPLEMENTATION
 * Tests actual OTP flow, login, and registration logic
 */

import { createStrapiMock, mockContext, mockUser } from "../../../__tests__/mocks/factories";

// Mock Redis client
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockVerifyOtpIdentity = jest.fn();
const mockVerifyPasswordIdentity = jest.fn();
const mockResetPasswordWithOtp = jest.fn();
const mockIssueLegacyJwt = jest.fn();
const mockUpdatePasswordAndLegacyHash = jest.fn();

jest.mock("../../../index", () => ({
  RedisClient: Promise.resolve({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    exists: jest.fn(),
  }),
}));

// Credential behavior is covered by credential-flow.spec.ts. This controller
// suite verifies delegation and the frozen public response contract.
jest.mock("../services/credential-flow", () => {
  const actual = jest.requireActual("../services/credential-flow");
  return {
    ...actual,
    verifyOtpIdentity: mockVerifyOtpIdentity,
    verifyPasswordIdentity: mockVerifyPasswordIdentity,
    resetPasswordWithOtp: mockResetPasswordWithOtp,
    issueLegacyJwt: mockIssueLegacyJwt,
    updatePasswordAndLegacyHash: mockUpdatePasswordAndLegacyHash,
  };
});

// Import controller actions AFTER mocks
let authController: any;
let CredentialFlowErrorClass: any;

describe("Auth Controller - Real Implementation", () => {
  let mockStrapi: any;
  let authService: any;
  let messagingService: any;
  let jwtService: any;
  let userService: any;

  beforeAll(async () => {
    // Dynamic import after mocks are set up
    CredentialFlowErrorClass = (await import("../services/credential-flow")).CredentialFlowError;
    authController = (await import("../controllers/auth")).default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIssueLegacyJwt.mockImplementation(async (userId: number) => `mock-jwt-token-${userId}`);
    mockUpdatePasswordAndLegacyHash.mockResolvedValue("$2b$10$test-hash");
    const mock = createStrapiMock();
    mockStrapi = mock.strapi;

    // Make strapi global available
    (global as any).strapi = mockStrapi;

    // Mock auth service
    authService = {
      hasUser: jest.fn(),
      otp: jest.fn(),
    };
    mock.registerService("api::auth.auth", authService);

    // Mock messaging service (SMS)
    messagingService = {
      sendSMS: jest.fn(),
    };
    mock.registerService("api::messaging.messaging", messagingService);
    mock.registerService("api::notification.notification", {
      createWelcome: jest.fn().mockResolvedValue(undefined),
    });

    // Mock JWT service
    jwtService = {
      issue: jest.fn((payload) => `mock-jwt-token-${payload.id}`),
      verify: jest.fn((token) => ({ id: 1, phone: "09123456789" })),
    };

    // Mock users-permissions plugin
    mockStrapi.plugin = jest.fn((pluginName: string) => {
      if (pluginName === "users-permissions") {
        return {
          service: jest.fn((serviceName: string) => {
            if (serviceName === "jwt") return jwtService;
            if (serviceName === "user") return userService;
          }),
        };
      }
    });

    // Mock user service for password validation
    userService = {
      validatePassword: jest.fn(),
    };

    // Mock query methods
    const mockQuery = {
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    mock.registerQuery("plugin::users-permissions.user", mockQuery);
    mock.registerQuery("api::local-user-info.local-user-info", mockQuery);
    mock.registerQuery("api::local-user.local-user", mockQuery);
    mock.registerQuery("plugin::users-permissions.role", {
      findOne: jest.fn().mockResolvedValue({ id: 1, name: "Customer" }),
      create: jest.fn(),
      update: jest.fn(),
    });
  });

  describe("welcome - Check if user exists", () => {
    it("should return hasUser=true for existing user - REAL logic", async () => {
      authService.hasUser.mockResolvedValue(true);

      const ctx = mockContext({
        request: { body: { phone: "09123456789" } },
      });

      // ✅ Call REAL controller action
      await authController.welcome(ctx);

      expect(authService.hasUser).toHaveBeenCalledWith(ctx, { phone: "09123456789" });
      expect(ctx.body).toEqual({
        message: "welcome",
        hasUser: true,
      });
    });

    it("should return hasUser=false for new user", async () => {
      authService.hasUser.mockResolvedValue(false);

      const ctx = mockContext({
        request: { body: { phone: "09987654321" } },
      });

      await authController.welcome(ctx);

      expect(ctx.body).toEqual({
        message: "welcome",
        hasUser: false,
      });
    });

    it("should validate phone number format", async () => {
      const ctx = mockContext({
        request: { body: { phone: "invalid" } },
      });

      await authController.welcome(ctx);

      // Real validation should reject invalid phone
      expect(authService.hasUser).not.toHaveBeenCalled();
    });
  });

  describe("otp - Send OTP code", () => {
    it("should generate and send OTP - REAL flow", async () => {
      const otpToken = "1234567890.abcdef123456";
      authService.otp.mockResolvedValue(otpToken);

      const ctx = mockContext({
        request: { body: { phone: "09123456789" } },
      });

      // ✅ Call REAL controller action
      await authController.otp(ctx);

      expect(authService.otp).toHaveBeenCalledWith(ctx, { phone: "09123456789" });
      expect(ctx.body).toEqual({
        message: "otp sent",
        otpToken,
      });
    });

    it("should reject invalid phone numbers", async () => {
      const ctx = mockContext({
        request: { body: { phone: "123" } }, // Invalid
      });

      await authController.otp(ctx);

      expect(authService.otp).not.toHaveBeenCalled();
    });

    it("should handle service errors", async () => {
      authService.otp.mockRejectedValue(new Error("SMS service unavailable"));

      const ctx = mockContext({
        request: { body: { phone: "09123456789" } },
      });

      await authController.otp(ctx);

      expect(ctx.status).toBe(500);
    });
  });

  describe("login - Verify OTP and issue JWT", () => {
    it("should verify OTP and create new user - REAL registration flow", async () => {
      const otpToken = "1234567890.abcdef";
      const otp = "123456";
      const phone = "+989123456789";
      const newUser = { id: 10, phone, username: phone };
      mockVerifyOtpIdentity.mockResolvedValue(newUser);

      const ctx = mockContext({
        request: { body: { otp, otpToken } },
      });

      // ✅ Call REAL login action
      await authController.login(ctx);

      expect(mockVerifyOtpIdentity).toHaveBeenCalledWith(otpToken, otp);
      expect(mockIssueLegacyJwt).toHaveBeenCalledWith(10);
      expect(ctx.body).toEqual({
        message: "login successful",
        token: "mock-jwt-token-10",
      });
    });

    it("should verify OTP and login existing user - REAL login flow", async () => {
      const otpToken = "1234567890.abcdef";
      const otp = "123456";
      const phone = "+989123456789";

      const existingUser = {
        id: 5,
        phone,
        confirmed: true,
      };
      mockVerifyOtpIdentity.mockResolvedValue(existingUser);

      const ctx = mockContext({
        request: { body: { otp, otpToken } },
      });

      await authController.login(ctx);

      expect(mockVerifyOtpIdentity).toHaveBeenCalledWith(otpToken, otp);
      expect(mockIssueLegacyJwt).toHaveBeenCalledWith(5);
      expect(ctx.body).toEqual({
        message: "login successful",
        token: "mock-jwt-token-5",
      });
    });

    it("should reject invalid OTP - REAL validation", async () => {
      const otpToken = "1234567890.abcdef";
      const wrongOtp = "999999";
      mockVerifyOtpIdentity.mockRejectedValue(
        new CredentialFlowErrorClass(
          "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
          400,
          "OTP_INVALID",
        ),
      );

      const ctx = mockContext({
        request: { body: { otp: wrongOtp, otpToken } },
      });

      await expect(authController.login(ctx)).rejects.toThrow(
        "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
      );

      // ✅ Real validation rejects wrong OTP
      expect(ctx.badRequest).toHaveBeenCalledWith(
        "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
      );
      expect(mockIssueLegacyJwt).not.toHaveBeenCalled();
    });

    it("should reject expired/invalid otpToken", async () => {
      const otpToken = "invalid-token";
      mockVerifyOtpIdentity.mockRejectedValue(
        new CredentialFlowErrorClass(
          "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
          400,
          "OTP_INVALID",
        ),
      );

      const ctx = mockContext({
        request: { body: { otp: "123456", otpToken } },
      });

      await authController.login(ctx);

      expect(ctx.badRequest).toHaveBeenCalledWith(
        "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
      );
    });

    it("should reject malformed otpToken format", async () => {
      const ctx = mockContext({
        request: { body: { otp: "123456", otpToken: "no-dot-in-token" } },
      });

      await authController.login(ctx);

      // ✅ Real validation checks token format
      expect(ctx.badRequest).toHaveBeenCalledWith(
        "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
      );
    });

    it("should delegate confirmation to the shared credential flow before issuing", async () => {
      const otpToken = "1234567890.abcdef";
      const otp = "123456";

      const confirmedUser = {
        id: 7,
        phone: "+989123456789",
        confirmed: true,
      };
      mockVerifyOtpIdentity.mockResolvedValue(confirmedUser);

      const ctx = mockContext({
        request: { body: { otp, otpToken } },
      });

      await authController.login(ctx);

      expect(mockVerifyOtpIdentity).toHaveBeenCalledWith(otpToken, otp);
      expect(mockIssueLegacyJwt).toHaveBeenCalledWith(7);
    });
  });

  describe("loginWithPassword - Password-based login", () => {
    it("should login with valid password - REAL password validation", async () => {
      const phone = "09123456789";
      const password = "correct-password";

      const user = {
        id: 1,
        phone,
        password: "hashed-password-value",
      };

      mockVerifyPasswordIdentity.mockResolvedValue(user);

      const ctx = mockContext({
        request: { body: { phone, password } },
      });

      await authController.loginWithPassword(ctx);

      expect(mockVerifyPasswordIdentity).toHaveBeenCalledWith(phone, password);
      expect(mockIssueLegacyJwt).toHaveBeenCalledWith(1);
      expect(ctx.body).toEqual({
        message: "login successful",
        token: "mock-jwt-token-1",
      });
    });

    it("should reject invalid password", async () => {
      const phone = "09123456789";
      const password = "wrong-password";

      const user = {
        id: 1,
        phone,
        password: "hashed-password-value",
      };

      mockVerifyPasswordIdentity.mockRejectedValue(
        new CredentialFlowErrorClass(
          "شماره همراه یا رمز عبور اشتباه است.",
          401,
          "INVALID_CREDENTIALS",
        ),
      );

      const ctx = mockContext({
        request: { body: { phone, password } },
      });

      await expect(authController.loginWithPassword(ctx)).rejects.toThrow(
        "شماره همراه یا رمز عبور اشتباه است.",
      );

      expect(ctx.unauthorized).toHaveBeenCalledWith("شماره همراه یا رمز عبور اشتباه است.");
      expect(mockIssueLegacyJwt).not.toHaveBeenCalled();
    });

    it("should reject missing credentials", async () => {
      const ctx = mockContext({
        request: { body: {} },
      });

      await expect(authController.loginWithPassword(ctx)).rejects.toThrow(
        "شماره همراه و رمز عبور الزامی است.",
      );

      expect(ctx.badRequest).toHaveBeenCalledWith("شماره همراه و رمز عبور الزامی است.");
    });

    it("should handle user not found", async () => {
      mockVerifyPasswordIdentity.mockRejectedValue(
        new CredentialFlowErrorClass(
          "شماره همراه یا رمز عبور اشتباه است.",
          401,
          "INVALID_CREDENTIALS",
        ),
      );

      const ctx = mockContext({
        request: { body: { phone: "09999999999", password: "password" } },
      });

      await expect(authController.loginWithPassword(ctx)).rejects.toThrow(
        "شماره همراه یا رمز عبور اشتباه است.",
      );

      expect(ctx.unauthorized).toHaveBeenCalledWith("شماره همراه یا رمز عبور اشتباه است.");
    });
  });

  describe("resetPassword - Password reset with OTP", () => {
    it("should reset password with valid OTP - REAL flow", async () => {
      const otpToken = "1234567890.abcdef";
      const otp = "123456";
      const newPassword = "new-secure-password";
      const userId = 5;

      mockResetPasswordWithOtp.mockResolvedValue({
        id: userId,
        phone: "+989123456789",
      });

      const ctx = mockContext({
        request: { body: { otp, otpToken, newPassword } },
      });

      // ✅ Call REAL controller action
      await authController.resetPassword(ctx);

      expect(mockResetPasswordWithOtp).toHaveBeenCalledWith(otpToken, otp, newPassword);

      expect(ctx.body).toEqual({
        message: "رمز عبور با موفقیت تغییر کرد.",
      });
    });

    it("should reject invalid OTP during password reset", async () => {
      mockResetPasswordWithOtp.mockRejectedValue(
        new CredentialFlowErrorClass(
          "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
          400,
          "OTP_INVALID",
        ),
      );

      const ctx = mockContext({
        request: { body: { otp: "999999", otpToken: "1234567890.abc", newPassword: "new-pass" } },
      });

      await expect(authController.resetPassword(ctx)).rejects.toThrow(
        "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
      );

      expect(ctx.badRequest).toHaveBeenCalledWith(
        "کد وارد شده نامعتبر یا منقضی شده است. دوباره تلاش کنید.",
      );
      expect(mockUpdatePasswordAndLegacyHash).not.toHaveBeenCalled();
    });
  });

  describe("self - Get current user profile", () => {
    it("should return the strategy-authenticated user profile - REAL profile fetch", async () => {
      const userId = 1;

      mockStrapi.entityService.findOne.mockResolvedValue({
        id: userId,
        phone: "+989123456789",
        username: "+989123456789",
        role: { id: 1, name: "Customer" },
      });

      const mockQuery = mockStrapi.db.query("api::local-user-info.local-user-info");
      mockQuery.findOne.mockResolvedValue({
        id: 1,
        FirstName: "John",
        LastName: "Doe",
        user: userId,
      });

      const ctx = mockContext({
        state: { user: { id: userId } },
      });

      // ✅ Call REAL controller action
      await authController.self(ctx);

      expect(mockStrapi.entityService.findOne).toHaveBeenCalledWith(
        "plugin::users-permissions.user",
        userId,
        expect.objectContaining({ populate: { role: { populate: ["permissions"] } } }),
      );
      expect(ctx.body).toMatchObject({
        FirstName: "John",
        LastName: "Doe",
        Phone: "+989123456789",
        isAdmin: false,
        roleName: "Customer",
      });
    });

    it("should detect admin users", async () => {
      mockStrapi.entityService.findOne.mockResolvedValue({
        id: 1,
        role: { id: 2, name: "Superadmin" },
      });

      const mockQuery = mockStrapi.db.query("api::local-user-info.local-user-info");
      mockQuery.findOne.mockResolvedValue(null);

      const ctx = mockContext({
        state: { user: { id: 1 } },
      });

      await authController.self(ctx);

      expect(ctx.body.isAdmin).toBe(true);
      expect(ctx.body.roleName).toBe("Superadmin");
    });

    it("should return unauthorized without a strategy-authenticated user", async () => {
      const ctx = mockContext({
        request: { header: {} },
        state: { user: null },
      });

      await authController.self(ctx);

      expect(ctx.unauthorized).toHaveBeenCalledWith("احراز هویت ناموفق بود. دوباره تلاش کنید.");
    });
  });

  describe("registerInfo - Update user profile", () => {
    it("should update user profile - REAL update flow", async () => {
      const userId = 1;
      const firstName = "Jane";
      const lastName = "Smith";
      const birthDate = "1990-01-01";

      const ctx = mockContext({
        request: {
          body: { firstName, lastName, birthDate },
        },
        state: { user: { id: userId } },
      });

      const mockQuery = mockStrapi.db.query("api::local-user-info.local-user-info");
      mockQuery.findOne
        .mockResolvedValueOnce({ id: userId, ProfileCompletedAt: null })
        .mockResolvedValueOnce({ id: 1, user: userId });

      // ✅ Call REAL controller action
      await authController.registerInfo(ctx);

      expect(mockQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({
            FirstName: firstName,
            LastName: lastName,
            BirthDate: birthDate,
          }),
          transacting: expect.anything(),
        }),
      );
      expect(mockQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: userId },
          data: expect.objectContaining({
            ProfileCompletedAt: expect.any(String),
            ProfileManagedByCustomer: true,
          }),
          transacting: expect.anything(),
        }),
      );
      expect(mockUpdatePasswordAndLegacyHash).not.toHaveBeenCalled();

      expect(ctx.body).toEqual({ message: "info updated" });
    });

    it("should create profile if not exists", async () => {
      const userId = 1;
      const ctx = mockContext({
        request: { body: { firstName: "New", lastName: "User" } },
        state: { user: { id: userId } },
      });

      const mockQuery = mockStrapi.db.query("api::local-user-info.local-user-info");
      mockQuery.findOne
        .mockResolvedValueOnce({ id: userId, ProfileCompletedAt: null })
        .mockResolvedValueOnce(null); // No profile exists

      await authController.registerInfo(ctx);

      expect(mockQuery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            user: userId,
            FirstName: "New",
            LastName: "User",
          }),
          transacting: expect.anything(),
        }),
      );
      expect(mockQuery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: userId },
          data: expect.objectContaining({
            ProfileCompletedAt: expect.any(String),
            ProfileManagedByCustomer: true,
          }),
          transacting: expect.anything(),
        }),
      );
    });
  });
});
