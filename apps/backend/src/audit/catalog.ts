import type { AuditImportance, AuditResult } from "./types";

export interface AuditEventDefinition {
  domain: string;
  operation: string;
  importance: AuditImportance;
  titleFa: string;
  titleEn: string;
}

const definition = (
  domain: string,
  operation: string,
  titleFa: string,
  titleEn: string,
  importance: AuditImportance = "normal",
): AuditEventDefinition => ({ domain, operation, importance, titleFa, titleEn });

export const AUDIT_EVENT_CATALOG = {
  "authentication.login_succeeded": definition("authentication", "login", "ورود موفق", "Login succeeded", "important"),
  "authentication.login_failed": definition("authentication", "login", "ورود ناموفق", "Login failed", "important"),
  "authentication.logout": definition("authentication", "logout", "خروج از حساب", "Logged out"),
  "authentication.session_revoked": definition("authentication", "revoke", "نشست کاربری لغو شد", "Session revoked", "important"),
  "authentication.security_changed": definition("authentication", "update", "تنظیمات امنیتی تغییر کرد", "Security settings changed", "sensitive"),
  "security.access_denied": definition("security", "deny", "دسترسی رد شد", "Access denied", "sensitive"),
  "administrators.created": definition("users", "create", "مدیر ایجاد شد", "Administrator created", "sensitive"),
  "administrators.updated": definition("users", "update", "اطلاعات مدیر تغییر کرد", "Administrator updated", "sensitive"),
  "administrators.deleted": definition("users", "delete", "مدیر حذف شد", "Administrator deleted", "critical"),
  "administrators.role_changed": definition("users", "role_change", "نقش مدیر تغییر کرد", "Administrator role changed", "critical"),
  "administrators.access_changed": definition("users", "access_change", "دسترسی مدیر تغییر کرد", "Administrator access changed", "critical"),
  "customers.created": definition("users", "create", "کاربر ایجاد شد", "Customer created"),
  "customers.updated": definition("users", "update", "اطلاعات کاربر تغییر کرد", "Customer updated"),
  "customers.status_changed": definition("users", "status_change", "وضعیت کاربر تغییر کرد", "Customer status changed", "important"),
  "customers.deleted": definition("users", "delete", "کاربر حذف شد", "Customer deleted", "sensitive"),
  "customers.restored": definition("users", "restore", "کاربر بازیابی شد", "Customer restored", "important"),
  "wallets.adjusted": definition("wallets", "adjust", "موجودی کیف پول تغییر کرد", "Wallet balance adjusted", "critical"),
  "wallets.refunded": definition("wallets", "refund", "مبلغ به کیف پول بازگشت", "Wallet refund recorded", "critical"),
  "orders.created_by_admin": definition("orders", "create", "سفارش دستی ایجاد شد", "Manual order created", "important"),
  "orders.updated": definition("orders", "update", "سفارش ویرایش شد", "Order updated", "important"),
  "orders.status_changed": definition("orders", "status_change", "وضعیت سفارش تغییر کرد", "Order status changed", "important"),
  "orders.note_added": definition("orders", "note", "یادداشت سفارش ثبت شد", "Order note added"),
  "orders.items_adjusted": definition("orders", "adjust", "اقلام سفارش تغییر کرد", "Order items adjusted", "important"),
  "orders.cancelled": definition("orders", "cancel", "سفارش لغو شد", "Order cancelled", "important"),
  "orders.shipping_changed": definition("orders", "shipping", "اطلاعات ارسال تغییر کرد", "Order shipping changed", "important"),
  "orders.refund_recorded": definition("wallets", "refund", "بازپرداخت سفارش ثبت شد", "Order refund recorded", "critical"),
  "orders.bulk_requested": definition("orders", "bulk", "عملیات گروهی سفارش‌ها آغاز شد", "Order bulk operation requested", "important"),
  "orders.bulk_completed": definition("orders", "bulk", "عملیات گروهی سفارش‌ها پایان یافت", "Order bulk operation completed", "important"),
  "orders.reserve_group_created": definition("orders", "create", "گروه ارسال رزروی ایجاد شد", "Reserve group created"),
  "orders.reserve_group_activated": definition("orders", "status_change", "مهلت ۴۸ ساعته رزرو آغاز شد", "Reserve window activated", "important"),
  "orders.reserve_order_attached": definition("orders", "update", "سفارش به گروه رزروی افزوده شد", "Order attached to reserve group", "important"),
  "orders.reserve_attachment_confirmed": definition("orders", "update", "پرداخت سفارش پیوست‌شده تایید شد", "Reserve attachment payment confirmed", "important"),
  "orders.reserve_released_early": definition("orders", "status_change", "مشتری رزرو را زودتر آزاد کرد", "Reserve released early by customer", "important"),
  "orders.reserve_released_by_admin": definition("orders", "status_change", "مدیر رزرو را آزاد کرد", "Reserve released by admin", "important"),
  "orders.reserve_expired": definition("orders", "status_change", "مهلت رزرو پایان یافت", "Reserve window expired", "important"),
  "orders.reserve_ready_to_fulfill": definition("orders", "status_change", "گروه رزروی آماده ارسال شد", "Reserve group ready to fulfill", "important"),
  "orders.reserve_group_cancelled": definition("orders", "cancel", "گروه رزروی لغو شد", "Reserve group cancelled", "important"),
  "orders.reserve_shipment_tracked": definition("orders", "shipping", "بارکد ارسال گروه رزروی ثبت شد", "Reserve group shipment tracked", "important"),
  "payments.webhook_processed": definition("payments", "webhook", "اعلان درگاه پردازش شد", "Payment webhook processed", "important"),
  "payments.status_changed": definition("payments", "status_change", "وضعیت پرداخت تغییر کرد", "Payment status changed", "important"),
  "products.created": definition("catalog", "create", "محصول ایجاد شد", "Product created"),
  "products.updated": definition("catalog", "update", "محصول ویرایش شد", "Product updated"),
  "products.deleted": definition("catalog", "delete", "محصول حذف شد", "Product deleted", "important"),
  "products.restored": definition("catalog", "restore", "محصول بازیابی شد", "Product restored", "important"),
  "products.status_changed": definition("catalog", "status_change", "وضعیت محصول تغییر کرد", "Product status changed", "important"),
  "products.publication_scheduled": definition("catalog", "schedule", "انتشار محصول زمان‌بندی شد", "Product publication scheduled", "important"),
  "products.publication_rescheduled": definition("catalog", "schedule", "زمان انتشار محصول دوباره تنظیم شد", "Product publication rescheduled", "important"),
  "products.publication_cancelled": definition("catalog", "cancel", "زمان‌بندی انتشار محصول لغو شد", "Product publication schedule cancelled", "important"),
  "products.published": definition("catalog", "publish", "محصول منتشر شد", "Product published", "important"),
  "products.unpublished": definition("catalog", "unpublish", "انتشار محصول متوقف شد", "Product unpublished", "important"),
  "products.publication_executed": definition("catalog", "publish", "انتشار زمان‌بندی‌شده انجام شد", "Scheduled publication executed", "important"),
  "products.price_changed": definition("catalog", "price_change", "قیمت محصول تغییر کرد", "Product price changed", "important"),
  "products.discount_changed": definition("catalog", "discount_change", "تخفیف محصول تغییر کرد", "Product discount changed", "important"),
  "products.inventory_changed": definition("catalog", "inventory_change", "موجودی محصول تغییر کرد", "Product inventory changed", "important"),
  "products.media_changed": definition("catalog", "media_change", "رسانه محصول تغییر کرد", "Product media changed"),
  "products.category_changed": definition("catalog", "category_change", "دسته‌بندی محصول تغییر کرد", "Product category changed"),
  "products.duplicated": definition("catalog", "duplicate", "محصول تکثیر شد", "Product duplicated"),
  "products.bulk_requested": definition("catalog", "bulk", "عملیات گروهی محصولات آغاز شد", "Product bulk operation requested", "important"),
  "products.bulk_completed": definition("catalog", "bulk", "عملیات گروهی محصولات پایان یافت", "Product bulk operation completed", "important"),
  "categories.created": definition("catalog", "create", "دسته‌بندی ایجاد شد", "Category created"),
  "categories.updated": definition("catalog", "update", "دسته‌بندی ویرایش شد", "Category updated"),
  "categories.deleted_with_reassignment": definition("catalog", "delete", "دسته‌بندی حذف و محصولات منتقل شدند", "Category deleted and products reassigned", "important"),
  "discounts.created": definition("discounts", "create", "تخفیف ایجاد شد", "Discount created", "important"),
  "discounts.updated": definition("discounts", "update", "تخفیف تغییر کرد", "Discount updated", "important"),
  "discounts.deleted": definition("discounts", "delete", "تخفیف حذف شد", "Discount deleted", "important"),
  "content.changed": definition("content", "update", "محتوا تغییر کرد", "Content changed"),
  "settings.updated": definition("settings", "update", "تنظیمات تغییر کرد", "Settings changed", "important"),
  "shipping.settings_updated": definition("settings", "update", "تنظیمات ارسال تغییر کرد", "Shipping settings changed", "important"),
  "imports.requested": definition("imports", "request", "درون‌ریزی آغاز شد", "Import requested", "important"),
  "imports.item_changed": definition("imports", "item", "یک مورد درون‌ریزی تغییر کرد", "Imported item changed"),
  "imports.completed": definition("imports", "complete", "درون‌ریزی پایان یافت", "Import completed", "important"),
  "imports.failed": definition("imports", "fail", "درون‌ریزی ناموفق بود", "Import failed", "important"),
  "integrations.sync_completed": definition("integrations", "sync", "همگام‌سازی پایان یافت", "Synchronization completed", "important"),
  "reports.export_generated": definition("reports", "export", "خروجی گزارش ساخته شد", "Report export generated", "sensitive"),
  "issue_reports.status_changed": definition("support", "status_change", "وضعیت گزارش مشکل تغییر کرد", "Issue report status changed", "important"),
  "model_applications.status_changed": definition("support", "status_change", "وضعیت درخواست مدل تغییر کرد", "Model application status changed", "important"),
  "issue_reports.export_generated": definition("support", "export", "خروجی گزارش مشکلات ساخته شد", "Issue report export generated", "sensitive"),
  "audit.export_generated": definition("security", "export", "خروجی رویدادهای حسابرسی ساخته شد", "Audit export generated", "critical"),
  "system.purge_completed": definition("system", "purge", "پاک‌سازی سیستمی پایان یافت", "System purge completed", "critical"),
  "system.job_completed": definition("system", "job", "کار پس‌زمینه پایان یافت", "Background job completed"),
  "system.job_failed": definition("system", "job", "کار پس‌زمینه ناموفق بود", "Background job failed", "important"),
  "legacy.activity": definition("legacy", "other", "فعالیت قدیمی", "Legacy activity"),
} as const satisfies Record<string, AuditEventDefinition>;

export type AuditEventKey = keyof typeof AUDIT_EVENT_CATALOG | (string & {});

export function resolveAuditDefinition(eventKey: string): AuditEventDefinition {
  const known = (AUDIT_EVENT_CATALOG as Record<string, AuditEventDefinition>)[eventKey];
  if (known) return known;
  const [domain = "other", ...parts] = eventKey.split(".");
  return definition(domain, parts.at(-1) || "other", "فعالیت ثبت شد", "Activity recorded");
}

export function resultLabelFa(result: AuditResult): string {
  return ({ success: "موفق", partial: "ناقص", failure: "ناموفق", denied: "ردشده", queued: "در صف", cancelled: "لغوشده", no_op: "بدون تغییر" })[result];
}
