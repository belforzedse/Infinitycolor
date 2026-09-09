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
        where: expect.objectContaining({
          removedAt: { $null: true },
        }),
      }),
    );
    expect(findMany.mock.calls[0][0].where.role).toBeUndefined();
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

  const orClausesOf = (findMany: jest.Mock): Array<Record<string, unknown>> => {
    return findMany.mock.calls[0][0].where.$or as Array<Record<string, unknown>>;
  };

  const phoneClausesOf = (findMany: jest.Mock) =>
    orClausesOf(findMany)
      .map((clause) => clause.phone)
      .filter((phone): phone is Record<string, unknown> => Boolean(phone));

  const runSearch = async (q: string) => {
    const findMany = jest.fn().mockResolvedValue([]);
    (global as any).strapi = { query: jest.fn(() => ({ findMany })) };
    const ctx: any = { query: { q }, badRequest: jest.fn(), body: null };
    await controller.searchCustomers(ctx);
    expect(ctx.badRequest).not.toHaveBeenCalled();
    return findMany;
  };

  it("matches a complete phone against both stored shapes and typed layouts", async () => {
    const findMany = await runSearch("09121234567");
    expect(phoneClausesOf(findMany)).toEqual(
      expect.arrayContaining([
        { $in: ["+989121234567", "09121234567"] },
        { $containsi: "9121234567" },
        { $containsi: "09121234567" },
      ]),
    );
  });

  it("folds Persian digits before matching a complete phone", async () => {
    const findMany = await runSearch("۰۹۱۲۱۲۳۴۵۶۷");
    expect(phoneClausesOf(findMany)).toEqual(
      expect.arrayContaining([{ $in: ["+989121234567", "09121234567"] }]),
    );
  });

  it("matches a partial phone on the national part so either shape hits", async () => {
    const findMany = await runSearch("۰۹۱۲۱۲۳");
    expect(phoneClausesOf(findMany)).toEqual(
      expect.arrayContaining([{ $containsi: "912123" }]),
    );
  });

  it("does not restrict matches to the customer role so staff wallets are searchable", async () => {
    const findMany = await runSearch("0912");
    expect(findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        removedAt: { $null: true },
        $or: expect.any(Array),
      }),
    );
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("role");
  });

  it("keeps users-list name splits including first+last for three-word queries", async () => {
    const findMany = await runSearch("سید محمد حسینی");
    expect(orClausesOf(findMany)).toEqual(
      expect.arrayContaining([
        { user_info: { FirstName: { $containsi: "سید محمد حسینی" } } },
        { user_info: { LastName: { $containsi: "سید محمد حسینی" } } },
        {
          $and: [
            { user_info: { FirstName: { $containsi: "سید محمد" } } },
            { user_info: { LastName: { $containsi: "حسینی" } } },
          ],
        },
      ]),
    );
  });
});
