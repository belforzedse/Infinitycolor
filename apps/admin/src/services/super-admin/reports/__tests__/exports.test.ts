import {
  downloadReportExport,
  normalizeProductCodes,
  REPORT_EXPORT_DATE_FLOOR,
  ReportExportError,
  validateReportDateRange,
  validateReportExportFilters,
} from "../exports";

jest.mock("@/utils/auth", () => ({ getAccessToken: jest.fn().mockResolvedValue("session-token") }));

const originalFetch = global.fetch;
const mockFetch = jest.fn();

beforeEach(() => {
  global.fetch = mockFetch;
  mockFetch.mockReset();
  URL.createObjectURL = jest.fn().mockReturnValue("blob:report");
  URL.revokeObjectURL = jest.fn();
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe("report export filters", () => {
  it("rejects invalid dates, reversed ranges, and dates before the store data floor", () => {
    expect(validateReportDateRange({ start: "2026-02-31", end: "2026-10-01" })).toBe("invalid-date");
    expect(validateReportDateRange({ start: "2026-10-02", end: "2026-10-01" })).toBe("reversed");
    expect(validateReportDateRange({ start: "2026-09-13", end: REPORT_EXPORT_DATE_FLOOR })).toBe("before-floor");
  });

  it("normalizes localized digits and deduplicates buyer codes in input order", () => {
    expect(normalizeProductCodes("  کد-۱۲۳,کد-123\nکد-۲۴  ")).toEqual(["کد-123", "کد-24"]);
  });

  it("requires one to twenty unique buyer product codes", () => {
    expect(validateReportExportFilters({
      type: "product-buyers",
      start: "2026-10-01",
      end: "2026-10-02",
      productCodes: [],
    })).toBe("product-codes-required");
    expect(validateReportExportFilters({
      type: "product-buyers",
      start: "2026-10-01",
      end: "2026-10-02",
      productCodes: Array.from({ length: 21 }, (_, index) => `SKU-${index}`),
    })).toBe("too-many-product-codes");
    expect(validateReportExportFilters({ type: "inventory-history", productCode: " " })).toBe("product-code-required");
  });
});

describe("downloadReportExport", () => {
  it("sends an authenticated GET with only the selected report filters and handles an empty workbook", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ "X-Report-Row-Count": "0" }),
      blob: async () => new Blob(["xlsx"]),
    });
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await expect(downloadReportExport({
      type: "payments",
      start: "2026-10-01",
      end: "2026-10-02",
      provider: "SamanKish",
      transactionType: "refund",
    })).resolves.toEqual({ rowCount: 0 });

    const [url, request] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/reports/exports/payments?");
    expect(url).toContain("provider=SamanKish");
    expect(url).toContain("transactionType=refund");
    expect(url).not.toContain("productCode");
    expect(request).toMatchObject({ method: "GET", credentials: "include", cache: "no-store" });
    expect(request.headers).toEqual({ Authorization: "Bearer session-token" });
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("uses only a product code for inventory history", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      blob: async () => new Blob(["xlsx"]),
    });
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await downloadReportExport({ type: "inventory-history", productCode: "SKU-۱۲۳" });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain("/reports/exports/inventory-history?productCode=SKU-123");
    expect(url).not.toContain("start=");
  });

  it("maps server codes without exposing backend messages", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 413,
      json: async () => ({ details: { code: "REPORT_TOO_LARGE" }, message: "internal details" }),
    });

    await expect(downloadReportExport({
      type: "orders",
      start: "2026-10-01",
      end: "2026-10-02",
    })).rejects.toMatchObject<Partial<ReportExportError>>({ code: "REPORT_TOO_LARGE" });
  });

  it.each([
    [400, "INVALID_EXPORT_FILTERS"],
    [404, "PRODUCT_NOT_FOUND"],
    [409, "AMBIGUOUS_PRODUCT_CODE"],
  ])("reads the Strapi error envelope for status %s", async (status, code) => {
    mockFetch.mockResolvedValue({
      ok: false, status,
      json: async () => ({ error: { details: { code }, message: "private database failure" } }),
    });
    await expect(downloadReportExport({ type: "inventory-history", productCode: "UNKNOWN" })).rejects.toMatchObject({ code });
  });
});
