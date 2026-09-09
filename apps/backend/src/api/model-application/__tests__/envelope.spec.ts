import modelApplicationEnvelope from "../../../middlewares/model-application-envelope";

function context(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: "/api/model-applications",
    get: jest.fn((name: string) => (name === "content-length" ? "1024" : "")),
    status: 200,
    body: undefined,
    ...overrides,
  } as {
    method: string;
    path: string;
    get: jest.Mock;
    status: number;
    body: unknown;
  };
}

describe("model application request envelope", () => {
  it("rejects a declared oversized payload before the global body parser", async () => {
    const ctx = context({
      get: jest.fn((name: string) =>
        name === "content-length" ? String(12 * 1024 * 1024 + 1) : "",
      ),
    });
    const next = jest.fn();

    await modelApplicationEnvelope()(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.status).toBe(413);
    expect(ctx.body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          details: { data: { errorCode: "MODEL_APPLICATION_BODY_TOO_LARGE" } },
        }),
      }),
    );
  });

  it("does not interfere with valid requests or unrelated routes", async () => {
    const next = jest.fn();
    await modelApplicationEnvelope()(context(), next);
    await modelApplicationEnvelope()(context({ path: "/api/orders" }), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
