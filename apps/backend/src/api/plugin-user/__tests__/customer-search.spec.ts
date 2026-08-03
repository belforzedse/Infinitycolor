import controller from "../controllers/plugin-user";

describe("sanitized customer search", () => {
  it("returns only operational identity fields", async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 12,
        phone: "+989121234567",
        email: "secret@example.test",
        password: "secret-hash",
        IsActive: true,
        blocked: false,
        role: { name: "Customer" },
        user_wallet: { Balance: 500000 },
        user_info: { FirstName: "Test", LastName: "Customer", NationalCode: "001" },
      },
    ]);
    (global as any).strapi = {
      query: jest.fn(() => ({ findMany })),
    };
    const ctx: any = {
      query: { q: "0912", pageSize: 100 },
      badRequest: jest.fn(),
      body: null,
    };

    await controller.searchCustomers(ctx);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 20,
        select: ["id", "phone", "IsActive", "blocked"],
        populate: {
          user_info: { select: ["FirstName", "LastName"] },
        },
      }),
    );
    expect(ctx.body).toEqual({
      data: [
        {
          id: 12,
          phone: "+989121234567",
          firstName: "Test",
          lastName: "Customer",
          isActive: true,
        },
      ],
      meta: { pageSize: 20, count: 1 },
    });
    expect(JSON.stringify(ctx.body)).not.toContain("secret");
    expect(JSON.stringify(ctx.body)).not.toContain("Balance");
    expect(JSON.stringify(ctx.body)).not.toContain("role");
  });
});
