const mockConsumeRateLimit = jest.fn();
const mockCreateIssueReport = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("../services/rate-limit", () => ({
  consumeIssueReportRateLimit: (...args: unknown[]) => mockConsumeRateLimit(...args),
}));
jest.mock("../services/issue-report", () => {
  const actual = jest.requireActual("../services/issue-report");
  return {
    ...actual,
    createIssueReport: (...args: unknown[]) => mockCreateIssueReport(...args),
  };
});
jest.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import controller from "../controllers/issue-report";

const payload = {
  submissionId: "c7150e5a-8dbb-4a73-9742-8c33ee3a61b7",
  number: "09121234567",
  issueName: "مشکل در سفارش",
  description: "جزئیات مشکل سفارش من",
  sourcePath: "/products/example",
  locale: "fa-IR",
  context: {
    clientTime: "2026-09-08T12:00:00.000Z",
    timeZone: "Asia/Tehran",
    language: "fa-IR",
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844, pixelRatio: 3 },
    online: true,
    connectionType: "4g",
  },
};

function createCtx(overrides: Record<string, unknown> = {}) {
  return {
    is: jest.fn(() => true),
    request: { body: payload },
    state: {},
    get: jest.fn((name: string) => (name === "user-agent" ? "Browser/1.0 Device" : "")),
    set: jest.fn(),
    status: 200,
    body: undefined,
    ...overrides,
  } as any;
}

describe("issue report create controller", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConsumeRateLimit.mockResolvedValue({ allowed: true });
    mockCreateIssueReport.mockResolvedValue({
      reportId: "3c63f42d-a6bf-4272-8610-0eb13bb14a90",
      createdAt: "2026-09-08T12:00:01.000Z",
      replayed: false,
    });
    (global as any).strapi = {
      log: { error: jest.fn() },
      metrics: { increment: jest.fn(), observe: jest.fn() },
    };
  });

  it("accepts JSON without OTP or CAPTCHA and attaches server-observed device data", async () => {
    const ctx = createCtx({ state: { user: { id: 42 } } });

    await controller.create(ctx);

    expect(ctx.status).toBe(201);
    expect(mockCreateIssueReport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contactNumber: "+989121234567" }),
      expect.objectContaining({ reporterUserId: 42, userAgent: "Browser/1.0 Device" }),
    );
    expect(ctx.body).toEqual({
      data: expect.objectContaining({ reportId: "3c63f42d-a6bf-4272-8610-0eb13bb14a90" }),
    });
  });

  it("returns a retryable rate-limit response without attempting persistence", async () => {
    mockConsumeRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    const ctx = createCtx();

    await controller.create(ctx);

    expect(ctx.status).toBe(429);
    expect(ctx.set).toHaveBeenCalledWith("Retry-After", "17");
    expect(ctx.body.error.details.data.errorCode).toBe("ISSUE_REPORT_RATE_LIMITED");
    expect(mockCreateIssueReport).not.toHaveBeenCalled();
  });

  it("fails closed with a retryable response when the shared limiter is unavailable", async () => {
    mockConsumeRateLimit.mockRejectedValue(new Error("ECONNREFUSED"));
    const ctx = createCtx();

    await controller.create(ctx);

    expect(ctx.status).toBe(503);
    expect(ctx.set).toHaveBeenCalledWith("Retry-After", "10");
    expect(ctx.body.error.details.data.errorCode).toBe("ISSUE_REPORT_RATE_UNAVAILABLE");
    expect(mockCreateIssueReport).not.toHaveBeenCalled();
  });

  it("fails safely when storage is unavailable without leaking submitted content", async () => {
    mockCreateIssueReport.mockRejectedValue({ code: "53300", detail: payload.description });
    const ctx = createCtx();

    await controller.create(ctx);

    expect(ctx.status).toBe(503);
    expect(JSON.stringify(ctx.body)).not.toContain(payload.description);
    expect((global as any).strapi.log.error).toHaveBeenCalledWith("Issue report operation failed", {
      operation: "create",
      reasonCode: "53300",
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON input before applying the rate limiter", async () => {
    const ctx = createCtx({ is: jest.fn(() => false) });

    await controller.create(ctx);

    expect(ctx.status).toBe(415);
    expect(ctx.body.error.details.data.errorCode).toBe("ISSUE_REPORT_CONTENT_TYPE");
    expect(mockConsumeRateLimit).not.toHaveBeenCalled();
  });
});
