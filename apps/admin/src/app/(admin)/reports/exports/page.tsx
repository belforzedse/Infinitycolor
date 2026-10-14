"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import type { AdminCapability } from "@repo/auth-core";
import { AdminCard, AdminStack } from "@/components/admin";
import ReportDateRangeField from "@/components/SuperAdmin/reports/shared/ReportDateRangeField";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { parseDateOnly, toDateOnly } from "@/components/SuperAdmin/reports/shared/reportDates";
import { tehranToday } from "@/components/SuperAdmin/reports/shared/format";
import { translateOrderStatus } from "@/utils/statusTranslations";
import {
  downloadReportExport,
  normalizeProductCodes,
  REPORT_EXPORT_DATE_FLOOR,
  ReportExportError,
  validateReportDateRange,
  type ExportErrorCode,
  type ExportOrderStatus,
  type ExportProvider,
  type ReportExportType,
} from "@/services/super-admin/reports/exports";

const REPORT_OPTIONS: Array<{
  value: ReportExportType;
  label: string;
  description: string;
  group: string;
  capabilities: readonly string[];
}> = [
  {
    value: "payments",
    label: "پرداخت‌ها",
    description: "تراکنش‌ها، بازپرداخت‌ها و پرداخت‌های کیف پول",
    group: "مالی",
    capabilities: ["report.finance.read"],
  },
  {
    value: "wallet",
    label: "تراکنش‌های کیف پول",
    description: "افزایش و کاهش موجودی کیف پول در بازه انتخابی",
    group: "مالی",
    capabilities: ["report.wallet.export"],
  },
  {
    value: "inventory-history",
    label: "تاریخچه موجودی",
    description: "تغییرات موجودی یک محصول بر اساس کد محصول",
    group: "موجودی",
    capabilities: ["report.inventory-history.export"],
  },
  {
    value: "orders",
    label: "سفارش‌ها",
    description: "سفارش‌ها بر اساس وضعیت، درگاه و بازه زمانی",
    group: "فروش",
    capabilities: ["report.sales.read", "order.financial.read"],
  },
  {
    value: "product-buyers",
    label: "خریداران محصولات",
    description: "سفارش‌های خریداران محصولات انتخاب‌شده",
    group: "فروش",
    capabilities: ["report.sales.read", "order.financial.read"],
  },
];

const PROVIDERS: Array<{ value: ExportProvider; label: string }> = [
  { value: "Wallet", label: "کیف پول" },
  { value: "SamanKish", label: "سامان کیش" },
  { value: "SnappPay", label: "اسنپ‌پی" },
  { value: "Mellat", label: "ملت" },
  { value: "ZarinPal", label: "زرین‌پال" },
  { value: "Manual", label: "ثبت دستی" },
  { value: "OffGateway", label: "خارج از درگاه" },
  { value: "CardToCard", label: "کارت‌به‌کارت" },
  { value: "Other", label: "سایر" },
  { value: "Unknown", label: "نامشخص" },
];

const ORDER_STATUSES: Array<{ value: ExportOrderStatus; label: string }> = [
  "Paying",
  "Started",
  "Shipment",
  "Done",
  "Returned",
  "Cancelled",
].map((value) => ({ value: value as ExportOrderStatus, label: translateOrderStatus(value) }));

const REPORT_GROUPS = ["فروش", "مالی", "موجودی"] as const;

function groupedOptions(options: typeof REPORT_OPTIONS) {
  return REPORT_GROUPS.map((group) => ({
    group,
    options: options.filter((option) => option.group === group),
  })).filter(({ options: grouped }) => grouped.length > 0);
}

const CONTROL_CLASS =
  "h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-sm text-slate-800 outline-none transition focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20 disabled:cursor-not-allowed disabled:bg-neutral-100";
const LABEL_CLASS = "mb-2 block text-sm font-medium text-slate-700";

function defaultDateRange() {
  const end = tehranToday();
  const endDate = parseDateOnly(end);
  const candidate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - 29);
  const start = toDateOnly(candidate);
  return {
    start: start < REPORT_EXPORT_DATE_FLOOR ? REPORT_EXPORT_DATE_FLOOR : start,
    end,
  };
}

function hasCapabilities(capabilities: readonly AdminCapability[], required: readonly string[]) {
  return required.every((capability) => capabilities.includes(capability as AdminCapability));
}

function errorMessage(code: ExportErrorCode): string {
  switch (code) {
    case "INVALID_EXPORT_FILTERS":
      return "فیلترها را بررسی کنید و دوباره تلاش کنید.";
    case "REPORT_TOO_LARGE":
      return "گزارش بزرگ‌تر از حد مجاز است؛ بازه زمانی یا فیلترها را محدودتر کنید.";
    case "FORBIDDEN":
      return "برای دریافت این گزارش دسترسی ندارید.";
    case "UNAUTHENTICATED":
      return "برای دریافت گزارش دوباره وارد حساب شوید.";
    case "PRODUCT_NOT_FOUND":
      return "محصولی با این کد پیدا نشد. کد محصول را بررسی کنید.";
    case "AMBIGUOUS_PRODUCT_CODE":
      return "این کد برای چند محصول ثبت شده است. کد محصول را بررسی کنید.";
    default:
      return "دریافت فایل انجام نشد. اتصال را بررسی کنید و دوباره تلاش کنید.";
  }
}

export default function ReportExportsPage() {
  const { capabilities } = useCurrentUser();
  const canAccessExcelExports = hasCapabilities(capabilities, ["report.excel.export"]);
  const visibleOptions = canAccessExcelExports
    ? REPORT_OPTIONS.filter((option) => hasCapabilities(capabilities, option.capabilities))
    : [];
  const [selectedType, setSelectedType] = useState<ReportExportType>("payments");
  const [range, setRange] = useState(defaultDateRange);
  const [provider, setProvider] = useState("");
  const [transactionType, setTransactionType] = useState("");
  const [orderStatus, setOrderStatus] = useState("");
  const [walletDirection, setWalletDirection] = useState("");
  const [walletKind, setWalletKind] = useState("");
  const [productCode, setProductCode] = useState("");
  const [productCodes, setProductCodes] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emptyWorkbook, setEmptyWorkbook] = useState(false);

  const activeOption =
    visibleOptions.find((option) => option.value === selectedType) ?? visibleOptions[0];
  const reportType = activeOption?.value;

  function validateFilters(): boolean {
    if (reportType === "inventory-history") {
      if (!productCode.trim()) {
        setValidationMessage("کد محصول را وارد کنید.");
        return false;
      }
      setValidationMessage(null);
      return true;
    }

    const dateError = validateReportDateRange(range);
    if (dateError === "invalid-date") {
      setValidationMessage("تاریخ شروع و پایان را بررسی کنید.");
      return false;
    }
    if (dateError === "before-floor") {
      setValidationMessage("گزارش‌های این فروشگاه از ۲۳ شهریور ۱۴۰۵ در دسترس‌اند.");
      return false;
    }
    if (dateError === "reversed") {
      setValidationMessage("تاریخ شروع باید پیش از تاریخ پایان باشد.");
      return false;
    }
    if (reportType === "product-buyers") {
      const codes = normalizeProductCodes(productCodes);
      if (codes.length === 0) {
        setValidationMessage("حداقل یک کد محصول وارد کنید.");
        return false;
      }
      if (codes.length > 20) {
        setValidationMessage("حداکثر ۲۰ کد محصول وارد کنید.");
        return false;
      }
    }
    setValidationMessage(null);
    return true;
  }

  async function handleDownload() {
    if (!reportType || busyRef.current) return;
    if (!validateFilters()) return;

    busyRef.current = true;
    setBusy(true);
    setError(null);
    setEmptyWorkbook(false);
    try {
      let result;
      switch (reportType) {
        case "payments":
          result = await downloadReportExport({
            type: reportType,
            ...range,
            ...(provider ? { provider: provider as ExportProvider } : {}),
            ...(transactionType ? { transactionType: transactionType as "charge" | "refund" | "wallet-topup" } : {}),
            ...(orderStatus ? { orderStatus: orderStatus as ExportOrderStatus } : {}),
          });
          break;
        case "wallet":
          result = await downloadReportExport({
            type: reportType,
            ...range,
            ...(walletDirection ? { direction: walletDirection as "credit" | "debit" } : {}),
            ...(walletKind ? { kind: walletKind as "adjustments" | "order-payments" } : {}),
          });
          break;
        case "inventory-history":
          result = await downloadReportExport({ type: reportType, productCode: productCode.trim() });
          break;
        case "orders":
          result = await downloadReportExport({
            type: reportType,
            ...range,
            ...(orderStatus ? { orderStatus: orderStatus as ExportOrderStatus } : {}),
            ...(provider ? { provider: provider as ExportProvider } : {}),
          });
          break;
        case "product-buyers":
          result = await downloadReportExport({
            type: reportType,
            ...range,
            productCodes: normalizeProductCodes(productCodes),
          });
          break;
      }
      setEmptyWorkbook(result.rowCount === 0);
    } catch (cause) {
      const code = cause instanceof ReportExportError ? cause.code : "DOWNLOAD_FAILED";
      setError(errorMessage(code));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (!canAccessExcelExports) return null;

  return (
    <section dir="rtl" className="mx-auto w-full max-w-5xl">
      <div className="mb-5">
        <h1 className="text-lg font-semibold text-slate-900 md:text-xl">گزارش‌های اکسل</h1>
      </div>

      <AdminStack>
        <AdminCard>
          {visibleOptions.length === 0 ? (
            <p className="text-sm leading-6 text-slate-600">گزارشی برای حساب شما در دسترس نیست.</p>
          ) : (
            <div className="space-y-6">
              <div className="max-w-xl">
                <label className={LABEL_CLASS} htmlFor="report-export-type">گزارش</label>
                <select
                  id="report-export-type"
                  className={CONTROL_CLASS}
                  value={reportType}
                  onChange={(event) => {
                    setSelectedType(event.target.value as ReportExportType);
                    setValidationMessage(null);
                    setError(null);
                    setEmptyWorkbook(false);
                  }}
                  disabled={busy}
                >
                  {groupedOptions(visibleOptions).map(({ group, options }) => (
                    <optgroup key={group} label={group}>
                      {options.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {activeOption ? <p className="mt-2 text-sm text-slate-600">{activeOption.description}</p> : null}
              </div>

              {reportType !== "inventory-history" ? (
                <fieldset disabled={busy} className="max-w-3xl">
                  <ReportDateRangeField
                    key={busy ? "preparing" : "ready"}
                    start={parseDateOnly(range.start)}
                    end={parseDateOnly(range.end)}
                    presets={false}
                    onChange={(next) => setRange({ start: toDateOnly(next.start), end: toDateOnly(next.end) })}
                    className="w-full"
                  />
                </fieldset>
              ) : null}

              {reportType === "payments" ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <FieldSelect id="payments-provider" label="درگاه" value={provider} onChange={setProvider} disabled={busy}>
                    <option value="">همه</option>
                    {PROVIDERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </FieldSelect>
                  <FieldSelect id="payments-type" label="نوع تراکنش" value={transactionType} onChange={setTransactionType} disabled={busy}>
                    <option value="">همه</option>
                    <option value="charge">پرداخت</option>
                    <option value="refund">بازپرداخت</option>
                    <option value="wallet-topup">افزایش موجودی کیف پول</option>
                  </FieldSelect>
                  <FieldSelect id="payments-status" label="وضعیت سفارش" value={orderStatus} onChange={setOrderStatus} disabled={busy}>
                    <option value="">همه</option>
                    {ORDER_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </FieldSelect>
                </div>
              ) : null}

              {reportType === "wallet" ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FieldSelect id="wallet-direction" label="نوع تغییر" value={walletDirection} onChange={setWalletDirection} disabled={busy}>
                    <option value="">همه</option>
                    <option value="credit">افزایش موجودی</option>
                    <option value="debit">کاهش موجودی</option>
                  </FieldSelect>
                  <FieldSelect id="wallet-kind" label="منشأ تراکنش" value={walletKind} onChange={setWalletKind} disabled={busy}>
                    <option value="">همه</option>
                    <option value="adjustments">تغییرات دستی</option>
                    <option value="order-payments">پرداخت سفارش‌ها</option>
                  </FieldSelect>
                </div>
              ) : null}

              {reportType === "inventory-history" ? (
                <div className="max-w-xl">
                  <label className={LABEL_CLASS} htmlFor="inventory-product-code">کد محصول</label>
                  <input
                    id="inventory-product-code"
                    className={CONTROL_CLASS}
                    value={productCode}
                    onChange={(event) => setProductCode(event.target.value)}
                    disabled={busy}
                    autoComplete="off"
                    dir="auto"
                  />
                </div>
              ) : null}

              {reportType === "orders" ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FieldSelect id="orders-status" label="وضعیت سفارش" value={orderStatus} onChange={setOrderStatus} disabled={busy}>
                    <option value="">همه</option>
                    {ORDER_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </FieldSelect>
                  <FieldSelect id="orders-provider" label="درگاه" value={provider} onChange={setProvider} disabled={busy}>
                    <option value="">همه</option>
                    {PROVIDERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </FieldSelect>
                </div>
              ) : null}

              {reportType === "product-buyers" ? (
                <div className="max-w-2xl">
                  <label className={LABEL_CLASS} htmlFor="buyer-product-codes">کد محصولات</label>
                  <textarea
                    id="buyer-product-codes"
                    className="min-h-28 w-full resize-y rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-slate-500 focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20 disabled:bg-neutral-100"
                    value={productCodes}
                    onChange={(event) => setProductCodes(event.target.value)}
                    disabled={busy}
                    dir="auto"
                    aria-describedby="buyer-product-codes-help"
                  />
                  <p id="buyer-product-codes-help" className="mt-2 text-xs text-slate-600">تا ۲۰ کد؛ با ویرگول یا خط جدید جدا کنید.</p>
                </div>
              ) : null}

              {validationMessage ? (
                <p role="alert" className="text-sm text-red-700">{validationMessage}</p>
              ) : null}
              {error ? (
                <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-800">{error}</p>
              ) : null}
              {emptyWorkbook ? (
                <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
                  در این بازه نتیجه‌ای پیدا نشد؛ فایل خالی دریافت شد.
                </p>
              ) : null}

              <div className="flex flex-col gap-3 border-t border-neutral-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={busy || !reportType}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-infinity-primary px-5 py-2.5 text-sm font-medium text-white transition hover:bg-infinity-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                >
                  <Download aria-hidden="true" className="size-4" />
                  {busy ? "در حال آماده‌سازی…" : "دانلود اکسل"}
                </button>
                <nav aria-label="گزارش‌های فروش" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  <Link href="/sales/products" className="inline-flex min-h-11 items-center text-infinity-primary underline-offset-4 hover:underline">فروش محصولات</Link>
                  <Link href="/sales/breakdown" className="inline-flex min-h-11 items-center text-infinity-primary underline-offset-4 hover:underline">تفکیک فروش</Link>
                </nav>
              </div>
            </div>
          )}
        </AdminCard>
      </AdminStack>
    </section>
  );
}

function FieldSelect({
  id,
  label,
  value,
  onChange,
  disabled,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <label className={LABEL_CLASS} htmlFor={id}>{label}</label>
      <select id={id} className={CONTROL_CLASS} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {children}
      </select>
    </div>
  );
}
