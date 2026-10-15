"use strict";

const latinCase = require("./order-search-latin-case.json");
const TABLE = "order_delivery_snapshots";
const LOCK_KEY = 827453138;
// Match JavaScript whitespace, including NBSP and BOM, without changing SKU interiors.
const SPACE_CONTENT = "[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const SPACE_CLASS = `[${SPACE_CONTENT}]`;

async function registerSnapshotTable(knex) {
  const store = "strapi_core_store_settings";
  if (!(await knex.schema.hasTable(store))) {
    await knex.schema.createTable(store, (t) => {
      t.increments("id");
      t.string("key");
      t.text("value");
      t.string("type");
      t.string("environment");
      t.string("tag");
    });
  }
  const rows = await knex(store)
    .select("id", "value")
    .where({ key: "core_persisted_tables" })
    .whereNull("environment")
    .whereNull("tag")
    .forUpdate();
  if (rows.length > 1) throw new Error("Ambiguous core_persisted_tables");
  const entries = rows[0]?.value ? JSON.parse(rows[0].value) : [];
  if (
    !Array.isArray(entries) ||
    entries.some((entry) => !(typeof entry === "string" || typeof entry?.name === "string"))
  ) {
    throw new Error("Invalid core_persisted_tables");
  }
  if (entries.some((entry) => (typeof entry === "string" ? entry : entry.name) === TABLE)) return;
  const value = JSON.stringify([...entries, TABLE]);
  if (rows[0]) await knex(store).where({ id: rows[0].id }).update({ value, type: "object" });
  else
    await knex(store).insert({
      key: "core_persisted_tables",
      type: "object",
      value,
      environment: null,
      tag: null,
    });
}

// translate handles one-to-one pairs; replace handles mappings such as dotted
// capital I -> lowercase i plus combining dot. Both use the same fixed table as JS.
function normalizedLatinSql(expression) {
  const quote = (value) => value.replace(/'/g, "''");
  for (const [upper, lower] of latinCase.multiple)
    expression = `replace(${expression}, '${quote(upper)}', '${quote(lower)}')`;
  return `translate(${expression}, '${quote("يىك" + latinCase.upper)}', '${quote("ییک" + latinCase.lower)}')`;
}

async function ensureStorage(knex) {
  // Bind nested function references at definition time. PostgreSQL 17 builds
  // indexes with search_path=pg_catalog,pg_temp, excluding the app schema.
  await knex.raw(`CREATE OR REPLACE FUNCTION infinity_order_digits(value text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN translate(coalesce(value, ''), '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789')`);
  await knex.raw(`CREATE OR REPLACE FUNCTION infinity_order_sku(value text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN regexp_replace(infinity_order_digits(normalize(coalesce(value, ''), NFC)), '^${SPACE_CLASS}+|${SPACE_CLASS}+$', '', 'g')`);
  await knex.raw(`CREATE OR REPLACE FUNCTION infinity_order_postal(value text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN regexp_replace(infinity_order_digits(coalesce(value, '')), '[${SPACE_CONTENT}-]+', '', 'g')`);
  await knex.raw(`CREATE OR REPLACE FUNCTION infinity_order_address(value text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN btrim(regexp_replace(${normalizedLatinSql("infinity_order_digits(normalize(coalesce(value, ''), NFKC))")}, '[${SPACE_CONTENT}‌]+', ' ', 'g'))`);
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, (t) => {
      t.integer("order_id").primary();
      t.text("capture_source").notNullable().defaultTo("unknown");
      t.integer("address_id").nullable();
      t.integer("city_id").nullable();
      t.integer("province_id").nullable();
      for (const column of [
        "city_title",
        "province_title",
        "full_address",
        "description",
        "postal_code",
        "recipient_name",
        "recipient_phone",
      ])
        t.text(column).nullable();
      t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }
  if (!(await knex.schema.hasColumn(TABLE, "capture_source"))) {
    await knex.schema.alterTable(TABLE, (t) =>
      t.text("capture_source").notNullable().defaultTo("unknown"),
    );
  }
  // Strapi reconciles indexes on content-type tables at boot. Restore these
  // expression indexes after sync too; no historical row is rewritten.
  await knex.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_order_snapshot_city ON ${TABLE} (city_id, order_id)`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_order_snapshot_postal ON ${TABLE} (infinity_order_postal(postal_code), order_id)`,
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_order_snapshot_address ON ${TABLE} USING gin (infinity_order_address(full_address) gin_trgm_ops)`,
  );
  if (await knex.schema.hasTable("local_user_addresses")) {
    await knex.raw(
      "CREATE INDEX IF NOT EXISTS idx_order_legacy_postal ON local_user_addresses (infinity_order_postal(postal_code), id)",
    );
    await knex.raw(
      "CREATE INDEX IF NOT EXISTS idx_order_legacy_address ON local_user_addresses USING gin (infinity_order_address(full_address) gin_trgm_ops)",
    );
  }
  if (await knex.schema.hasTable("order_items")) {
    await knex.raw(
      "CREATE INDEX IF NOT EXISTS idx_order_item_snapshot_sku ON order_items (infinity_order_sku(product_sku), id)",
    );
  }
}

module.exports = { TABLE, LOCK_KEY, registerSnapshotTable, ensureStorage };
