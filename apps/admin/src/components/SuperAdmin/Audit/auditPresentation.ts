import type {
  AuditActorType,
  AuditEntityRef,
  AuditEvent,
  AuditOrigin,
  AuditResult,
} from "@/services/audit";

export const ACTOR_LABELS: Record<AuditActorType, string> = {
  human: "مدیر",
  customer: "مشتری",
  impersonated_human: "مدیر با دسترسی نیابتی",
  service_account: "سرویس",
  integration: "یکپارچه‌سازی",
  scheduled_job: "زمان‌بند",
  background_worker: "پردازشگر پس‌زمینه",
  webhook: "دریافت‌کننده وب‌هوک",
  migration: "مهاجرت داده",
  system: "سامانه",
  unknown: "عامل نامشخص",
};

export const ORIGIN_LABELS: Record<AuditOrigin, string> = {
  admin_ui: "پنل مدیریت",
  storefront: "فروشگاه",
  public_api: "API عمومی",
  internal_api: "API داخلی",
  scheduled_task: "اجرای زمان‌بندی‌شده",
  queue: "صف پردازش",
  webhook: "وب‌هوک",
  import: "درون‌ریزی",
  migration: "مهاجرت",
  maintenance: "نگه‌داری سامانه",
  legacy: "سابقه قدیمی",
};

export const RESULT_LABELS: Record<AuditResult, string> = {
  success: "موفق",
  partial: "بخشی موفق",
  failure: "ناموفق",
  denied: "ردشده",
  queued: "در صف",
  cancelled: "لغوشده",
  no_op: "بدون تغییر",
};

export const DOMAIN_LABELS: Record<string, string> = {
  authentication: "ورود و امنیت",
  security: "امنیت",
  users: "کاربران و مدیران",
  wallets: "کیف پول",
  orders: "سفارش‌ها",
  payments: "پرداخت",
  catalog: "محصولات و کاتالوگ",
  discounts: "تخفیف‌ها",
  settings: "تنظیمات",
  content: "محتوا",
  imports: "درون‌ریزی",
  integrations: "یکپارچه‌سازی",
  reports: "گزارش‌ها",
  system: "سامانه",
  legacy: "سوابق قدیمی",
};

const EVENT_TITLES: Record<string, string> = {
  "authentication.login_succeeded": "وارد پنل مدیریت شد",
  "authentication.login_failed": "برای ورود به پنل تلاش ناموفقی داشت",
  "authentication.logout": "از پنل مدیریت خارج شد",
  "authentication.session_revoked": "یک نشست مدیریتی را لغو کرد",
  "security.access_denied": "برای انجام یک عملیات حساس با رد دسترسی روبه‌رو شد",
  "administrators.created": "مدیر جدیدی ایجاد کرد",
  "administrators.updated": "اطلاعات مدیر را تغییر داد",
  "administrators.role_changed": "نقش مدیر را تغییر داد",
  "administrators.access_changed": "دسترسی مدیر را تغییر داد",
  "wallets.adjusted": "موجودی کیف پول را اصلاح کرد",
  "wallets.refunded": "بازپرداخت کیف پول را ثبت کرد",
  "orders.created_by_admin": "یک سفارش دستی ایجاد کرد",
  "orders.updated": "سفارش را ویرایش کرد",
  "orders.status_changed": "وضعیت سفارش را تغییر داد",
  "orders.items_adjusted": "اقلام سفارش را تغییر داد",
  "orders.cancelled": "سفارش را لغو کرد",
  "orders.shipping_changed": "اطلاعات ارسال سفارش را تغییر داد",
  "payments.webhook_processed": "اعلان درگاه پرداخت را پردازش کرد",
  "payments.status_changed": "وضعیت پرداخت را تغییر داد",
  "products.created": "محصول را ایجاد کرد",
  "products.updated": "محصول را ویرایش کرد",
  "products.publication_scheduled": "انتشار محصول را زمان‌بندی کرد",
  "products.publication_rescheduled": "زمان انتشار محصول را تغییر داد",
  "products.publication_cancelled": "زمان‌بندی انتشار محصول را لغو کرد",
  "products.published": "محصول را منتشر کرد",
  "products.unpublished": "انتشار محصول را متوقف کرد",
  "products.publication_executed": "محصول را در زمان تعیین‌شده منتشر کرد",
  "products.trashed": "محصول را به سطل زباله منتقل کرد",
  "products.restored": "محصول را از سطل زباله بازیابی کرد",
  "products.permanently_deleted": "محصول را برای همیشه حذف کرد",
  "products.bulk_requested": "عملیات گروهی روی محصولات را آغاز کرد",
  "products.bulk_completed": "عملیات گروهی روی محصولات را به پایان رساند",
  "imports.requested": "درون‌ریزی محصولات را آغاز کرد",
  "imports.completed": "درون‌ریزی محصولات را به پایان رساند",
  "imports.failed": "درون‌ریزی محصولات را ناموفق به پایان رساند",
  "audit.export_generated": "از گزارش حسابرسی خروجی گرفت",
};

export function auditEventLabel(eventKey: string): string {
  return EVENT_TITLES[eventKey] || "رویداد ثبت‌شده";
}

export function auditTargetTypeLabel(targetType: string): string {
  const labels: Record<string, string> = {
    administrator: "مدیر",
    user: "کاربر",
    customer: "مشتری",
    wallet: "کیف پول",
    order: "سفارش",
    payment: "پرداخت",
    product: "محصول",
    category: "دسته‌بندی",
    discount: "تخفیف",
    setting: "تنظیم",
    import: "درون‌ریزی",
    audit_report: "گزارش حسابرسی",
  };
  return labels[targetType.toLowerCase()] || targetType;
}

function fieldChange(event: AuditEvent, field: string) {
  return event.changes.find((change) => change.field.toLowerCase() === field.toLowerCase());
}

function quoted(value: unknown): string {
  if (value == null || value === "") return "نامشخص";
  return `«${String(value)}»`;
}

export function principalLabel(event: AuditEvent, principal: "actor" | "initiator"): string {
  const value = event[principal];
  return value.label || ACTOR_LABELS[value.type] || ACTOR_LABELS.unknown;
}

export function targetLabel(target: AuditEntityRef | null): string {
  if (!target) return "مورد مربوطه";
  return target.label || (target.id != null ? `#${target.id}` : "مورد مربوطه");
}

export function describeAuditEvent(event: AuditEvent): string {
  if (event.legacy) return event.summaryFa || "فعالیت قدیمی ثبت‌شده";
  const actor = principalLabel(event, "actor");
  const initiator = principalLabel(event, "initiator");
  const target = targetLabel(event.target);
  const actorText = event.actor.type === "human" || event.actor.type === "impersonated_human"
    ? actor
    : ACTOR_LABELS[event.actor.type];
  const initiatedBy = event.actor.type !== "human" && event.initiator.type === "human"
    ? `، به درخواست ${initiator}`
    : "";

  if (event.eventKey === "authentication.login_succeeded") {
    return `${initiator} وارد پنل مدیریت شد؛ ایجاد نشست امن را ${actorText} انجام داد.`;
  }
  if (event.eventKey === "authentication.login_failed") {
    return `${actorText} یک تلاش ناموفق برای ورود به پنل مدیریت را ثبت کرد.`;
  }
  if (event.eventKey === "authentication.session_revoked") {
    return `${actorText} نشست مدیریتی ${target} را لغو کرد${initiatedBy}.`;
  }

  if (event.eventKey === "orders.status_changed") {
    const change = fieldChange(event, "status") || fieldChange(event, "Status");
    if (change) {
      return `${actorText} وضعیت سفارش ${target} را از ${quoted(change.from)} به ${quoted(change.to)} تغییر داد${initiatedBy}.`;
    }
  }
  if (event.eventKey === "wallets.adjusted") {
    return `${actorText} موجودی ${target} را اصلاح کرد${initiatedBy}.`;
  }
  if (event.eventKey === "payments.webhook_processed") {
    const related = event.related ? targetLabel(event.related) : null;
    return `${actorText} تأیید درگاه برای ${related || target} را پردازش کرد و موجودی ${target} را به‌روزرسانی کرد.`;
  }
  if (event.eventKey === "products.publication_executed") {
    return `${actorText} محصول ${target} را در زمان تعیین‌شده منتشر کرد${initiatedBy}.`;
  }
  if (event.eventKey === "imports.completed") {
    const count = event.metadata?.affectedCount ?? event.metadata?.updatedCount;
    return `${actorText}${count != null ? ` ${count} محصول را` : " درون‌ریزی محصولات را"} به‌روزرسانی کرد${initiatedBy}.`;
  }
  const action = EVENT_TITLES[event.eventKey] || event.summaryFa || "فعالیتی را ثبت کرد";
  return `${actorText} ${action}${event.target ? `: ${target}` : ""}${initiatedBy}.`;
}

export function entityHref(target: AuditEntityRef | null): string | null {
  if (!target?.id) return null;
  const id = encodeURIComponent(String(target.id));
  switch (target.type.toLowerCase()) {
    case "order": return `/orders/edit/${id}`;
    case "product": return `/products/${id}`;
    case "user":
    case "customer":
    case "administrator": return `/users/edit/${id}`;
    case "discount": return `/coupons/edit/${id}`;
    default: return null;
  }
}

export function formatAuditTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatAuditValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "بله" : "خیر";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
