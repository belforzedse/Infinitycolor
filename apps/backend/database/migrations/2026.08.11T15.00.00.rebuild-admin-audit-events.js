"use strict";

const { createHash } = require("node:crypto");

const TABLE = "manual_admin_activities";
const LEGACY_TABLE = "admin_activities";
const LOCK_KEY = 827453112;

function stableUuid(namespace, id) {
  const hex = createHash("md5").update(`${namespace}:${id}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}

async function ensureColumn(knex, name, add) {
  if (!(await knex.schema.hasColumn(TABLE, name))) {
    await knex.schema.alterTable(TABLE, (table) => add(table));
  }
}

async function ensureColumns(knex) {
  await ensureColumn(knex, "event_id", (table) => table.string("event_id", 36).nullable());
  await ensureColumn(knex, "schema_version", (table) => table.smallint("schema_version").nullable());
  await ensureColumn(knex, "occurred_at", (table) =>
    table.timestamp("occurred_at", { useTz: true }).nullable(),
  );
  await ensureColumn(knex, "recorded_at", (table) =>
    table.timestamp("recorded_at", { useTz: true }).nullable(),
  );
  await ensureColumn(knex, "event_key", (table) => table.string("event_key", 160).nullable());
  await ensureColumn(knex, "domain", (table) => table.string("domain", 64).nullable());
  await ensureColumn(knex, "operation", (table) => table.string("operation", 64).nullable());
  await ensureColumn(knex, "importance", (table) => table.string("importance", 24).nullable());
  await ensureColumn(knex, "result_status", (table) =>
    table.string("result_status", 24).nullable(),
  );
  await ensureColumn(knex, "initiator_type", (table) =>
    table.string("initiator_type", 32).nullable(),
  );
  await ensureColumn(knex, "initiator_id", (table) => table.string("initiator_id", 160).nullable());
  await ensureColumn(knex, "initiator_label", (table) =>
    table.string("initiator_label", 255).nullable(),
  );
  await ensureColumn(knex, "initiator_role_id", (table) =>
    table.string("initiator_role_id", 80).nullable(),
  );
  await ensureColumn(knex, "initiator_role_name", (table) =>
    table.string("initiator_role_name", 120).nullable(),
  );
  await ensureColumn(knex, "actor_type", (table) => table.string("actor_type", 32).nullable());
  await ensureColumn(knex, "actor_id", (table) => table.string("actor_id", 160).nullable());
  await ensureColumn(knex, "actor_label", (table) => table.string("actor_label", 255).nullable());
  await ensureColumn(knex, "actor_role_id", (table) => table.string("actor_role_id", 80).nullable());
  await ensureColumn(knex, "actor_role_name", (table) =>
    table.string("actor_role_name", 120).nullable(),
  );
  await ensureColumn(knex, "actor_auth_method", (table) =>
    table.string("actor_auth_method", 80).nullable(),
  );
  await ensureColumn(knex, "origin", (table) => table.string("origin", 32).nullable());
  await ensureColumn(knex, "target_type", (table) => table.string("target_type", 80).nullable());
  await ensureColumn(knex, "target_id", (table) => table.string("target_id", 160).nullable());
  await ensureColumn(knex, "target_label", (table) => table.string("target_label", 255).nullable());
  await ensureColumn(knex, "target_snapshot", (table) => table.jsonb("target_snapshot").nullable());
  await ensureColumn(knex, "related_type", (table) => table.string("related_type", 80).nullable());
  await ensureColumn(knex, "related_id", (table) => table.string("related_id", 160).nullable());
  await ensureColumn(knex, "related_label", (table) =>
    table.string("related_label", 255).nullable(),
  );
  await ensureColumn(knex, "related_snapshot", (table) => table.jsonb("related_snapshot").nullable());
  await ensureColumn(knex, "root_event_id", (table) => table.string("root_event_id", 36).nullable());
  await ensureColumn(knex, "parent_event_id", (table) =>
    table.string("parent_event_id", 36).nullable(),
  );
  await ensureColumn(knex, "request_id", (table) => table.string("request_id", 160).nullable());
  await ensureColumn(knex, "interaction_id", (table) =>
    table.string("interaction_id", 36).nullable(),
  );
  await ensureColumn(knex, "correlation_id", (table) =>
    table.string("correlation_id", 160).nullable(),
  );
  await ensureColumn(knex, "causation_id", (table) => table.string("causation_id", 160).nullable());
  await ensureColumn(knex, "trace_id", (table) => table.string("trace_id", 160).nullable());
  await ensureColumn(knex, "job_id", (table) => table.string("job_id", 160).nullable());
  await ensureColumn(knex, "batch_id", (table) => table.string("batch_id", 160).nullable());
  await ensureColumn(knex, "route", (table) => table.string("route", 255).nullable());
  await ensureColumn(knex, "http_method", (table) => table.string("http_method", 16).nullable());
  await ensureColumn(knex, "reason_code", (table) => table.string("reason_code", 120).nullable());
  await ensureColumn(knex, "environment", (table) => table.string("environment", 80).nullable());
  await ensureColumn(knex, "service_name", (table) => table.string("service_name", 120).nullable());
  await ensureColumn(knex, "scope", (table) => table.jsonb("scope").nullable());
  await ensureColumn(knex, "search_text", (table) => table.text("search_text").nullable());
  await ensureColumn(knex, "dedupe_key", (table) => table.string("dedupe_key", 255).nullable());
}

async function hasSingleColumnUniqueIndex(knex, columnName) {
  const result = await knex.raw(
    `SELECT 1
       FROM pg_index AS idx
       JOIN pg_class AS table_class ON table_class.oid = idx.indrelid
       JOIN pg_namespace AS ns ON ns.oid = table_class.relnamespace
       JOIN pg_attribute AS attr
         ON attr.attrelid = table_class.oid
        AND attr.attnum = ANY(idx.indkey)
      WHERE ns.nspname = current_schema()
        AND table_class.relname = ?
        AND attr.attname = ?
        AND idx.indisunique = TRUE
        AND idx.indnkeyatts = 1
      LIMIT 1`,
    [TABLE, columnName],
  );
  return Boolean(result.rows?.[0]);
}

async function ensureUniqueConstraint(knex, columnName, constraintName) {
  if (await hasSingleColumnUniqueIndex(knex, columnName)) return;
  await knex.raw(
    `ALTER TABLE ${TABLE} ADD CONSTRAINT ${constraintName} UNIQUE (${columnName})`,
  );
}

/**
 * Title → event_key for rows whose modern columns were wiped by Strapi schema
 * sync and then recreated by this repair. Exact catalog titleFa/titleEn only —
 * free-form legacy sentences stay schema_version 1 / legacy.activity.
 * Keep in sync with apps/backend/src/audit/catalog.ts.
 */
const CATALOG_TITLE_TO_EVENT_KEY = {
  "تغییرات محصول ذخیره شد": "products.edit_committed",
  "Product edit committed": "products.edit_committed",
  "ویرایش محصول آغاز شد": "products.edit_acquired",
  "Product editing acquired": "products.edit_acquired",
  "دسترسی ویرایش محصول منتقل شد": "products.edit_taken_over",
  "Product editing taken over": "products.edit_taken_over",
  "ذخیره تغییرات محصول رد شد": "products.edit_rejected",
  "Product edit rejected": "products.edit_rejected",
  "ورود موفق": "authentication.login_succeeded",
  "Login succeeded": "authentication.login_succeeded",
  "ورود ناموفق": "authentication.login_failed",
  "Login failed": "authentication.login_failed",
  "خروج از حساب": "authentication.logout",
  "Logged out": "authentication.logout",
  "نشست کاربری لغو شد": "authentication.session_revoked",
  "Session revoked": "authentication.session_revoked",
  "تنظیمات امنیتی تغییر کرد": "authentication.security_changed",
  "Security settings changed": "authentication.security_changed",
  "دسترسی رد شد": "security.access_denied",
  "Access denied": "security.access_denied",
  "مدیر ایجاد شد": "administrators.created",
  "Administrator created": "administrators.created",
  "اطلاعات مدیر تغییر کرد": "administrators.updated",
  "Administrator updated": "administrators.updated",
  "مدیر حذف شد": "administrators.deleted",
  "Administrator deleted": "administrators.deleted",
  "نقش مدیر تغییر کرد": "administrators.role_changed",
  "Administrator role changed": "administrators.role_changed",
  "دسترسی مدیر تغییر کرد": "administrators.access_changed",
  "Administrator access changed": "administrators.access_changed",
  "کاربر ایجاد شد": "customers.created",
  "Customer created": "customers.created",
  "اطلاعات کاربر تغییر کرد": "customers.updated",
  "Customer updated": "customers.updated",
  "وضعیت کاربر تغییر کرد": "customers.status_changed",
  "Customer status changed": "customers.status_changed",
  "کاربر حذف شد": "customers.deleted",
  "Customer deleted": "customers.deleted",
  "کاربر بازیابی شد": "customers.restored",
  "Customer restored": "customers.restored",
  "موجودی کیف پول تغییر کرد": "wallets.adjusted",
  "Wallet balance adjusted": "wallets.adjusted",
  "مبلغ به کیف پول بازگشت": "wallets.refunded",
  "Wallet refund recorded": "wallets.refunded",
  "سفارش دستی ایجاد شد": "orders.created_by_admin",
  "Manual order created": "orders.created_by_admin",
  "سفارش ویرایش شد": "orders.updated",
  "Order updated": "orders.updated",
  "وضعیت سفارش تغییر کرد": "orders.status_changed",
  "Order status changed": "orders.status_changed",
  "یادداشت سفارش ثبت شد": "orders.note_added",
  "Order note added": "orders.note_added",
  "اقلام سفارش تغییر کرد": "orders.items_adjusted",
  "Order items adjusted": "orders.items_adjusted",
  "سفارش لغو شد": "orders.cancelled",
  "Order cancelled": "orders.cancelled",
  "اطلاعات ارسال تغییر کرد": "orders.shipping_changed",
  "Order shipping changed": "orders.shipping_changed",
  "بازپرداخت سفارش ثبت شد": "orders.refund_recorded",
  "Order refund recorded": "orders.refund_recorded",
  "محصول ایجاد شد": "products.created",
  "Product created": "products.created",
  "محصول ویرایش شد": "products.updated",
  "Product updated": "products.updated",
  "محصول حذف شد": "products.deleted",
  "Product deleted": "products.deleted",
  "محصول بازیابی شد": "products.restored",
  "Product restored": "products.restored",
  "محصول به سطل زباله منتقل شد": "products.trashed",
  "Product moved to Trash": "products.trashed",
  "محصول برای همیشه حذف شد": "products.permanently_deleted",
  "Product permanently deleted": "products.permanently_deleted",
  "وضعیت محصول تغییر کرد": "products.status_changed",
  "Product status changed": "products.status_changed",
  "محصول منتشر شد": "products.published",
  "Product published": "products.published",
  "انتشار محصول متوقف شد": "products.unpublished",
  "Product unpublished": "products.unpublished",
  "قیمت محصول تغییر کرد": "products.price_changed",
  "Product price changed": "products.price_changed",
  "موجودی محصول تغییر کرد": "products.inventory_changed",
  "Product inventory changed": "products.inventory_changed",
  "دسته‌بندی ایجاد شد": "categories.created",
  "Category created": "categories.created",
  "دسته‌بندی ویرایش شد": "categories.updated",
  "Category updated": "categories.updated",
  "تنظیمات تغییر کرد": "settings.updated",
  "Settings changed": "settings.updated",
  "وضعیت گزارش مشکل تغییر کرد": "issue_reports.status_changed",
  "Issue report status changed": "issue_reports.status_changed",
  "وضعیت درخواست مدل تغییر کرد": "model_applications.status_changed",
  "Model application status changed": "model_applications.status_changed",
  "خروجی گزارش مشکلات ساخته شد": "issue_reports.export_generated",
  "Issue report export generated": "issue_reports.export_generated",
  "خروجی رویدادهای حسابرسی ساخته شد": "audit.export_generated",
  "Audit export generated": "audit.export_generated",
};

/**
 * Admin titles that carry a per-instance id or free-form wording, so they can
 * only be matched by shape. Every target is a real key from
 * apps/backend/src/audit/catalog.ts. Order matters: SQL CASE takes the first
 * matching arm, and the exact catalog titles are evaluated before these.
 */
const FREEFORM_TITLE_RULES = [
  ["ورژن%", "products.updated"],
  ["رنگ%محصول%", "products.updated"],
  ["موجودی%تغییر یافت", "products.inventory_changed"],
  ["تنظیم کیف پول%", "wallets.adjusted"],
  ["محصول%ایجاد%", "products.created"],
  ["محصول%ویرایش%", "products.updated"],
  ["محصول%بروزرسانی%", "products.updated"],
  ["محصول%حذف%", "products.deleted"],
  ["محصول منتشر%", "products.published"],
  ["انتشار محصول زمان%", "products.publication_scheduled"],
  ["انتشار محصول متوقف%", "products.unpublished"],
  ["Product publication%", "products.publication_executed"],
  ["سفارش%ایجاد%", "orders.created_by_admin"],
  ["سفارش%بروزرسانی%", "orders.updated"],
  ["سفارش%ویرایش%", "orders.updated"],
  ["وضعیت سفارش%", "orders.status_changed"],
  ["قرارداد%", "content.changed"],
  ["%اسلایدر صفحه اصلی%", "settings.updated"],
  ["تنظیمات%", "settings.updated"],
];

/** Exact non-catalog titles emitted by older admin code paths. */
const EXACT_TITLE_RULES = [
  ["Self-profile updated", "administrators.updated"],
  ["User role updated", "administrators.role_changed"],
];

/**
 * domain / operation for every catalog key, as the live writer stamps them from
 * apps/backend/src/audit/catalog.ts. They are NOT derivable from the event key
 * (`products.updated` is domain `catalog`, `administrators.role_changed` is
 * operation `role_change`), and a promoted row that disagrees with the writer
 * splits the activity report's domain filter in two.
 * Kept in sync by src/audit/__tests__/storage-backfill-guard.spec.ts.
 */
const CATALOG_KEY_TO_DOMAIN_OPERATION = {
  "products.edit_committed": ["products", "edit"],
  "products.edit_acquired": ["products", "edit"],
  "products.edit_taken_over": ["products", "edit"],
  "products.edit_rejected": ["products", "edit"],
  "authentication.login_succeeded": ["authentication", "login"],
  "authentication.login_failed": ["authentication", "login"],
  "authentication.logout": ["authentication", "logout"],
  "authentication.session_revoked": ["authentication", "revoke"],
  "authentication.security_changed": ["authentication", "update"],
  "security.access_denied": ["security", "deny"],
  "administrators.created": ["users", "create"],
  "administrators.updated": ["users", "update"],
  "administrators.deleted": ["users", "delete"],
  "administrators.role_changed": ["users", "role_change"],
  "administrators.access_changed": ["users", "access_change"],
  "customers.created": ["users", "create"],
  "customers.updated": ["users", "update"],
  "customers.status_changed": ["users", "status_change"],
  "customers.deleted": ["users", "delete"],
  "customers.restored": ["users", "restore"],
  "wallets.adjusted": ["wallets", "adjust"],
  "wallets.refunded": ["wallets", "refund"],
  "orders.created_by_admin": ["orders", "create"],
  "orders.updated": ["orders", "update"],
  "orders.status_changed": ["orders", "status_change"],
  "orders.note_added": ["orders", "note"],
  "orders.items_adjusted": ["orders", "adjust"],
  "orders.cancelled": ["orders", "cancel"],
  "orders.shipping_changed": ["orders", "shipping"],
  "orders.refund_recorded": ["wallets", "refund"],
  "orders.bulk_requested": ["orders", "bulk"],
  "orders.bulk_completed": ["orders", "bulk"],
  "orders.reserve_group_created": ["orders", "create"],
  "orders.reserve_group_activated": ["orders", "status_change"],
  "orders.reserve_order_attached": ["orders", "update"],
  "orders.reserve_attachment_confirmed": ["orders", "update"],
  "orders.reserve_released_early": ["orders", "status_change"],
  "orders.reserve_released_by_admin": ["orders", "status_change"],
  "orders.reserve_expired": ["orders", "status_change"],
  "orders.reserve_ready_to_fulfill": ["orders", "status_change"],
  "orders.reserve_group_cancelled": ["orders", "cancel"],
  "orders.reserve_shipment_tracked": ["orders", "shipping"],
  "payments.webhook_processed": ["payments", "webhook"],
  "payments.status_changed": ["payments", "status_change"],
  "products.created": ["catalog", "create"],
  "products.updated": ["catalog", "update"],
  "products.deleted": ["catalog", "delete"],
  "products.restored": ["catalog", "restore"],
  "products.trashed": ["catalog", "delete"],
  "products.permanently_deleted": ["catalog", "purge"],
  "products.status_changed": ["catalog", "status_change"],
  "products.publication_scheduled": ["catalog", "schedule"],
  "products.publication_rescheduled": ["catalog", "schedule"],
  "products.publication_cancelled": ["catalog", "cancel"],
  "products.published": ["catalog", "publish"],
  "products.unpublished": ["catalog", "unpublish"],
  "products.publication_executed": ["catalog", "publish"],
  "products.price_changed": ["catalog", "price_change"],
  "products.discount_changed": ["catalog", "discount_change"],
  "products.inventory_changed": ["catalog", "inventory_change"],
  "products.media_changed": ["catalog", "media_change"],
  "products.category_changed": ["catalog", "category_change"],
  "products.duplicated": ["catalog", "duplicate"],
  "products.bulk_requested": ["catalog", "bulk"],
  "products.bulk_completed": ["catalog", "bulk"],
  "categories.created": ["catalog", "create"],
  "categories.updated": ["catalog", "update"],
  "categories.deleted_with_reassignment": ["catalog", "delete"],
  "discounts.created": ["discounts", "create"],
  "discounts.updated": ["discounts", "update"],
  "discounts.deleted": ["discounts", "delete"],
  "content.changed": ["content", "update"],
  "settings.updated": ["settings", "update"],
  "shipping.settings_updated": ["settings", "update"],
  "imports.requested": ["imports", "request"],
  "imports.item_changed": ["imports", "item"],
  "imports.completed": ["imports", "complete"],
  "imports.failed": ["imports", "fail"],
  "integrations.sync_completed": ["integrations", "sync"],
  "reports.export_generated": ["reports", "export"],
  "issue_reports.status_changed": ["support", "status_change"],
  "model_applications.status_changed": ["support", "status_change"],
  "issue_reports.export_generated": ["support", "export"],
  "audit.export_generated": ["security", "export"],
  "system.purge_completed": ["system", "purge"],
  "system.job_completed": ["system", "job"],
  "system.job_failed": ["system", "job"],
  "legacy.activity": ["legacy", "other"],
};

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Shared WHEN arms that infer a canonical event_key from the human-readable
 * columns Strapi schema sync leaves intact. This migration's backfill and the
 * 2026.09.11 repair both consume them, so a re-wipe can never demote a row the
 * repair would have promoted.
 */
function inferenceArmsSql(valueForKey) {
  const entries = Object.entries(CATALOG_TITLE_TO_EVENT_KEY);
  return [
    ...entries.map(([title, key]) => `WHEN title = ${quote(title)} THEN ${quote(valueForKey(key))}`),
    // The catalog's English title lands in `message_en`; there is no `title_en`
    // column on this table and referencing one aborts the whole migration.
    ...entries.map(
      ([title, key]) => `WHEN message_en = ${quote(title)} THEN ${quote(valueForKey(key))}`,
    ),
    ...EXACT_TITLE_RULES.map(
      ([title, key]) => `WHEN title = ${quote(title)} THEN ${quote(valueForKey(key))}`,
    ),
    ...FREEFORM_TITLE_RULES.map(
      ([pattern, key]) => `WHEN title LIKE ${quote(pattern)} THEN ${quote(valueForKey(key))}`,
    ),
  ].join("\n              ");
}

function inferredEventKeyArmsSql() {
  return inferenceArmsSql((key) => key);
}

/** Inferred `domain` (index 0) / `operation` (index 1), as the live writer stamps them. */
function inferredDomainOperationOrNullSql(index) {
  const arms = inferenceArmsSql((key) => CATALOG_KEY_TO_DOMAIN_OPERATION[key][index]);
  return `CASE
              ${arms}
              ELSE NULL
            END`;
}

function catalogTitleCaseSql() {
  return `CASE
              WHEN event_key IS NOT NULL THEN event_key
              ${inferredEventKeyArmsSql()}
              ELSE 'legacy.activity'
            END`;
}

/** Same arms with no fallback: NULL means nothing identifies this as a v2 event. */
function inferredEventKeyOrNullSql() {
  return `CASE
              ${inferredEventKeyArmsSql()}
              ELSE NULL
            END`;
}

async function backfillCanonicalRows(knex) {
  // IMPORTANT: never stamp schema_version=1 / event_key=legacy.activity onto rows
  // that still carry a canonical catalog title (or an already-modern event_key).
  // Strapi schema sync can null modern columns while leaving title/message intact;
  // a prior COALESCE(..., 1) backfill permanently demoted live v2 events and broke
  // /sales/activity filters. True pre-v2 history remains v1 via importLegacyTable.
  const inferredEventKey = catalogTitleCaseSql();
  const inferredIsModern = `(
            (event_key IS NOT NULL AND event_key <> 'legacy.activity')
            OR (${inferredEventKeyOrNullSql()}) IS NOT NULL
          )`;

  await knex.raw(
    `UPDATE ${TABLE}
        SET event_id = COALESCE(event_id,
          substr(md5('manual_admin_activities:' || id::text), 1, 8) || '-' ||
          substr(md5('manual_admin_activities:' || id::text), 9, 4) || '-4' ||
          substr(md5('manual_admin_activities:' || id::text), 14, 3) || '-a' ||
          substr(md5('manual_admin_activities:' || id::text), 18, 3) || '-' ||
          substr(md5('manual_admin_activities:' || id::text), 21, 12)),
            schema_version = COALESCE(schema_version,
              CASE WHEN ${inferredIsModern} THEN 2 ELSE 1 END),
            occurred_at = COALESCE(occurred_at, created_at, NOW()),
            recorded_at = COALESCE(recorded_at, created_at, NOW()),
            event_key = ${inferredEventKey},
            domain = COALESCE(domain, ${inferredDomainOperationOrNullSql(0)},
              lower(COALESCE(resource_type, 'other'))),
            operation = COALESCE(operation, ${inferredDomainOperationOrNullSql(1)},
              lower(COALESCE(action, 'other'))),
            importance = COALESCE(importance,
              CASE WHEN severity IN ('error', 'warning') THEN 'important' ELSE 'normal' END),
            result_status = COALESCE(result_status,
              CASE WHEN severity = 'error' THEN 'failure' ELSE 'success' END),
            initiator_type = COALESCE(initiator_type,
              CASE WHEN performed_by_name IS NOT NULL OR performed_by_role IS NOT NULL
                THEN 'human' ELSE 'unknown' END),
            initiator_label = COALESCE(initiator_label, performed_by_name),
            initiator_role_name = COALESCE(initiator_role_name, performed_by_role),
            actor_type = COALESCE(actor_type,
              CASE WHEN performed_by_name IS NOT NULL OR performed_by_role IS NOT NULL
                THEN 'human' ELSE 'unknown' END),
            actor_label = COALESCE(actor_label, performed_by_name),
            actor_role_name = COALESCE(actor_role_name, performed_by_role),
            origin = COALESCE(origin,
              CASE WHEN ${inferredIsModern} THEN 'admin_ui' ELSE 'legacy' END),
            target_type = COALESCE(target_type, lower(COALESCE(resource_type, 'other'))),
            target_id = COALESCE(target_id, resource_id),
            target_label = COALESCE(target_label, resource_id),
            dedupe_key = COALESCE(dedupe_key,
              CASE WHEN ${inferredIsModern}
                THEN 'repaired:manual_admin_activities:' || id::text
                ELSE 'legacy:manual_admin_activities:' || id::text
              END)
      WHERE schema_version IS NULL OR event_id IS NULL`,
  );

  if (await knex.schema.hasTable("manual_admin_activities_performed_by_links")) {
    await knex.raw(
      `UPDATE ${TABLE} AS audit
          SET initiator_id = COALESCE(audit.initiator_id, links.user_id::text),
              actor_id = COALESCE(audit.actor_id, links.user_id::text),
              initiator_type = CASE WHEN links.user_id IS NOT NULL THEN 'human'
                                    ELSE audit.initiator_type END,
              actor_type = CASE WHEN links.user_id IS NOT NULL THEN 'human'
                                   ELSE audit.actor_type END
         FROM manual_admin_activities_performed_by_links AS links
        WHERE links.manual_admin_activity_id = audit.id
          AND (audit.initiator_id IS NULL OR audit.actor_id IS NULL)`,
    );
  }

  await knex.raw(
    `UPDATE ${TABLE}
        SET root_event_id = COALESCE(root_event_id, event_id),
            search_text = COALESCE(search_text,
              trim(concat_ws(' ', performed_by_name, performed_by_role, resource_type,
                resource_id, title, message, message_en, event_key, correlation_id,
                job_id, batch_id)))
      WHERE root_event_id IS NULL OR search_text IS NULL`,
  );
}

async function importLegacyTable(knex) {
  if (!(await knex.schema.hasTable(LEGACY_TABLE))) return;
  const rows = await knex(LEGACY_TABLE).select("*");
  for (const row of rows) {
    const eventId = stableUuid(LEGACY_TABLE, row.id);
    const resourceType = row.resource_type || "Other";
    const action = row.action || "Other";
    const actorKnown = Boolean(row.performed_by_name || row.performed_by_role);
    const data = {
      event_id: eventId,
      schema_version: 1,
      occurred_at: row.created_at || new Date(),
      recorded_at: row.created_at || new Date(),
      event_key: "legacy.activity",
      domain: String(resourceType).toLowerCase(),
      operation: String(action).toLowerCase(),
      importance: ["error", "warning"].includes(row.severity) ? "important" : "normal",
      result_status: row.severity === "error" ? "failure" : "success",
      initiator_type: actorKnown ? "human" : "unknown",
      initiator_label: row.performed_by_name || null,
      initiator_role_name: row.performed_by_role || null,
      actor_type: actorKnown ? "human" : "unknown",
      actor_label: row.performed_by_name || null,
      actor_role_name: row.performed_by_role || null,
      origin: "legacy",
      target_type: String(resourceType).toLowerCase(),
      target_id: row.resource_id == null ? null : String(row.resource_id),
      target_label: row.resource_id == null ? null : String(row.resource_id),
      root_event_id: eventId,
      dedupe_key: `legacy:${LEGACY_TABLE}:${row.id}`,
      resource_type: resourceType,
      resource_id: row.resource_id == null ? null : String(row.resource_id),
      action,
      title: row.title || null,
      message: row.message || null,
      message_en: row.message_en || null,
      severity: row.severity || "info",
      changes: row.changes || null,
      description: row.description || null,
      metadata: row.metadata || null,
      performed_by_name: row.performed_by_name || null,
      performed_by_role: row.performed_by_role || null,
      ip: row.ip || null,
      user_agent: row.user_agent || null,
      search_text: [
        row.performed_by_name,
        row.performed_by_role,
        resourceType,
        row.resource_id,
        row.title,
        row.message,
      ]
        .filter(Boolean)
        .join(" "),
      created_at: row.created_at || new Date(),
      updated_at: row.updated_at || row.created_at || new Date(),
    };
    const alreadyImported = await knex(TABLE)
      .where({ dedupe_key: data.dedupe_key })
      .first("id");
    if (!alreadyImported) {
      await knex(TABLE).insert(data);
    }
  }
}

async function ensureConstraintsAndIndexes(knex) {
  await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN event_id SET NOT NULL`);
  await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN schema_version SET DEFAULT 2`);
  await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN schema_version SET NOT NULL`);
  await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN occurred_at SET DEFAULT NOW()`);
  await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN occurred_at SET NOT NULL`);
  await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN recorded_at SET DEFAULT NOW()`);
  await knex.raw(`ALTER TABLE ${TABLE} ALTER COLUMN recorded_at SET NOT NULL`);

  // Use real constraints rather than standalone uniquely named indexes. Strapi may
  // reconcile unknown uniqueness during schema sync; a constraint can be inspected
  // or dropped safely, while a same-named standalone index caused startup failure.
  // PostgreSQL unique constraints allow multiple NULL dedupe keys.
  await ensureUniqueConstraint(knex, "event_id", "maa_event_id_unique");
  await ensureUniqueConstraint(knex, "dedupe_key", "maa_dedupe_key_unique");
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS maa_occurred_cursor_idx
       ON ${TABLE} (occurred_at DESC, id DESC)`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS maa_actor_cursor_idx
       ON ${TABLE} (actor_type, actor_id, occurred_at DESC, id DESC)`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS maa_initiator_cursor_idx
       ON ${TABLE} (initiator_type, initiator_id, occurred_at DESC, id DESC)`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS maa_source_cursor_idx
       ON ${TABLE} (origin, occurred_at DESC, id DESC)`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS maa_event_key_cursor_idx
       ON ${TABLE} (domain, event_key, occurred_at DESC, id DESC)`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS maa_target_cursor_idx
       ON ${TABLE} (target_type, target_id, occurred_at DESC, id DESC)`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS maa_correlation_cursor_idx
       ON ${TABLE} (correlation_id, occurred_at DESC, id DESC)`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS maa_root_cursor_idx
       ON ${TABLE} (root_event_id, occurred_at ASC, id ASC)`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS maa_result_cursor_idx
       ON ${TABLE} (result_status, importance, occurred_at DESC, id DESC)`,
  );

  const pgTrgm = await knex("pg_extension").where({ extname: "pg_trgm" }).first("extname");
  if (pgTrgm) {
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS maa_search_trgm_idx
         ON ${TABLE} USING gin (search_text gin_trgm_ops)`,
    );
  } else {
    // Extension installation is an infrastructure privilege. Avoid aborting the migration's
    // transaction when the application role cannot CREATE EXTENSION; bounded ILIKE search still works.
    console.warn("pg_trgm is not installed; audit search will use bounded ILIKE without a GIN index");
  }

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maa_importance_check') THEN
        ALTER TABLE ${TABLE} ADD CONSTRAINT maa_importance_check
          CHECK (importance IN ('normal', 'important', 'sensitive', 'critical'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maa_result_status_check') THEN
        ALTER TABLE ${TABLE} ADD CONSTRAINT maa_result_status_check
          CHECK (result_status IN ('success', 'partial', 'failure', 'denied', 'queued', 'cancelled', 'no_op'));
      END IF;
    END $$;
  `);
}

async function ensureAppendOnlyTrigger(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION infinity_prevent_audit_event_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'Audit events are append-only and cannot be updated or deleted.'
        USING ERRCODE = '55000';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS manual_admin_activities_append_only ON ${TABLE};
    CREATE TRIGGER manual_admin_activities_append_only
      BEFORE UPDATE OR DELETE ON ${TABLE}
      FOR EACH ROW EXECUTE FUNCTION infinity_prevent_audit_event_mutation();
  `);
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (!(await knex.schema.hasTable(TABLE))) return;
    await ensureColumns(knex);
    // The backfill UPDATEs legacy rows, which the append-only trigger installed
    // by a previous run of this migration rejects. `src/audit/storage.ts` re-runs
    // this migration whenever the uniqueness invariant is missing — Strapi's
    // schema sync drops those constraints, because it does not model them — so
    // the re-run must not deadlock against the guarantee it installed itself.
    // Dropping first is safe: `ensureAuditEventStorage` runs this inside a
    // transaction and the advisory lock above serializes concurrent boots, so
    // the table is never reachable without the trigger.
    await knex.raw(`DROP TRIGGER IF EXISTS manual_admin_activities_append_only ON ${TABLE}`);
    await backfillCanonicalRows(knex);
    await importLegacyTable(knex);
    await ensureConstraintsAndIndexes(knex);
    await ensureAppendOnlyTrigger(knex);
  },

  // Forward-only: reverting must never drop or mutate historical audit information.
  async down() {},

  __private: {
    TABLE,
    stableUuid,
    CATALOG_TITLE_TO_EVENT_KEY,
    CATALOG_KEY_TO_DOMAIN_OPERATION,
    FREEFORM_TITLE_RULES,
    EXACT_TITLE_RULES,
    catalogTitleCaseSql,
    inferredEventKeyArmsSql,
    inferredEventKeyOrNullSql,
    inferredDomainOperationOrNullSql,
  },
};
