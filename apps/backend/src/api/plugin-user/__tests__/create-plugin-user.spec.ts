import service from "../services/plugin-user";

function strapiStub() {
  const create = jest.fn(async (uid: string) => ({ id: uid === "plugin::users-permissions.user" ? 41 : 1 }));
  (global as any).strapi = {
    db: { transaction: jest.fn(async (work: (trx: unknown) => Promise<unknown>) => work({})) },
    query: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(null) })),
    entityService: { create },
    log: { error: jest.fn() },
  };
  return create;
}

const ctx = () => ({ badRequest: jest.fn(), conflict: jest.fn() }) as any;

const userCreateData = (create: jest.Mock) =>
  create.mock.calls.find(([uid]) => uid === "plugin::users-permissions.user")?.[1]?.data;

describe("creating a user from the admin", () => {
  it("marks the profile complete, since the admin entered the name", async () => {
    const create = strapiStub();

    await service.createPluginUser(ctx(), {
      userData: { phone: "09121234567", role: 3 },
      userInfoData: { FirstName: "سارا", LastName: "محمدی" },
    });

    expect(userCreateData(create)).toEqual(
      expect.objectContaining({ phone: "+989121234567", ProfileCompletedAt: expect.any(Date) }),
    );
  });

  it("leaves it incomplete when a name is missing", async () => {
    const create = strapiStub();

    await service.createPluginUser(ctx(), {
      userData: { phone: "09121234567", role: 3 },
      userInfoData: { FirstName: "سارا", LastName: null },
    });

    expect(userCreateData(create)).toEqual(expect.objectContaining({ ProfileCompletedAt: null }));
  });
});
