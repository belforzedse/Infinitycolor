"use strict";

/**
 * Keep migration-owned tables out of Strapi's destructive schema diff.
 *
 * Strapi 4 reads `core_persisted_tables` before removing tables that are not
 * represented by a content type. Recording the tables here lets us retain the
 * default `forceMigration: true` behavior for normal Strapi schema changes
 * without losing the WooCommerce control plane or analytics rollups.
 */

const PERSISTED_TABLES_MIGRATION_LOCK_KEY = 827453104;
const CORE_STORE_TABLE = "strapi_core_store_settings";
const CORE_STORE_KEY = "core_persisted_tables";

const CUSTOM_TABLE_NAMES = Object.freeze([
  "background_job_locks",
  "analytics_refresh_state",
  "analytics_daily_sales",
  "analytics_product_daily",
  "analytics_reconciliation_daily",
  "woocommerce_sync_control",
  "woocommerce_sync_cursors",
  "woocommerce_sync_leases",
  "woocommerce_sync_items",
  "woocommerce_sync_campaigns",
  "woocommerce_sync_metrics",
  "customer_identity_mappings",
]);

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
  throw new Error("core_persisted_tables contains an invalid table entry");
}

function parsePersistedTables(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Unable to parse ${CORE_STORE_KEY}: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${CORE_STORE_KEY} must contain a JSON array`);
  }

  parsed.forEach(persistedTableName);
  return parsed;
}

function addCustomTables(entries) {
  const names = new Set(entries.map(persistedTableName));
  return [
    ...entries,
    ...CUSTOM_TABLE_NAMES.filter((tableName) => !names.has(tableName)),
  ];
}

function removeCustomTables(entries) {
  const customNames = new Set(CUSTOM_TABLE_NAMES);
  return entries.filter((entry) => !customNames.has(persistedTableName(entry)));
}

async function readCoreStoreRow(knex) {
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

  return rows[0] ?? null;
}

async function writeCoreStoreValue(knex, row, entries) {
  const data = {
    value: JSON.stringify(entries),
    type: "object",
  };

  if (row) {
    await knex(CORE_STORE_TABLE).where({ id: row.id }).update(data);
    return;
  }

  await knex(CORE_STORE_TABLE).insert({
    key: CORE_STORE_KEY,
    environment: null,
    tag: null,
    ...data,
  });
}

async function ensureCoreStoreTable(knex) {
  if (await knex.schema.hasTable(CORE_STORE_TABLE)) return;

  // On a brand-new database Strapi runs custom migrations before its first
  // content-type schema sync, so its own core-store table does not exist yet.
  // This mirrors @strapi/strapi's coreStoreModel exactly; the subsequent sync
  // recognizes the table as its own and leaves it in the managed schema.
  await knex.schema.createTable(CORE_STORE_TABLE, (table) => {
    table.increments("id");
    table.string("key").nullable();
    table.text("value").nullable();
    table.string("type").nullable();
    table.string("environment").nullable();
    table.string("tag").nullable();
  });
}

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [PERSISTED_TABLES_MIGRATION_LOCK_KEY]);

    await ensureCoreStoreTable(knex);

    const row = await readCoreStoreRow(knex);
    const existing = row ? parsePersistedTables(row.value) : [];
    await writeCoreStoreValue(knex, row, addCustomTables(existing));
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [PERSISTED_TABLES_MIGRATION_LOCK_KEY]);

    if (!(await knex.schema.hasTable(CORE_STORE_TABLE))) return;

    const row = await readCoreStoreRow(knex);
    if (!row) return;

    const existing = parsePersistedTables(row.value);
    await writeCoreStoreValue(knex, row, removeCustomTables(existing));
  },

  __private: {
    CUSTOM_TABLE_NAMES,
    addCustomTables,
    ensureCoreStoreTable,
    parsePersistedTables,
    removeCustomTables,
  },
};
