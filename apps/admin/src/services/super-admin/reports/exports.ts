import { API_BASE_URL } from "@/constants/api";
import { getAccessToken } from "@/utils/auth";
import { normalizeDigits } from "@/utils/faNum";

export const REPORT_EXPORT_ENDPOINTS = {
  payments: "/reports/exports/payments",
  wallet: "/reports/exports/wallet",
  "inventory-history": "/reports/exports/inventory-history",
  orders: "/reports/exports/orders",
  "product-buyers": "/reports/exports/product-buyers",
} as const;

export type ReportExportType = keyof typeof REPORT_EXPORT_ENDPOINTS;
export type ExportTransactionType = "charge" | "refund" | "wallet-topup";
export type ExportOrderStatus =
  | "Paying"
  | "Started"
  | "Shipment"
  | "Done"
  | "Returned"
  | "Cancelled";
export type ExportProvider =
  | "Wallet"
  | "SamanKish"
  | "SnappPay"
  | "Mellat"
  | "ZarinPal"
  | "Manual"
  | "OffGateway"
  | "CardToCard"
  | "Other"
  | "Unknown";

type DateRange = { start: string; end: string };
export type ReportExportFilters =
  | (DateRange & {
      type: "payments";
      provider?: ExportProvider;
      transactionType?: ExportTransactionType;
      orderStatus?: ExportOrderStatus;
    })
  | (DateRange & {
      type: "wallet";
      direction?: "credit" | "debit";
      kind?: "adjustments" | "order-payments";
    })
  | { type: "inventory-history"; productCode: string }
  | (DateRange & {
      type: "orders";
      orderStatus?: ExportOrderStatus;
      provider?: ExportProvider;
    })
  | (DateRange & { type: "product-buyers"; productCodes: string[] });

export type ExportErrorCode =
  | "INVALID_EXPORT_FILTERS"
  | "REPORT_TOO_LARGE"
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "PRODUCT_NOT_FOUND"
  | "AMBIGUOUS_PRODUCT_CODE"
  | "DOWNLOAD_FAILED";

export class ReportExportError extends Error {
  readonly code: ExportErrorCode;

  constructor(code: ExportErrorCode) {
    super(code);
    this.name = "ReportExportError";
    this.code = code;
  }
}

export type ReportExportResult = { rowCount: number | null };

export const REPORT_EXPORT_DATE_FLOOR = "2026-09-14";

export function isValidReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateReportDateRange(
  range: DateRange,
): "invalid-date" | "before-floor" | "reversed" | null {
  if (!isValidReportDate(range.start) || !isValidReportDate(range.end)) {
    return "invalid-date";
  }
  if (range.start < REPORT_EXPORT_DATE_FLOOR || range.end < REPORT_EXPORT_DATE_FLOOR) {
    return "before-floor";
  }
  return range.start > range.end ? "reversed" : null;
}

export function normalizeProductCodes(value: string): string[] {
  const unique = new Set<string>();
  for (const token of normalizeDigits(value).split(/[\n,]+/)) {
    const code = token.trim();
    if (code) unique.add(code);
  }
  return [...unique];
}

export function validateReportExportFilters(
  filters: ReportExportFilters,
): string | null {
  if (filters.type === "inventory-history") {
    return filters.productCode.trim() ? null : "product-code-required";
  }

  const dateError = validateReportDateRange(filters);
  if (dateError) return dateError;

  if (filters.type === "product-buyers") {
    const productCodes = [...new Set(filters.productCodes.map((code) => normalizeDigits(code).trim()).filter(Boolean))];
    if (productCodes.length === 0) return "product-codes-required";
    if (productCodes.length > 20) return "too-many-product-codes";
  }
  return null;
}

function queryFor(filters: ReportExportFilters): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.type !== "inventory-history") {
    query.set("start", filters.start);
    query.set("end", filters.end);
  }
  switch (filters.type) {
    case "payments":
      if (filters.provider) query.set("provider", filters.provider);
      if (filters.transactionType) query.set("transactionType", filters.transactionType);
      if (filters.orderStatus) query.set("orderStatus", filters.orderStatus);
      break;
    case "wallet":
      if (filters.direction) query.set("direction", filters.direction);
      if (filters.kind) query.set("kind", filters.kind);
      break;
    case "inventory-history":
      query.set("productCode", normalizeDigits(filters.productCode).trim());
      break;
    case "orders":
      if (filters.orderStatus) query.set("orderStatus", filters.orderStatus);
      if (filters.provider) query.set("provider", filters.provider);
      break;
    case "product-buyers":
      query.set(
        "productCodes",
        [...new Set(filters.productCodes.map((code) => normalizeDigits(code).trim()).filter(Boolean))].join(","),
      );
      break;
  }
  return query;
}

async function readErrorCode(response: Response): Promise<ExportErrorCode> {
  if (response.status === 403) return "FORBIDDEN";
  if (response.status === 401) return "UNAUTHENTICATED";
  if (response.status === 413) return "REPORT_TOO_LARGE";
  if ([400, 404, 409].includes(response.status)) {
    try {
      const body = await response.json();
      const code = body?.error?.details?.code ?? body?.details?.code;
      if (["INVALID_EXPORT_FILTERS", "PRODUCT_NOT_FOUND", "AMBIGUOUS_PRODUCT_CODE"].includes(code)) {
        return code;
      }
    } catch {
      // The UI uses a generic message when the server does not return a known code.
    }
  }
  return "DOWNLOAD_FAILED";
}

function safeFilenameDate(value?: string): string {
  return value && isValidReportDate(value) ? value : "all-dates";
}

export async function downloadReportExport(
  filters: ReportExportFilters,
): Promise<ReportExportResult> {
  const validationError = validateReportExportFilters(filters);
  if (validationError) throw new ReportExportError("INVALID_EXPORT_FILTERS");
  if (typeof window === "undefined") throw new ReportExportError("DOWNLOAD_FAILED");

  const token = await getAccessToken();
  const url = `${API_BASE_URL}${REPORT_EXPORT_ENDPOINTS[filters.type]}?${queryFor(filters).toString()}`;
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new ReportExportError(await readErrorCode(response));

  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  const date = filters.type === "inventory-history" ? "all-dates" : safeFilenameDate(filters.start);
  const disposition = response.headers.get("Content-Disposition");
  const filename = disposition?.match(/^attachment;\s*filename="([a-zA-Z0-9_.-]+\.xlsx)"$/)?.[1];
  anchor.download = filename ?? `infinitycolor-${filters.type}-${date}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);

  const rowHeader = response.headers.get("X-Report-Row-Count");
  const rowCount = rowHeader != null && /^\d+$/.test(rowHeader) ? Number(rowHeader) : null;
  return { rowCount };
}
