"use strict";

/**
 * Durable, provider-neutral analytics delivery ledger.
 *
 * Commerce remains authoritative. A successful settlement/refund records one
 * outbox row adjacent to that state transition; a maintenance worker delivers
 * the row to Umami and retries it independently. The unique key is deliberate:
 * a replayed gateway callback or repair sweep can never create a second
 * purchase/refund event for the same commerce source.
 */

const LOCK_KEY = 827453105;
const CORE_STORE_TABLE = "strapi_core_store_settings";
const CORE_STORE_KEY = "core_persisted_tables";
const OUTBOX_TABLE = "analytics_outbox";

function persistedTableName(entry) {
  if (typeof entry === "string" && entry.length > 0) return entry;
  if (
    entry &&
    typeof entry === "object" &&
    typeof entry.name === "string" &&
    entry.name.length > 0
  ) {
    return entry.name;
  }
  throw new Error(`${CORE_STORE_KEY} contains an invalid table entry`);
}

function addOutboxPersistence(entries) {
  if (!Array.isArray(entries)) {
    throw new Error(`${CORE_STORE_KEY} must contain a JSON array`);
  }
  const names = entries.map(persistedTableName);
  return names.includes(OUTBOX_TABLE) ? entries : [...entries, OUTBOX_TABLE];
}

async function ensureCoreStoreTable(knex) {
  if (await knex.schema.hasTable(CORE_STORE_TABLE)) return;
  await knex.schema.createTable(CORE_STORE_TABLE, (table) => {
    table.increments("id");
    table.string("key").nullable();
    table.text("value").nullable();
    table.string("type").nullable();
    table.string("environment").nullable();
    table.string("tag").nullable();
  });
}

async function ensureOutboxPersistence(knex) {
  await ensureCoreStoreTable(knex);
  const rows = await knex(CORE_STORE_TABLE)
    .select("id", "value")
    .where({ key: CORE_STORE_KEY })
    .whereNull("environment")
    .whereNull("tag")
    .orderBy("id", "asc")
    .forUpdate();
  if (rows.length > 1) {
    throw new Error(`Multiple ${CORE_STORE_KEY} rows exist; refusing an ambiguous update`);
  }

  const row = rows[0] || null;
  let existing = [];
  if (row?.value) {
    try {
      existing = JSON.parse(row.value);
    } catch (error) {
      throw new Error(`Unable to parse ${CORE_STORE_KEY}: ${error.message}`);
    }
  }
  const value = JSON.stringify(addOutboxPersistence(existing));
  if (row) {
    await knex(CORE_STORE_TABLE).where({ id: row.id }).update({ value, type: "object" });
  } else {
    await knex(CORE_STORE_TABLE).insert({
      key: CORE_STORE_KEY,
      environment: null,
      tag: null,
      type: "object",
      value,
    });
  }
}

async function removeOutboxPersistence(knex) {
  if (!(await knex.schema.hasTable(CORE_STORE_TABLE))) return;
  const rows = await knex(CORE_STORE_TABLE)
    .select("id", "value")
    .where({ key: CORE_STORE_KEY })
    .whereNull("environment")
    .whereNull("tag")
    .orderBy("id", "asc")
    .forUpdate();
  if (rows.length > 1) {
    throw new Error(`Multiple ${CORE_STORE_KEY} rows exist; refusing an ambiguous update`);
  }
  const row = rows[0] || null;
  if (!row?.value) return;
  let existing;
  try {
    existing = JSON.parse(row.value);
  } catch (error) {
    throw new Error(`Unable to parse ${CORE_STORE_KEY}: ${error.message}`);
  }
  if (!Array.isArray(existing)) {
    throw new Error(`${CORE_STORE_KEY} must contain a JSON array`);
  }
  const value = JSON.stringify(
    existing.filter((entry) => persistedTableName(entry) !== OUTBOX_TABLE),
  );
  await knex(CORE_STORE_TABLE).where({ id: row.id }).update({ value, type: "object" });
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    // Persistence must be recorded before Strapi's schema reconciliation. An
    // upgrade that creates an unknown table first can have that table removed
    // later in the same boot, after this migration has already been recorded.
    await ensureOutboxPersistence(knex);

    if (!(await knex.schema.hasTable(OUTBOX_TABLE))) {
      await knex.schema.createTable(OUTBOX_TABLE, (table) => {
        table.bigIncrements("id").primary();
        table.string("website_id", 160).notNullable();
        table.string("event_type", 64).notNullable();
        table.string("source_type", 96).notNullable();
        table.string("source_id", 160).notNullable();
        table.jsonb("payload").notNullable();
        table.string("status", 24).notNullable().defaultTo("pending");
        table.integer("attempt_count").notNullable().defaultTo(0);
        table.timestamp("available_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("processing_started_at", { useTz: true }).nullable();
        table.timestamp("sent_at", { useTz: true }).nullable();
        table.timestamp("dead_lettered_at", { useTz: true }).nullable();
        table.text("last_error").nullable();
        table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.unique(["website_id", "event_type", "source_type", "source_id"], {
          indexName: "uq_analytics_outbox_source",
        });
        table.check(
          "status IN ('pending', 'processing', 'sent', 'dead_letter')",
          [],
          "analytics_outbox_status",
        );
      });
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_analytics_outbox_due
         ON analytics_outbox (status, available_at, id)`,
      );
      await knex.raw(
        `CREATE INDEX IF NOT EXISTS idx_analytics_outbox_source
         ON analytics_outbox (source_type, source_id)`,
      );
    }

    if (await knex.schema.hasTable("orders")) {
      const hasCorrelation = await knex.schema.hasColumn("orders", "analytics_correlation_id");
      if (!hasCorrelation) {
        await knex.schema.alterTable("orders", (table) => {
          table.string("analytics_correlation_id", 160).nullable();
        });
        await knex.raw(
          `CREATE INDEX IF NOT EXISTS idx_orders_analytics_correlation
           ON orders (analytics_correlation_id)`,
        );
      }
    }
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    await knex.schema.dropTableIfExists(OUTBOX_TABLE);
    if (await knex.schema.hasTable("orders")) {
      const hasCorrelation = await knex.schema.hasColumn("orders", "analytics_correlation_id");
      if (hasCorrelation) {
        await knex.schema.alterTable("orders", (table) => {
          table.dropColumn("analytics_correlation_id");
        });
      }
    }
    await removeOutboxPersistence(knex);
  },

  __private: {
    OUTBOX_TABLE,
    addOutboxPersistence,
    ensureOutboxPersistence,
    persistedTableName,
    removeOutboxPersistence,
  },
};
