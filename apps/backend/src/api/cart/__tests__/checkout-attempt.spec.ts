import { checkoutAttemptHandler } from "../controllers/handlers/checkoutAttempt";
import routes from "../routes/a-custom-router";

function world() {
  const rows = [
    {
      attemptId: "own-attempt",
      user: { id: 1 },
      Status: "Unknown",
      quoteHash: "own-quote",
      order: { id: 71 },
      providerReference: "private-reference",
    },
    {
      attemptId: "other-attempt",
      user: { id: 2 },
      Status: "Succeeded",
      quoteHash: "other-quote",
      order: { id: 72 },
    },
    { attemptId: "without-order", user: { id: 1 }, Status: "Pending", quoteHash: "own-quote" },
  ];
  // Evaluate ownership instead of returning an unconditional mocked match.
  const findOne = jest.fn(
    async ({ where }: any) =>
      rows.find((row) => row.attemptId === where.attemptId && row.user.id === where.user.id) ??
      null,
  );
  const strapi: any = {
    db: { query: jest.fn(() => ({ findOne })) },
    log: { error: jest.fn() },
  };
  const context = (attemptId: unknown, userId: number | undefined = 1) => ({
    state: { user: userId ? { id: userId } : undefined },
    request: { query: { attemptId } },
    set: jest.fn(),
    badRequest: jest.fn(),
    unauthorized: jest.fn(),
    forbidden: jest.fn(),
    status: undefined as number | undefined,
  });
  return { strapi, findOne, context, handle: checkoutAttemptHandler(strapi) };
}

describe("checkout attempt recovery lookup", () => {
  it("requires authentication at the route and handler", async () => {
    expect(
      routes.routes.find((route) => route.path === "/carts/checkout-attempt")?.config.auth,
    ).toEqual({ scope: [] });
    const { handle, findOne, context } = world();
    const ctx = context("own-attempt", undefined);
    ctx.state.user = undefined;
    await handle(ctx);
    expect(ctx.unauthorized).toHaveBeenCalled();
    expect(findOne).not.toHaveBeenCalled();
  });

  it("returns only owned recovery evidence and forbids caching", async () => {
    const { handle, context } = world();
    const ctx = context("own-attempt");
    expect(await handle(ctx)).toEqual({
      data: {
        success: true,
        lookup: "found",
        attempt: {
          attemptId: "own-attempt",
          status: "Unknown",
          quoteHash: "own-quote",
          orderId: 71,
        },
      },
    });
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("does not distinguish another user's attempt from a nonexistent attempt", async () => {
    const { handle, context } = world();
    const missing = { data: { success: true, lookup: "missing" } };
    expect(await handle(context("other-attempt"))).toEqual(missing);
    expect(await handle(context("missing-attempt"))).toEqual(missing);
  });

  it("keeps an existing in-flight attempt distinct from a missing attempt", async () => {
    const { handle, context } = world();
    expect(await handle(context("without-order"))).toEqual({
      data: {
        success: true,
        lookup: "found",
        attempt: { attemptId: "without-order", status: "Pending", quoteHash: "own-quote" },
      },
    });
  });

  it.each([undefined, "", " ", ["own-attempt"], { $ne: "" }, "a".repeat(129)])(
    "rejects invalid attempt identifiers (%p)",
    async (id) => {
      const { handle, findOne, context } = world();
      const ctx = context(id);
      await handle(ctx);
      expect(ctx.badRequest).toHaveBeenCalled();
      expect(findOne).not.toHaveBeenCalled();
    },
  );

  it("never reports a database failure as a missing payment", async () => {
    const { handle, findOne, context } = world();
    findOne.mockRejectedValueOnce(new Error("private database details"));
    const ctx = context("own-attempt");
    expect(await handle(ctx)).toEqual({
      data: {
        success: false,
        lookup: "unavailable",
        errorCode: "CHECKOUT_ATTEMPT_LOOKUP_UNAVAILABLE",
      },
    });
    expect(ctx.status).toBe(503);
  });
});
