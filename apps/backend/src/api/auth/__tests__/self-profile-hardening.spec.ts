const recordAdminAuditMock = jest.fn().mockResolvedValue(true);

jest.mock("../../../utils/adminAudit", () => ({
  recordAdminAudit: (...args: unknown[]) => recordAdminAuditMock(...args),
}));

import authController from "../controllers/auth";

describe("auth/self profile write allowlist", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).strapi = {
      log: { error: jest.fn() },
      db: {
        query: jest.fn(() => ({
          findOne: jest.fn().mockResolvedValue({
            id: 10,
            FirstName: "Nima",
            LastName: "Ahmadi",
          }),
        })),
      },
      entityService: {
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findOne: jest.fn().mockResolvedValue({
          id: 7,
          phone: "+989121234567",
          email: "strapi-7@identity.invalid",
          username: "+989121234567",
          role: { name: "Superadmin" },
        }),
      },
    };
  });

  it.each([
    "Phone",
    "phone",
    "role",
    "permissions",
    "blocked",
    "confirmed",
    "IsActive",
    "IsVerified",
    "email",
  ])("rejects the protected %s field without writing", async (field) => {
    const ctx: any = {
      state: { user: { id: 7 } },
      request: { body: { FirstName: "Nima", [field]: "crafted" } },
      unauthorized: jest.fn(),
    };

    await authController.updateSelf(ctx);

    expect(ctx.status).toBe(400);
    expect(ctx.body).toMatchObject({
      error: "PROFILE_FIELDS_NOT_ALLOWED",
      fields: [field],
    });
    expect((global as any).strapi.entityService.update).not.toHaveBeenCalled();
    expect(recordAdminAuditMock).toHaveBeenCalledWith(
      (global as any).strapi,
      expect.objectContaining({
        resourceId: 7,
        severity: "warning",
        metadata: { rejectedFields: [field] },
      }),
    );
  });

  it("updates only the documented profile fields and records field names", async () => {
    const ctx: any = {
      state: { user: { id: 7 } },
      request: {
        body: {
          FirstName: " Nima ",
          LastName: " Ahmadi ",
          NationalCode: "0012345678",
          BirthDate: "2000-01-02",
          Sex: true,
          Bio: "profile",
        },
      },
      unauthorized: jest.fn(),
    };

    await authController.updateSelf(ctx);

    expect((global as any).strapi.entityService.update).toHaveBeenCalledWith(
      "api::local-user-info.local-user-info",
      10,
      {
        data: {
          FirstName: "Nima",
          LastName: "Ahmadi",
          NationalCode: "0012345678",
          BirthDate: "2000-01-02",
          Sex: true,
          Bio: "profile",
        },
      },
    );
    expect(recordAdminAuditMock).toHaveBeenCalledWith(
      (global as any).strapi,
      expect.objectContaining({
        severity: "success",
        metadata: {
          fields: ["Bio", "BirthDate", "FirstName", "LastName", "NationalCode", "Sex"],
        },
      }),
    );
    expect(ctx.body).toMatchObject({
      isAdmin: true,
      roleName: "Superadmin",
      effectivePermissions: [],
    });
  });
});
