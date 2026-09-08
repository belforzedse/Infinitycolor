import issueReportEnvelope from "../../../middlewares/issue-report-envelope";

function context(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: "/api/issue-reports",
    get: jest.fn((name: string) => (name === "content-length" ? "1024" : "")),
    status: 200,
    body: undefined,
    ...overrides,
  } as any;
}

describe("issue report request envelope", () => {
  it("rejects a declared oversized payload before the global body parser", async () => {
    const ctx = context({
      get: jest.fn((name: string) => (name === "content-length" ? String(32 * 1024 + 1) : "")),
    });
    const next = jest.fn();

    await issueReportEnvelope()(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.status).toBe(413);
    expect(ctx.body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          details: { data: { errorCode: "ISSUE_REPORT_BODY_TOO_LARGE" } },
        }),
      }),
    );
  });

  it("does not interfere with valid report requests or unrelated routes", async () => {
    const next = jest.fn();
    await issueReportEnvelope()(context(), next);
    await issueReportEnvelope()(context({ path: "/api/orders" }), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
