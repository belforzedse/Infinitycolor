import {
  CUSTOMER_CAPABLE_ROLES,
  ROLE_NAMES,
  STORE_MANAGER_PLUS_ROLES,
  normalizeRoleName,
  resolveCustomerTargetUserId,
  roleIsAllowed,
} from "../roles";

describe("role hierarchy helpers", () => {
  it("normalizes founder and store-manager aliases", () => {
    expect(normalizeRoleName("founders")).toBe(ROLE_NAMES.FOUNDER);
    expect(normalizeRoleName("store-manager")).toBe(ROLE_NAMES.STORE_MANAGER);
    expect(normalizeRoleName("Store manager")).toBe(ROLE_NAMES.STORE_MANAGER);
  });

  it("defines customer and manager-plus role groups", () => {
    expect(CUSTOMER_CAPABLE_ROLES).toEqual([
      ROLE_NAMES.CUSTOMER,
      ROLE_NAMES.STORE_MANAGER,
      ROLE_NAMES.FOUNDER,
      ROLE_NAMES.SUPERADMIN,
    ]);
    expect(STORE_MANAGER_PLUS_ROLES).toEqual([
      ROLE_NAMES.STORE_MANAGER,
      ROLE_NAMES.FOUNDER,
      ROLE_NAMES.SUPERADMIN,
    ]);
    expect(roleIsAllowed("Founder", STORE_MANAGER_PLUS_ROLES)).toBe(true);
    expect(roleIsAllowed("Customer", STORE_MANAGER_PLUS_ROLES)).toBe(false);
  });

  it("keeps customers scoped to their own user id", async () => {
    const ctx: any = {
      state: { user: { id: 10, role: { name: ROLE_NAMES.CUSTOMER } } },
      query: { userId: "20" },
      forbidden: jest.fn((message: string, payload?: unknown) => {
        const error: any = new Error(message);
        error.status = 403;
        error.payload = payload;
        throw error;
      }),
    };

    const result = await resolveCustomerTargetUserId(ctx, {} as any);

    expect(result).toBeNull();
    expect(ctx.forbidden).toHaveBeenCalledWith(
      "You do not have permission to target another user",
      { data: { success: false, error: "TARGET_USER_FORBIDDEN" } },
    );
    expect(ctx.status).toBe(403);
  });

  it("allows manager-plus roles to target another customer explicitly", async () => {
    const ctx: any = {
      state: { user: { id: 10, role: { name: ROLE_NAMES.FOUNDER } } },
      request: { body: { targetUserId: 20 } },
    };

    await expect(resolveCustomerTargetUserId(ctx, {} as any)).resolves.toBe(20);
  });
});
