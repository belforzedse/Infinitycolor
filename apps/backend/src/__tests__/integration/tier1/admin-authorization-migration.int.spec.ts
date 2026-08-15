import { __rolePermissionTestUtils } from "../../../index";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
});

describe("admin authorization migration on isolated PostgreSQL", () => {
  it("consolidates the rollback-created Store Manager pair and synchronizes roles idempotently", async () => {
    const roleQuery = strapi.query("plugin::users-permissions.role");
    const userQuery = strapi.query("plugin::users-permissions.user");

    const superadmin =
      (await roleQuery.findOne({ where: { type: "superadmin" } })) ||
      (await roleQuery.create({
        data: {
          name: "Superadmin",
          type: "superadmin",
          description: "isolated migration superadmin",
        },
      }));
    const canonicalStoreManager = await roleQuery.create({
      data: {
        name: "Store Manager",
        type: "store-manager",
        description: "canonical manager role",
      },
    });
    const rollbackStoreManager = await roleQuery.create({
      data: {
        name: "Store manager",
        type: "store-manager",
        description: "role recreated by an old rollback",
      },
    });

    const superadminUser = await userQuery.create({
      data: {
        username: "+989000009901",
        email: "isolated.superadmin@infinitycolor.local",
        provider: "local",
        password: "$2b$10$ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
        confirmed: true,
        blocked: false,
        IsActive: true,
        role: superadmin.id,
      },
    });
    const managerUser = await userQuery.create({
      data: {
        username: "+989000009902",
        email: "isolated.manager@infinitycolor.local",
        provider: "local",
        password: "$2b$10$ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
        confirmed: true,
        blocked: false,
        IsActive: true,
        role: rollbackStoreManager.id,
      },
    });

    await __rolePermissionTestUtils.ensurePluginRolesAndPermissions(strapi);

    const migratedRoles = await roleQuery.findMany({ populate: ["permissions"] });
    const byType = new Map(migratedRoles.map((role: any) => [role.type, role]));
    expect([...byType.keys()]).toEqual(
      expect.arrayContaining([
        "editor",
        "seller-1",
        "seller-2",
        "store-manager",
        "store-manager-2",
        "finance",
        "founder",
        "superadmin",
        "customer",
      ]),
    );

    const migratedStoreManager = byType.get("store-manager") as any;
    expect(migratedStoreManager).toEqual(
      expect.objectContaining({
        id: canonicalStoreManager.id,
        name: "Store Manager",
        type: "store-manager",
      }),
    );
    expect(migratedStoreManager.permissions.length).toBeGreaterThan(0);
    expect(migratedRoles.find((role: any) => role.id === rollbackStoreManager.id)).toBeUndefined();

    const assignments = await userQuery.findMany({
      where: { id: { $in: [superadminUser.id, managerUser.id] } },
      populate: { role: { select: ["id", "name", "type"] } },
    });
    const assignmentById = new Map(assignments.map((user: any) => [user.id, user.role]));
    expect(assignmentById.get(superadminUser.id)).toEqual(
      expect.objectContaining({ id: superadmin.id, type: "superadmin" }),
    );
    expect(assignmentById.get(managerUser.id)).toEqual(
      expect.objectContaining({ id: canonicalStoreManager.id, name: "Store Manager" }),
    );

    const authorizationStore = strapi.store({ type: "core", name: "admin-authorization" });
    const initialSnapshot = await authorizationStore.get({
      key: "admin-capability-v1-initial-snapshot",
    });
    const latestSnapshot = await authorizationStore.get({
      key: "admin-capability-v1-latest-pre-sync",
    });
    expect(initialSnapshot).toEqual(expect.objectContaining({ roles: expect.any(Array) }));
    expect(latestSnapshot).toEqual(initialSnapshot);

    const idsBeforeSecondRun = new Map(
      migratedRoles.map((role: any) => [role.type, Number(role.id)]),
    );
    await __rolePermissionTestUtils.ensurePluginRolesAndPermissions(strapi);
    const rolesAfterSecondRun = await roleQuery.findMany({ populate: ["permissions"] });
    for (const role of rolesAfterSecondRun) {
      if (idsBeforeSecondRun.has(role.type)) {
        expect(Number(role.id)).toBe(idsBeforeSecondRun.get(role.type));
      }
    }
    expect(rolesAfterSecondRun.filter((role: any) => role.type === "store-manager")).toHaveLength(
      1,
    );
    expect(
      rolesAfterSecondRun.filter((role: any) => role.type === "store-manager-2"),
    ).toHaveLength(1);
  });
});
