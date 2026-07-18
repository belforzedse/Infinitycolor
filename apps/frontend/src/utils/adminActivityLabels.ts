import { faNum } from "./faNum";
import { translateOrderStatus, translatePaymentStatus } from "./statusTranslations";
import { translatePluginRoleLabel } from "@/constants/roleLabels";
import { formatFaDateTime, formatFaRelativeDateTime } from "./formatFaRelativeDateTime";

/**
 * Single source of truth for rendering admin-activity (`manual-admin-activity`) logs in Persian.
 * Every lookup falls back to the raw key/value so old or unrecognized rows degrade gracefully
 * instead of breaking the UI. Shared by the activity report list, the activity detail page, and the
 * super-admin order Events sidebar.
 */

/* ------------------------------------------------------------------ actions */

export const ACTION_LABELS_FA: Record<string, string> = {
  Create: "ایجاد",
  Update: "بروزرسانی",
  Delete: "حذف کامل",
  "Delete-Soft": "حذف نرم",
  Publish: "انتشار",
  Unpublish: "برداشتن انتشار",
  Adjust: "تنظیم",
  Import: "ورود گروهی",
  Refund: "بازپرداخت",
  StatusChange: "تغییر وضعیت",
  Other: "سایر",
};

export const translateAction = (action?: string | null): string =>
  (action && ACTION_LABELS_FA[action]) || action || "نامشخص";

/** Tailwind badge classes per action, consistent across all activity views. */
export const getActionBadgeClass = (action?: string | null): string => {
  switch (action) {
    case "Create":
      return "bg-green-100 text-green-700";
    case "Update":
    case "Adjust":
      return "bg-yellow-100 text-yellow-700";
    case "StatusChange":
      return "bg-blue-100 text-blue-700";
    case "Delete":
      return "bg-red-100 text-red-700";
    case "Delete-Soft":
      return "bg-orange-100 text-orange-700";
    case "Refund":
      return "bg-purple-100 text-purple-700";
    case "Publish":
    case "Unpublish":
    case "Import":
      return "bg-cyan-100 text-cyan-700";
    default:
      return "bg-gray-100 text-gray-700";
  }
};

/* ----------------------------------------------------------------- entities */

export const RESOURCE_TYPE_LABELS_FA: Record<string, string> = {
  Order: "سفارش",
  Product: "محصول",
  User: "کاربر",
  Contract: "قرارداد",
  Discount: "تخفیف",
  Stock: "موجودی",
  Admin: "ادمین",
  Other: "سایر",
};

export const translateResourceType = (resourceType?: string | null): string =>
  (resourceType && RESOURCE_TYPE_LABELS_FA[resourceType]) || resourceType || "نامشخص";

/* ----------------------------------------------------------------- severity */

export const SEVERITY_META_FA: Record<
  string,
  { label: string; badgeClass: string; dotClass: string }
> = {
  info: { label: "اطلاعات", badgeClass: "bg-blue-100 text-blue-700", dotClass: "bg-slate-400" },
  success: { label: "موفق", badgeClass: "bg-green-100 text-green-700", dotClass: "bg-green-500" },
  warning: { label: "هشدار", badgeClass: "bg-yellow-100 text-yellow-700", dotClass: "bg-yellow-500" },
  error: { label: "خطا", badgeClass: "bg-red-100 text-red-700", dotClass: "bg-red-500" },
};

export const getSeverityMeta = (severity?: string | null) =>
  (severity && SEVERITY_META_FA[severity]) || SEVERITY_META_FA.info;

/* --------------------------------------------------------------- role label */

export const translateActivityRole = (role?: string | null): string =>
  role ? translatePluginRoleLabel(role) : "";

/* -------------------------------------------------------------- field names */

export const FIELD_LABELS_FA: Record<string, string> = {
  Status: "وضعیت سفارش",
  Note: "یادداشت مشتری",
  Description: "توضیحات",
  ShippingCost: "هزینه ارسال",
  ShippingMethod: "روش ارسال",
  ShippingBarcode: "بارکد ارسال",
  ContractAmount: "مبلغ قرارداد",
  Amount: "مبلغ سفارش",
  PerAmount: "مبلغ واحد",
  ItemsRemoved: "حذف اقلام",
  PaymentStatus: "وضعیت پرداخت",
  PaymentGateway: "درگاه پرداخت",
  CustomerName: "نام مشتری",
  CustomerPhone: "شماره تماس مشتری",
  Address: "آدرس",
};

const ITEM_COUNT_RE = /^Item_\d+_Count$/;
const AMOUNT_FIELDS = new Set([
  "ShippingCost",
  "ContractAmount",
  "Amount",
  "PerAmount",
]);

export const translateFieldLabel = (key: string): string => {
  if (FIELD_LABELS_FA[key]) return FIELD_LABELS_FA[key];
  if (ITEM_COUNT_RE.test(key)) return "تعداد قلم";
  return key;
};

/* ------------------------------------------------------------- value format */

/**
 * Render a single before/after value for display. Status values are translated, amount fields are
 * formatted with Persian digits, null/empty becomes «—», objects become a compact string.
 */
/** Hard cap so a stray object/large blob in a change value can never break the page layout. */
const MAX_VALUE_LEN = 120;
const clamp = (text: string): string =>
  text.length > MAX_VALUE_LEN ? `${text.slice(0, MAX_VALUE_LEN)}…` : text;

export const formatChangeValue = (field: string, value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "Status") return translateOrderStatus(String(value));
  if (field === "PaymentStatus") return translatePaymentStatus(String(value));
  if (typeof value === "boolean") return value ? "بله" : "خیر";

  const isNumeric =
    typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)));
  if (isNumeric && (AMOUNT_FIELDS.has(field) || ITEM_COUNT_RE.test(field))) {
    return faNum(Number(value));
  }

  // Never dump a raw object/JSON blob into the timeline — it overflows and breaks the page.
  // Objects and arrays are summarised, and every value is length-capped as a final guard.
  if (typeof value === "object") {
    return Array.isArray(value) ? `${faNum(value.length)} مورد` : "(مقدار به‌روزرسانی شد)";
  }
  return clamp(String(value));
};

/* --------------------------------------------------------------- summaries */

export interface ActivityChange {
  from?: unknown;
  to?: unknown;
}

/**
 * Turn one field change into a meaningful Persian sentence. Falls back to a generic
 * «{label} تغییر کرد» for unknown fields so nothing breaks.
 */
export const summarizeChange = (field: string, change: ActivityChange): string => {
  const label = translateFieldLabel(field);
  const hasFrom = change.from !== null && change.from !== undefined && change.from !== "";
  if (field === "Status") {
    return `وضعیت سفارش از «${formatChangeValue("Status", change.from)}» به «${formatChangeValue(
      "Status",
      change.to,
    )}» تغییر کرد`;
  }
  if (field === "PaymentStatus") {
    return `وضعیت پرداخت به «${formatChangeValue("PaymentStatus", change.to)}» تغییر کرد`;
  }
  if (field === "PaymentGateway") return "درگاه پرداخت تغییر کرد";
  if (field === "ShippingMethod") return "روش ارسال تغییر کرد";
  if (field === "ShippingBarcode") {
    const toPresent = change.to !== null && change.to !== undefined && change.to !== "";
    return toPresent ? "بارکد ارسال ثبت شد" : "بارکد ارسال حذف شد";
  }
  if (AMOUNT_FIELDS.has(field)) {
    const toPresent = change.to !== null && change.to !== undefined && change.to !== "";
    if (!toPresent) return `${label} حذف شد`;
    return `${label} به ${formatChangeValue(field, change.to)} تومان تغییر کرد`;
  }
  if (field === "Note" || field === "Description")
    return hasFrom ? "یادداشت/توضیحات سفارش ویرایش شد" : "یادداشت/توضیحات سفارش ثبت شد";
  if (field === "CustomerName" || field === "CustomerPhone" || field === "Address")
    return "اطلاعات مشتری به‌روزرسانی شد";
  if (ITEM_COUNT_RE.test(field) || field === "ItemsRemoved") return "اقلام سفارش تغییر کرد";
  return `${label} تغییر کرد`;
};

interface SummarizableActivity {
  Title?: string;
  Message?: string;
  Action?: string | null;
  ResourceType?: string | null;
  Changes?: Record<string, ActivityChange> | null;
}

/**
 * Headline for an activity entry. Prefers the backend-provided Persian Title/Message; otherwise
 * derives a readable line from the changes, then from action + resource type.
 */
export const summarizeActivity = (activity: SummarizableActivity): string => {
  if (activity.Title) return activity.Title;
  if (activity.Message) return activity.Message;

  const changeKeys = activity.Changes ? Object.keys(activity.Changes) : [];
  if (changeKeys.length === 1) {
    return summarizeChange(changeKeys[0], activity.Changes![changeKeys[0]]);
  }

  const action = translateAction(activity.Action);
  const resource = translateResourceType(activity.ResourceType);
  return `${action} ${resource}`.trim();
};

/* --------------------------------------------------------------- metadata */

export const METADATA_LABELS_FA: Record<string, string> = {
  reason: "دلیل",
  changesCount: "تعداد تغییرات",
  fields: "فیلدها",
  barcode: "بارکد",
  operation: "عملیات",
  type: "نوع",
  status: "وضعیت",
  removedAt: "زمان حذف",
  isSoftDelete: "حذف نرم",
};

export const translateMetadataKey = (key: string): string => METADATA_LABELS_FA[key] || key;

/** Render a metadata value as readable Persian text (arrays joined, objects stringified). */
export const formatMetadataValue = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "بله" : "خیر";
  if (Array.isArray(value)) {
    return value.map((v) => translateFieldLabel(String(v))).join("، ");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (typeof value === "number") return faNum(value);
  return String(value);
};

/* ------------------------------------------------------------------- dates */

/** Absolute Jalali timestamp for detail rows. */
export const formatActivityDateTime = (value?: string | Date | null): string =>
  formatFaDateTime(value);

/** Relative Jalali timestamp («امروز ساعت ۱۰:۳۰») for compact lists/timelines. */
export const formatActivityRelative = (value?: string | Date | null): string =>
  formatFaRelativeDateTime(value);

/* --------------------------------------------------------------------- ip */

/** Display an IP, or «—» when missing. */
export const formatActivityIp = (ip?: string | null): string => ip || "—";
