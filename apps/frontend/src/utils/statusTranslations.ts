import { PersianOrderStatus } from "@/constants/enums";
import { getPaymentGatewayLabel } from "@/utils/paymentGateways";

export type StatusTone = "info" | "success" | "warning" | "danger";

interface StatusMeta {
  label: string;
  tone: StatusTone;
}

const normalizeKey = (value?: string | null) => {
  if (!value) return "";
  return value.toString().trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
};

// Order statuses collapse into the 4 storefront buckets everywhere they are shown.
const IN_PROGRESS_LABEL = "در حال انجام";
const COMPLETED_LABEL = "تکمیل شده";
const CANCELLED_LABEL = "لغو شده یا ناموفق";
const ORDER_STATUS_MAP: Record<string, StatusMeta> = {
  paying: { label: IN_PROGRESS_LABEL, tone: "info" },
  "paying offline": { label: IN_PROGRESS_LABEL, tone: "info" },
  started: { label: IN_PROGRESS_LABEL, tone: "info" },
  pending: { label: IN_PROGRESS_LABEL, tone: "info" },
  processing: { label: IN_PROGRESS_LABEL, tone: "info" },
  "in progress": { label: IN_PROGRESS_LABEL, tone: "info" },
  shipment: { label: IN_PROGRESS_LABEL, tone: "info" },
  shipped: { label: IN_PROGRESS_LABEL, tone: "info" },
  delivery: { label: IN_PROGRESS_LABEL, tone: "info" },
  delivered: { label: COMPLETED_LABEL, tone: "success" },
  done: { label: COMPLETED_LABEL, tone: "success" },
  completed: { label: COMPLETED_LABEL, tone: "success" },
  success: { label: COMPLETED_LABEL, tone: "success" },
  cancelled: { label: CANCELLED_LABEL, tone: "danger" },
  canceled: { label: CANCELLED_LABEL, tone: "danger" },
  returned: { label: CANCELLED_LABEL, tone: "danger" },
  failed: { label: CANCELLED_LABEL, tone: "danger" },
  refund: { label: CANCELLED_LABEL, tone: "danger" },
};

const PAYMENT_STATUS_MAP: Record<string, StatusMeta> = {
  success: { label: "موفق", tone: "success" },
  succeeded: { label: "موفق", tone: "success" },
  pending: { label: "در انتظار", tone: "warning" },
  processing: { label: "در حال پردازش", tone: "info" },
  failed: { label: "ناموفق", tone: "danger" },
  cancelled: { label: "لغو شده", tone: "danger" },
  canceled: { label: "لغو شده", tone: "danger" },
  refunded: { label: "بازپرداخت شد", tone: "info" },
};

const CONTRACT_STATUS_MAP: Record<string, string> = {
  "not ready": "آماده نشده",
  confirmed: "تایید شده",
  finished: "تکمیل شده",
  failed: "ناموفق",
  cancelled: "لغو شده",
  canceled: "لغو شده",
};

const CART_STATUS_MAP: Record<string, string> = {
  pending: "در حال تصمیم‌گیری",
  payment: "در انتظار پرداخت",
  left: "رها شده",
  completed: "تکمیل شده",
};

const COMMENT_STATUS_MAP: Record<string, string> = {
  accepted: "تایید شده",
  rejected: "رد شده",
  pending: "در حال بررسی",
  "need for review": "در انتظار تایید",
};

const ORDER_LOG_TRANSLATIONS: Array<{ key: string; label: string }> = [
  { key: "create", label: "سفارش ثبت شد" },
  { key: "order created", label: "سفارش ثبت شد" },
  { key: "payment", label: "پرداخت ثبت شد" },
  { key: "payment recorded", label: "پرداخت ثبت شد" },
  { key: "payment updated", label: "پرداخت بروزرسانی شد" },
  { key: "success", label: "پرداخت موفق بود" },
  { key: "fail", label: "پرداخت ناموفق بود" },
  { key: "ship", label: "سفارش ارسال شد" },
  { key: "deliver", label: "سفارش تحویل شد" },
  { key: "cancel", label: "سفارش لغو شد" },
  { key: "return", label: "مرجوعی ثبت شد" },
  { key: "status changed", label: "وضعیت سفارش بروزرسانی شد" },
  { key: "order updated", label: "سفارش بروزرسانی شد" },
  { key: "contract created", label: "قرارداد ایجاد شد" },
  { key: "contract failed", label: "قرارداد با خطا مواجه شد" },
];

const GENERIC_TRANSLATIONS: Record<string, string> = {
  pending: "در انتظار",
  success: "موفق",
  failed: "ناموفق",
  cancelled: "لغو شده",
  canceled: "لغو شده",
};

/** Funnel step keys used in traffic/Matomo reports. */
export const FUNNEL_STEP_MAP: Record<string, string> = {
  view_item: "مشاهده محصول",
  add_to_cart: "افزودن به سبد",
  begin_checkout: "شروع تسویه",
  purchase: "خرید نهایی",
};

export const translateFunnelStep = (step?: string | null): string => {
  if (!step) return "";
  return FUNNEL_STEP_MAP[step] ?? step;
};

const getMeta = (map: Record<string, StatusMeta>, value?: string | null): StatusMeta => {
  if (!value) {
    return { label: "نامشخص", tone: "info" };
  }
  const normalized = normalizeKey(value);
  return map[normalized] ?? { label: value, tone: "info" };
};

const DELIVERED_KEYS = ["done", "delivered", "completed", "success", "تحویل داده شده"];
const CANCELLED_KEYS = [
  "cancelled",
  "canceled",
  "returned",
  "failed",
  "refund",
  "refunded",
  "لغو شده",
];

// Every raw backend status collapses into one of the 4 storefront buckets, so an order's
// status reads the same everywhere (admin table, order edit, logs, order detail) instead of
// the confusing granular values (شروع شده/ثبت شده/در حال ارسال…). Tone drives the badge colour.
const ORDER_CATEGORY_META: Record<PersianOrderStatus, StatusMeta> = {
  [PersianOrderStatus.INPROGRESS]: { label: PersianOrderStatus.INPROGRESS, tone: "info" },
  [PersianOrderStatus.DELIVERED]: { label: PersianOrderStatus.DELIVERED, tone: "success" },
  [PersianOrderStatus.CANCELLED]: { label: PersianOrderStatus.CANCELLED, tone: "danger" },
  [PersianOrderStatus.MANUAL]: { label: PersianOrderStatus.MANUAL, tone: "info" },
};

export const getOrderStatusMeta = (status?: string | null): StatusMeta => {
  if (!status) return { label: "نامشخص", tone: "info" };
  return ORDER_CATEGORY_META[getOrderStatusCategory(status)];
};

export const translateOrderStatus = (status?: string | null): string =>
  getOrderStatusMeta(status).label;

/** Maps raw backend order Status to the UI category enum (tabs / row display). */
export const getOrderStatusCategory = (status?: string | null): PersianOrderStatus => {
  const normalized = normalizeKey(status);
  if (DELIVERED_KEYS.includes(normalized)) {
    return PersianOrderStatus.DELIVERED;
  }
  if (CANCELLED_KEYS.includes(normalized)) {
    return PersianOrderStatus.CANCELLED;
  }
  return PersianOrderStatus.INPROGRESS;
};

export const getPaymentStatusMeta = (status?: string | null): StatusMeta => {
  return getMeta(PAYMENT_STATUS_MAP, status);
};

export const translatePaymentStatus = (status?: string | null): string =>
  getPaymentStatusMeta(status).label;

export const translateContractStatus = (status?: string | null): string => {
  if (!status) return "نامشخص";
  const normalized = normalizeKey(status);
  return CONTRACT_STATUS_MAP[normalized] ?? status;
};

export const translateCartStatus = (status?: string | null): string => {
  if (!status) return "نامشخص";
  const normalized = normalizeKey(status);
  return CART_STATUS_MAP[normalized] ?? status;
};

export const translateCommentStatus = (status?: string | null): string => {
  if (!status) return "نامشخص";
  const normalized = normalizeKey(status);
  return COMMENT_STATUS_MAP[normalized] ?? status;
};

export const translateOrderLogMessage = (message?: string | null): string => {
  if (!message) return "بروزرسانی";
  const normalized = normalizeKey(message);
  for (const entry of ORDER_LOG_TRANSLATIONS) {
    if (normalized.includes(entry.key)) {
      return entry.label;
    }
  }
  return translateBackendValue(message);
};

export const translateBackendValue = (value?: string | null): string => {
  if (!value) return "نامشخص";
  const normalized = normalizeKey(value);

  if (ORDER_STATUS_MAP[normalized]) return ORDER_STATUS_MAP[normalized].label;
  if (PAYMENT_STATUS_MAP[normalized]) return PAYMENT_STATUS_MAP[normalized].label;
  if (CONTRACT_STATUS_MAP[normalized]) return CONTRACT_STATUS_MAP[normalized];
  if (CART_STATUS_MAP[normalized]) return CART_STATUS_MAP[normalized];
  if (COMMENT_STATUS_MAP[normalized]) return COMMENT_STATUS_MAP[normalized];
  if (GENERIC_TRANSLATIONS[normalized]) return GENERIC_TRANSLATIONS[normalized];

  return value;
};

export const translatePaymentGateway = (value?: string | null): string =>
  getPaymentGatewayLabel(value);
