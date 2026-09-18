import {
  clipIssueReportVarchar,
  IssueReportError,
  ISSUE_REPORT_USER_AGENT_MAX,
  validateCreateIssueReportPayload,
} from "../services/issue-report";

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

  it("keeps a source path longer than the old varchar(255) production width", () => {
    const sourcePath = `/${"a".repeat(300)}`;
    expect(validateCreateIssueReportPayload({ ...valid, sourcePath }).sourcePath).toBe(sourcePath);
  });

  it("accepts a title at the widened schema limit", () => {
    const issueName = "ع".repeat(500);
    expect(validateCreateIssueReportPayload({ ...valid, issueName }).issueName).toBe(issueName);
  });

  it("does not clip stored varchars down to 255", () => {
    const userAgent = "Instagram ".repeat(80);
    expect(userAgent.length).toBeGreaterThan(255);
    expect(clipIssueReportVarchar(userAgent, ISSUE_REPORT_USER_AGENT_MAX)).toBe(userAgent);
    expect(clipIssueReportVarchar("a".repeat(5000), ISSUE_REPORT_USER_AGENT_MAX)).toHaveLength(
      ISSUE_REPORT_USER_AGENT_MAX,
    );
  });

  it("rejects a source path beyond the schema width", () => {
    expect(() =>
      validateCreateIssueReportPayload({ ...valid, sourcePath: `/${"a".repeat(2048)}` }),
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
    ["issueName", "ع".repeat(501)],
    ["description", "ت".repeat(8_001)],
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

it("captures a valid order reference and drops an invalid one", () => {
  const withOrder = validateCreateIssueReportPayload({
    ...valid,
    context: { ...valid.context, order: { orderId: 111805, extra: "discard", statusAtSubmit: "Started" } },
  }).context;
  expect(withOrder?.order).toEqual({ orderId: 111805 });

  for (const orderId of [-5, 0, 1.5, "not-a-number", null]) {
    const context = validateCreateIssueReportPayload({
      ...valid,
      context: { ...valid.context, order: { orderId } },
    }).context;
    expect(context?.order).toBeUndefined();
  }
});

it("captures a bounded cart snapshot and discards malformed lines", () => {
  const cart = [
    { name: "وست گلدوزی تدی N 0035", sku: "WC-1297070-1297075", quantity: 1, price: 2149000 },
    { name: "بدون قیمت", sku: "X", quantity: 1, price: -1 },
    { name: "", sku: "Y", quantity: 1, price: 1000 },
    { name: "بدون تعداد", sku: "Z", quantity: 0, price: 1000 },
    ...Array.from({ length: 25 }, (_, index) => ({
      name: `کالا ${index}`,
      sku: `SKU-${index}`,
      quantity: 1,
      price: 1000,
    })),
  ];
  const context = validateCreateIssueReportPayload({
    ...valid,
    context: { ...valid.context, cart },
  }).context;
  expect(context?.cart?.[0]).toEqual({
    name: "وست گلدوزی تدی N 0035",
    sku: "WC-1297070-1297075",
    quantity: 1,
    price: 2149000,
  });
  expect(context?.cart).toHaveLength(20);

  expect(
    validateCreateIssueReportPayload({ ...valid, context: { ...valid.context, cart: [] } }).context
      ?.cart,
  ).toBeUndefined();
});

it("bounds optional device hints and preserves the legacy context shape", () => {
  const context = validateCreateIssueReportPayload({ ...valid, context: { ...valid.context, androidHints: { model: "Pixel 9 Pro", platformVersion: "16.0.0", serial: "discard" } } }).context;
  expect(context?.androidHints).toEqual({ model: "Pixel 9 Pro", platformVersion: "16.0.0" });
  expect(validateCreateIssueReportPayload(valid).context).toEqual(valid.context);
  expect(validateCreateIssueReportPayload({ ...valid, context: { ...valid.context, androidHints: { model: 9, platformVersion: "bad" } } }).context).toEqual(valid.context);
  const bounded = validateCreateIssueReportPayload({ ...valid, context: { ...valid.context, androidHints: { model: "x".repeat(200), platformVersion: "16" } } }).context;
  expect(bounded?.androidHints?.model).toHaveLength(120);
});
