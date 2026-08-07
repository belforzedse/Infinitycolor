import {
  canonicalIranPhone,
  MigrationInputError,
  normalizedEmail,
  reconcileCustomerIdentity,
} from "../services/customer-identity";

function identityHarness(seedUsers: any[] = []) {
  const users = seedUsers.map((user) => ({ ...user }));
  const infos: any[] = [];
  const mappings = new Map<string, number>();
  let nextUserId = Math.max(0, ...users.map((user) => Number(user.id))) + 1;
  const trx = {
    raw: jest.fn(async (sql: string, bindings: any[] = []) => {
      if (sql.includes("SELECT user_id")) {
        const key = `${bindings[0]}:${bindings[1]}`;
        const userId = mappings.get(key);
        return { rows: userId ? [{ user_id: userId }] : [] };
      }
      if (sql.includes("INSERT INTO customer_identity_mappings")) {
        const key = `${bindings[0]}:${bindings[1]}`;
        const userId = Number(bindings[2]);
        const existing = mappings.get(key);
        if (existing && existing !== userId) return { rows: [] };
        mappings.set(key, userId);
        return { rows: [{ user_id: userId }] };
      }
      return { rows: [] };
    }),
  };
  const matches = (row: any, where: any) => {
    if (where.id !== undefined) return Number(row.id) === Number(where.id);
    if (where.external_source) {
      return row.external_source === where.external_source && String(row.external_id) === String(where.external_id);
    }
    if (where.phone?.$in) return where.phone.$in.includes(row.phone);
    if (where.email?.$eqi) return String(row.email || "").toLowerCase() === String(where.email.$eqi).toLowerCase();
    return false;
  };
  const userQuery = {
    findMany: jest.fn(async ({ where }: any) => users.filter((user) => matches(user, where)).slice(0, 2)),
    create: jest.fn(async ({ data }: any) => {
      const user = { id: nextUserId++, ...data };
      users.push(user);
      return user;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const user = users.find((candidate) => Number(candidate.id) === Number(where.id));
      Object.assign(user, data);
      return user;
    }),
  };
  const infoQuery = {
    findMany: jest.fn(async ({ where }: any) => infos.filter((info) => Number(info.user) === Number(where.user))),
    create: jest.fn(async ({ data }: any) => {
      const info = { id: infos.length + 1, ...data };
      infos.push(info);
      return info;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const info = infos.find((candidate) => Number(candidate.id) === Number(where.id));
      Object.assign(info, data);
      return info;
    }),
  };
  const strapiMock = {
    db: {
      query: jest.fn((uid: string) => {
        if (uid === "plugin::users-permissions.user") return userQuery;
        if (uid === "plugin::users-permissions.role") {
          return { findMany: jest.fn().mockResolvedValue([{ id: 3, type: "customer" }]) };
        }
        return infoQuery;
      }),
    },
  };
  return { strapiMock, trx, users, infos, mappings };
}

describe("canonical Woo customer identity reconciliation", () => {
  test("normalizes Iranian phones and emails centrally", () => {
    expect(canonicalIranPhone("۰۹۱۲ ۳۴۵ ۶۷۸۹")).toBe("+989123456789");
    expect(canonicalIranPhone("0098 912 345 6789")).toBe("+989123456789");
    expect(canonicalIranPhone("invalid")).toBeNull();
    expect(normalizedEmail(" Buyer@Example.COM ")).toBe("buyer@example.com");
    expect(normalizedEmail("not-an-email")).toBeNull();
  });

  test("pre-provisions one unverified passwordless user for repeated guest orders", async () => {
    const harness = identityHarness();
    const input = {
      kind: "guest" as const,
      phone: "09123456789",
      email: "buyer@example.com",
      firstName: "نام",
      lastName: "خانوادگی",
    };
    const first = await reconcileCustomerIdentity(harness.strapiMock, input, harness.trx);
    const second = await reconcileCustomerIdentity(harness.strapiMock, input, harness.trx);

    expect(first.mode).toBe("created");
    expect(second.user.id).toBe(first.user.id);
    expect(harness.users).toHaveLength(1);
    expect(harness.users[0]).toEqual(expect.objectContaining({
      phone: "+989123456789",
      IsVerified: false,
      ClaimedAt: null,
      AccountOrigin: "WooGuest",
      ProfileManagedByCustomer: false,
    }));
    expect(harness.users[0]).not.toHaveProperty("password");
  });

  test("promotes a guest identity when a registered Woo customer id later appears", async () => {
    const harness = identityHarness();
    const guest = await reconcileCustomerIdentity(harness.strapiMock, {
      kind: "guest", phone: "09123456789", firstName: "نام", lastName: "خانوادگی",
    }, harness.trx);
    const registered = await reconcileCustomerIdentity(harness.strapiMock, {
      kind: "registered", sourceCustomerId: "77", phone: "09123456789",
      firstName: "نام", lastName: "خانوادگی",
    }, harness.trx);

    expect(registered.user.id).toBe(guest.user.id);
    expect(harness.users).toHaveLength(1);
    expect(harness.users[0]).toEqual(expect.objectContaining({
      external_source: "wordpress",
      external_id: "77",
      AccountOrigin: "WooRegistered",
    }));
  });

  test("does not overwrite a claimed customer profile from later Woo data", async () => {
    const harness = identityHarness([{
      id: 9,
      phone: "+989123456789",
      email: "customer@example.com",
      ClaimedAt: "2026-08-07T00:00:00.000Z",
      IsVerified: true,
      ProfileManagedByCustomer: true,
      AccountOrigin: "WooGuest",
    }]);
    harness.infos.push({ id: 1, user: 9, FirstName: "Customer", LastName: "Chosen" });

    await reconcileCustomerIdentity(harness.strapiMock, {
      kind: "guest", phone: "09123456789", email: "old@example.com",
      firstName: "Source", lastName: "Value",
    }, harness.trx);

    expect(harness.infos[0]).toEqual(expect.objectContaining({ FirstName: "Customer", LastName: "Chosen" }));
    expect(harness.users[0].email).toBe("customer@example.com");
  });

  test("fails closed on duplicate destination phone identities", async () => {
    const harness = identityHarness([
      { id: 1, phone: "+989123456789" },
      { id: 2, phone: "09123456789" },
    ]);
    await expect(reconcileCustomerIdentity(harness.strapiMock, {
      kind: "guest", phone: "09123456789",
    }, harness.trx)).rejects.toEqual(expect.objectContaining<Partial<MigrationInputError>>({
      code: "USER_PHONE_AMBIGUOUS",
      status: 409,
    }));
    expect(harness.users).toHaveLength(2);
  });

  test("keeps a guest order unowned when no claimable phone exists", async () => {
    const harness = identityHarness();
    await expect(reconcileCustomerIdentity(harness.strapiMock, {
      kind: "guest", phone: "invalid", email: "buyer@example.com",
    }, harness.trx)).resolves.toEqual({
      user: null,
      mode: "unresolved",
      matchReason: "guest-phone-invalid",
      issues: [],
    });
    expect(harness.users).toHaveLength(0);
  });
});
