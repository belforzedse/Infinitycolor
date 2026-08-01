import bcrypt from "bcryptjs";
import extendUsersPermissions, {
  __usersPermissionsExtensionTestUtils,
} from "../../../extensions/users-permissions/strapi-server";

function pluginWithRegister(
  register: jest.Mock,
  userServiceFactory: jest.Mock = jest.fn(() => ({
    add: jest.fn(),
    edit: jest.fn(),
  })),
) {
  return {
    register: jest.fn(),
    controllers: {
      auth: { register },
      user: {
        create: jest.fn(),
        update: jest.fn(),
      },
    },
    services: { user: userServiceFactory },
  };
}

describe("Infinity Users & Permissions creation guards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).strapi.store = jest.fn(() => ({
      get: jest.fn().mockResolvedValue({ email_confirmation: false }),
    }));
    (global as any).strapi.query = jest.fn((uid: string) => {
      if (uid === "api::local-user-info.local-user-info") {
        return { findOne: jest.fn().mockResolvedValue(null) };
      }
      return { delete: jest.fn().mockResolvedValue({}) };
    });
    (global as any).strapi.entityService.create = jest.fn().mockResolvedValue({ id: 11 });
  });

  it("rejects a native signup before user creation when either name is blank", async () => {
    const register = jest.fn();
    const plugin = extendUsersPermissions(pluginWithRegister(register));
    const ctx: any = {
      request: {
        body: {
          email: "user@example.test",
          username: "user",
          password: "secret123",
          phone: "09123456789",
          firstName: " ",
          lastName: "User",
        },
      },
    };

    await plugin.controllers.auth.register(ctx);

    expect(ctx.status).toBe(400);
    expect(ctx.body).toEqual({ message: "نام الزامی است" });
    expect(register).not.toHaveBeenCalled();
  });

  it("creates the required profile before native registration responds", async () => {
    const register = jest.fn(async (ctx: any) => {
      expect(ctx.request.body).not.toHaveProperty("firstName");
      expect(ctx.request.body).not.toHaveProperty("lastName");
      expect(ctx.request.body.password).toBe("secret123");
      ctx.body = { user: { id: 7 } };
    });
    const plugin = extendUsersPermissions(pluginWithRegister(register));
    const ctx: any = {
      request: {
        body: {
          email: "user@example.test",
          username: "user",
          password: "secret123",
          phone: "09123456789",
          firstName: " Nima ",
          lastName: " Ahmadi ",
          birthDate: "2000-01-02",
        },
      },
    };

    await plugin.controllers.auth.register(ctx);

    expect((global as any).strapi.entityService.create).toHaveBeenCalledWith(
      "api::local-user-info.local-user-info",
      {
        data: {
          user: 7,
          FirstName: "Nima",
          LastName: "Ahmadi",
          BirthDate: "2000-01-02",
        },
      },
    );
  });

  it("hashes every Users & Permissions service password write", async () => {
    const add = jest.fn(async (values) => values);
    const edit = jest.fn(async (_id, values) => values);
    const factory = jest.fn(() => ({ add, edit }));
    const plugin = extendUsersPermissions(pluginWithRegister(jest.fn(), factory));
    const service = plugin.services.user({ strapi: (global as any).strapi });

    await service.add({ email: "user@example.test", password: "add-secret" });
    await service.edit(7, { password: "edit-secret" });

    expect(await bcrypt.compare("add-secret", add.mock.calls[0][0].password)).toBe(true);
    expect(await bcrypt.compare("edit-secret", edit.mock.calls[0][1].password)).toBe(true);
  });

  it("vetoes a legacy JWT on domain APIs until both profile names exist", async () => {
    const getToken = jest.fn().mockResolvedValue({ id: 7 });
    const fetchAuthenticatedUser = jest.fn().mockResolvedValue({
      id: 7,
      blocked: false,
      confirmed: true,
      role: { id: 2, name: "Customer" },
    });
    (global as any).strapi.plugin = jest.fn(() => ({
      service: (name: string) => (name === "jwt" ? { getToken } : { fetchAuthenticatedUser }),
    }));
    (global as any).strapi.db.query = jest.fn(() => ({
      findOne: jest.fn().mockResolvedValue({
        FirstName: "Nima",
        LastName: " ",
      }),
    }));

    await expect(
      __usersPermissionsExtensionTestUtils.legacyProfileGuardStrategy.authenticate({
        request: { path: "/api/orders" },
      }),
    ).resolves.toEqual({ error: "Profile completion required" });

    await expect(
      __usersPermissionsExtensionTestUtils.legacyProfileGuardStrategy.authenticate({
        request: { path: "/api/auth/register-info" },
      }),
    ).resolves.toEqual({ authenticated: false });
  });

  it("registers the incomplete-profile veto before the native strategy", async () => {
    const plugin = pluginWithRegister(jest.fn());
    plugin.register = jest.fn(async ({ strapi }: any) => {
      strapi.container.get("auth").register("content-api", {
        name: "users-permissions",
      });
    });
    const extended = extendUsersPermissions(plugin);
    const registrations: string[] = [];
    const registry = {
      register: jest.fn((_type: string, strategy: { name: string }) => {
        registrations.push(strategy.name);
      }),
    };

    await extended.register({
      strapi: {
        container: { get: jest.fn(() => registry) },
      },
    });

    expect(registrations).toEqual(["infinity-legacy-profile-guard", "users-permissions"]);
  });
});
