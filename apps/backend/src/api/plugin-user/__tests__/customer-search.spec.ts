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

  const phoneFilterOf = (findMany: jest.Mock) => {
    const where = findMany.mock.calls[0][0].where;
    return where.$or.find((clause: Record<string, any>) => "phone" in clause)?.phone;
  };

  const runSearch = async (q: string) => {
    const findMany = jest.fn().mockResolvedValue([]);
    (global as any).strapi = { query: jest.fn(() => ({ findMany })) };
    const ctx: any = { query: { q }, badRequest: jest.fn(), body: null };
    await controller.searchCustomers(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    return findMany;
  };

  it("matches a complete phone against both stored shapes", async () => {
    // Phones persist as either +989… or 09…, so one exact form would miss half.
    const findMany = await runSearch("09121234567");
    expect(phoneFilterOf(findMany)).toEqual({
      $in: ["+989121234567", "09121234567"],
    });
  });

  it("folds Persian digits before matching a complete phone", async () => {
    const findMany = await runSearch("۰۹۱۲۱۲۳۴۵۶۷");
    expect(phoneFilterOf(findMany)).toEqual({
      $in: ["+989121234567", "09121234567"],
    });
  });

  it("matches a partial phone on the national part so either shape hits", async () => {
    // "912123" is a substring of 09121234567 and of +989121234567.
    const findMany = await runSearch("۰۹۱۲۱۲۳");
    expect(phoneFilterOf(findMany)).toEqual({ $containsi: "912123" });
  });

  it("keeps name filters and skips the phone clause for a non-numeric query", async () => {
    const findMany = await runSearch("علی");
    expect(phoneFilterOf(findMany)).toBeUndefined();
    expect(findMany.mock.calls[0][0].where.$or).toEqual([
      { user_info: { FirstName: { $containsi: "علی" } } },
      { user_info: { LastName: { $containsi: "علی" } } },
    ]);
  });
});
