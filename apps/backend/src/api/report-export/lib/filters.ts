import { normalizeOrderSku } from "../../admin-order-list/lib/delivery-search";

export const MAX_REPORT_ROWS = 25_000;
export const AUTHORITATIVE_FROM = "2026-09-14";
export const REPORTS = ["payments", "wallet", "inventory-history", "orders", "product-buyers"] as const;
export type ExportReport = typeof REPORTS[number];
export const PROVIDERS = ["all", "Unknown", "Wallet", "Mellat", "SnappPay", "SamanKish", "ZarinPal", "Manual", "OffGateway", "CardToCard", "Other"] as const;
export const ORDER_STATUSES = ["all", "Paying", "Started", "Shipment", "Done", "Returned", "Cancelled"] as const;
export type ExportFilters = {
  start?: string; end?: string; startAt?: Date; endExclusive?: Date;
  provider?: string; orderStatus?: string; transactionType?: string;
  direction?: string; kind?: string; productCode?: string; productCodes?: string[];
};

export class ReportExportError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
const invalid = () => { throw new ReportExportError("INVALID_EXPORT_FILTERS", 400, "فیلترهای گزارش معتبر نیستند"); };
function scalar(value: unknown): string {
  if (typeof value !== "string" || value.length > 1000) return invalid();
  return value;
}
function date(value: unknown): string {
  const text = scalar(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return invalid();
  const parsed = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return invalid();
  return text;
}
function choice(value: unknown, allowed: readonly string[]): string {
  if (value === undefined) return "all";
  const text = scalar(value);
  if (!allowed.includes(text)) return invalid();
  return text;
}
function code(value: unknown): string {
  const text = normalizeOrderSku(scalar(value));
  if (!text || text.length > 255 || /[\u0000-\u001f\u007f]/.test(text)) return invalid();
  return text;
}
const keys: Record<ExportReport, string[]> = {
  payments: ["start", "end", "provider", "transactionType", "orderStatus"],
  wallet: ["start", "end", "direction", "kind"],
  orders: ["start", "end", "orderStatus", "provider"],
  "product-buyers": ["start", "end", "productCodes"],
  "inventory-history": ["productCode"],
};

export function parseExportFilters(report: ExportReport, query: unknown): ExportFilters {
  if (!query || typeof query !== "object" || Array.isArray(query)) return invalid();
  const input = query as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys[report].includes(key))) return invalid();
  if (report === "inventory-history") return { productCode: code(input.productCode) };
  const start = date(input.start), end = date(input.end);
  if (start < AUTHORITATIVE_FROM || end < start) return invalid();
  const startAt = new Date(`${start}T00:00:00+03:30`);
  const endExclusive = new Date(new Date(`${end}T00:00:00+03:30`).getTime() + 86_400_000);
  const result: ExportFilters = { start, end, startAt, endExclusive };
  if (report === "payments" || report === "orders") {
    result.provider = choice(input.provider, PROVIDERS);
    result.orderStatus = choice(input.orderStatus, ORDER_STATUSES);
  }
  if (report === "payments") result.transactionType = choice(input.transactionType, ["all", "charge", "refund", "wallet-topup"]);
  if (report === "wallet") {
    result.direction = choice(input.direction, ["all", "credit", "debit"]);
    result.kind = choice(input.kind, ["all", "adjustments", "order-payments"]);
  }
  if (report === "product-buyers") {
    const raw = Array.isArray(input.productCodes) ? input.productCodes : [input.productCodes];
    if (!raw.length || raw.length > 1000) return invalid();
    const codes = raw.flatMap((entry) => scalar(entry).split(",")).map(code);
    result.productCodes = [...new Set(codes)];
    if (!result.productCodes.length || result.productCodes.length > 20) return invalid();
  }
  return result;
}

/** Existing analytics use BETWEEN; their public end must be inclusive. */
export function analyticsEnd(filters: ExportFilters): Date {
  return new Date(filters.endExclusive!.getTime() - 1);
}

export class RowBudget {
  count = 0;
  consume(rows: unknown[]): void {
    this.count += rows.length;
    if (this.count > MAX_REPORT_ROWS) throw new ReportExportError("REPORT_TOO_LARGE", 413, "گزارش بیش از ۲۵٬۰۰۰ ردیف دارد؛ بازه یا فیلترها را محدود کنید");
  }
}
