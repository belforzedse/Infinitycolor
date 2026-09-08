import { IssueReportError, validateCreateIssueReportPayload } from "../services/issue-report";

const valid = {
  submissionId: "c7150e5a-8dbb-4a73-9742-8c33ee3a61b7",
  number: "۰۹۱۲ ۱۲۳ ۴۵۶۷",
  issueName: "مشکل در نمایش سفارش",
  description: "صفحه سفارش برای من باز نمی‌شود.",
  sourcePath: "/account/orders",
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

describe("issue report payload validation", () => {
  it("accepts the three user fields and bounds the silent context snapshot", () => {
    expect(validateCreateIssueReportPayload(valid)).toEqual({
      submissionId: valid.submissionId,
      contactNumber: "+989121234567",
      issueName: valid.issueName,
      description: valid.description,
      sourcePath: valid.sourcePath,
      locale: "fa-IR",
      context: valid.context,
    });
  });

  it("rejects unrecognized fields", () => {
    expect(() => validateCreateIssueReportPayload({ ...valid, attachment: "x" })).toThrow(
      expect.objectContaining<IssueReportError>({
        code: "ISSUE_REPORT_UNEXPECTED_FIELD",
        status: 400,
      }),
    );
  });

  it("rejects invalid contact numbers", () => {
    expect(() => validateCreateIssueReportPayload({ ...valid, number: "02112345678" })).toThrow(
      expect.objectContaining<IssueReportError>({
        code: "ISSUE_REPORT_PHONE_INVALID",
        status: 400,
      }),
    );
  });

  it("does not accept query strings in the captured source path", () => {
    expect(() =>
      validateCreateIssueReportPayload({ ...valid, sourcePath: "/orders?token=secret" }),
    ).toThrow(
      expect.objectContaining<IssueReportError>({
        code: "ISSUE_REPORT_SOURCE_INVALID",
        status: 400,
      }),
    );
  });

  it.each(["//evil.example/path", "/\\evil.example/path", "/orders\nforged"])(
    "rejects an unsafe source path: %s",
    (sourcePath) => {
      expect(() => validateCreateIssueReportPayload({ ...valid, sourcePath })).toThrow(
        expect.objectContaining<IssueReportError>({
          code: "ISSUE_REPORT_SOURCE_INVALID",
          status: 400,
        }),
      );
    },
  );

  it.each(["issueName", "description"])("requires %s", (field) => {
    expect(() => validateCreateIssueReportPayload({ ...valid, [field]: "" })).toThrow(
      expect.objectContaining<IssueReportError>({ code: "ISSUE_REPORT_REQUIRED", status: 400 }),
    );
  });

  it.each([
    ["issueName", "ع".repeat(121)],
    ["description", "ت".repeat(4_001)],
  ])("bounds %s", (field, value) => {
    expect(() => validateCreateIssueReportPayload({ ...valid, [field]: value })).toThrow(
      expect.objectContaining<IssueReportError>({ code: "ISSUE_REPORT_TOO_LONG", status: 400 }),
    );
  });

  it("rejects an oversized request before storing it", () => {
    expect(() =>
      validateCreateIssueReportPayload({ ...valid, description: "م".repeat(33 * 1024) }),
    ).toThrow(
      expect.objectContaining<IssueReportError>({
        code: "ISSUE_REPORT_BODY_TOO_LARGE",
        status: 413,
      }),
    );
  });

  it("preserves untrusted text as plain data instead of rewriting it", () => {
    const text = '<script>alert("x")</script> مشکل واقعی';
    expect(validateCreateIssueReportPayload({ ...valid, description: text }).description).toBe(
      text,
    );
  });
});
