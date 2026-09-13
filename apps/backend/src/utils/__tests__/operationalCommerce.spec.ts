import { enforceOperationalDataFields } from "../operationalCommerce";

const strapi = {} as any;

function context(role: string, data: Record<string, unknown>) {
  return {
    state: { user: { id: 7, role: { name: role } } },
    request: { body: { data } },
    badRequest: jest.fn(),
  };
}

describe("operational commerce field authorization", () => {
  it.each(["Seller 1", "Store manager", "Founder"])(
    "rejects protected fields for %s",
    async (role) => {
      const ctx = context(role, { Count: 4, reservedCount: 0 });
      await expect(enforceOperationalDataFields(ctx, strapi, ["Count"])).resolves.toBe(false);
      expect(ctx.badRequest).toHaveBeenCalledWith(
        "This role cannot write protected fields: reservedCount",
      );
    },
  );

  it("allows the same protected field for Superadmin system administration", async () => {
    const ctx = context("Superadmin", { Count: 4, reservedCount: 0 });
    await expect(enforceOperationalDataFields(ctx, strapi, ["Count"])).resolves.toBe(true);
    expect(ctx.badRequest).not.toHaveBeenCalled();
  });
});
