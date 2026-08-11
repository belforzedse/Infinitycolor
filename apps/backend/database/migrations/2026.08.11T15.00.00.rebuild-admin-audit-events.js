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

async function backfillCanonicalRows(knex) {
  await knex.raw(
    `UPDATE ${TABLE}
        SET event_id = COALESCE(event_id,
          substr(md5('manual_admin_activities:' || id::text), 1, 8) || '-' ||
          substr(md5('manual_admin_activities:' || id::text), 9, 4) || '-4' ||
          substr(md5('manual_admin_activities:' || id::text), 14, 3) || '-a' ||
          substr(md5('manual_admin_activities:' || id::text), 18, 3) || '-' ||
          substr(md5('manual_admin_activities:' || id::text), 21, 12)),
            schema_version = COALESCE(schema_version, 1),
            occurred_at = COALESCE(occurred_at, created_at, NOW()),
            recorded_at = COALESCE(recorded_at, created_at, NOW()),
            event_key = COALESCE(event_key, 'legacy.activity'),
            domain = COALESCE(domain, lower(COALESCE(resource_type, 'other'))),
            operation = COALESCE(operation, lower(COALESCE(action, 'other'))),
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
            origin = COALESCE(origin, 'legacy'),
            target_type = COALESCE(target_type, lower(COALESCE(resource_type, 'other'))),
            target_id = COALESCE(target_id, resource_id),
            target_label = COALESCE(target_label, resource_id),
            dedupe_key = COALESCE(dedupe_key, 'legacy:manual_admin_activities:' || id::text)
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
    await backfillCanonicalRows(knex);
    await importLegacyTable(knex);
    await ensureConstraintsAndIndexes(knex);
    await ensureAppendOnlyTrigger(knex);
  },

  // Forward-only: reverting must never drop or mutate historical audit information.
  async down() {},

  __private: { TABLE, stableUuid },
};
