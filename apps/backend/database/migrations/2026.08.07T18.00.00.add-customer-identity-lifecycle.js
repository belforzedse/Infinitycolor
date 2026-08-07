"use strict";

const LOCK_KEY = 827453109;
const CORE_STORE_TABLE = "strapi_core_store_settings";
const CORE_STORE_KEY = "core_persisted_tables";
const MAPPING_TABLE = "customer_identity_mappings";

function persistedName(entry) {
  return typeof entry === "string" ? entry : entry?.name;
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

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);

    if (!(await knex.schema.hasColumn("users", "account_origin"))) {
      await knex.schema.alterTable("users", (table) => {
        table.string("account_origin", 32).notNullable().defaultTo("Native");
        table.timestamp("claimed_at", { useTz: true }).nullable();
        table.timestamp("profile_completed_at", { useTz: true }).nullable();
        table.boolean("profile_managed_by_customer").notNullable().defaultTo(true);
        table.timestamp("source_created_at", { useTz: true }).nullable();
        table.timestamp("source_updated_at", { useTz: true }).nullable();
        table.check(
          "account_origin IN ('Native', 'WooRegistered', 'WooGuest')",
          [],
          "users_account_origin_check",
        );
      });
    }

    if (!(await knex.schema.hasTable(MAPPING_TABLE))) {
      await knex.schema.createTable(MAPPING_TABLE, (table) => {
        table.bigIncrements("id").primary();
        table.string("source_system", 32).notNullable();
        table.string("source_kind", 32).notNullable();
        table.string("source_key", 128).notNullable();
        table.bigInteger("user_id").notNullable().references("id").inTable("users").onDelete("RESTRICT");
        table.string("match_reason", 64).notNullable();
        table.timestamp("first_seen_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.timestamp("last_seen_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
        table.unique(
          ["source_system", "source_kind", "source_key"],
          { indexName: "uq_customer_identity_source" },
        );
        table.index(["user_id"], "idx_customer_identity_user");
        table.check(
          "source_kind IN ('customer', 'guest-phone')",
          [],
          "customer_identity_source_kind_check",
        );
      });
    }

    await ensureCoreStoreTable(knex);
    const coreRows = await knex(CORE_STORE_TABLE)
      .select("id", "value")
      .where({ key: CORE_STORE_KEY })
      .whereNull("environment")
      .whereNull("tag")
      .forUpdate();
    if (coreRows.length > 1) throw new Error(`Multiple ${CORE_STORE_KEY} rows exist`);
    const coreRow = coreRows[0] || null;
    const persisted = coreRow?.value ? JSON.parse(coreRow.value) : [];
    if (!Array.isArray(persisted)) throw new Error(`${CORE_STORE_KEY} must contain a JSON array`);
    if (!persisted.some((entry) => persistedName(entry) === MAPPING_TABLE)) {
      const value = JSON.stringify([...persisted, MAPPING_TABLE]);
      if (coreRow) await knex(CORE_STORE_TABLE).where({ id: coreRow.id }).update({ value });
      else {
        await knex(CORE_STORE_TABLE).insert({
          key: CORE_STORE_KEY,
          environment: null,
          tag: null,
          type: "object",
          value,
        });
      }
    }

    await knex("users")
      .where({ external_source: "wordpress" })
      .update({
        account_origin: "WooRegistered",
        profile_managed_by_customer: false,
      });
    const authLinks = await knex("information_schema.tables")
      .where({ table_schema: "auth", table_name: "strapi_identity_links" })
      .first();
    if (authLinks) {
      await knex("users")
        .whereIn("id", knex.withSchema("auth").select("strapi_user_id").from("strapi_identity_links"))
        .update({
          claimed_at: knex.raw("COALESCE(claimed_at, now())"),
          profile_completed_at: knex.raw("COALESCE(profile_completed_at, now())"),
          profile_managed_by_customer: true,
          is_verified: true,
        });
    }
  },

  async down(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    if (await knex.schema.hasTable(MAPPING_TABLE)) await knex.schema.dropTable(MAPPING_TABLE);
    if (await knex.schema.hasTable(CORE_STORE_TABLE)) {
      const coreRows = await knex(CORE_STORE_TABLE)
        .select("id", "value")
        .where({ key: CORE_STORE_KEY })
        .whereNull("environment")
        .whereNull("tag")
        .forUpdate();
      if (coreRows.length > 1) throw new Error(`Multiple ${CORE_STORE_KEY} rows exist`);
      const coreRow = coreRows[0] || null;
      if (coreRow?.value) {
        const persisted = JSON.parse(coreRow.value);
        if (!Array.isArray(persisted)) throw new Error(`${CORE_STORE_KEY} must contain a JSON array`);
        await knex(CORE_STORE_TABLE).where({ id: coreRow.id }).update({
          value: JSON.stringify(persisted.filter((entry) => persistedName(entry) !== MAPPING_TABLE)),
        });
      }
    }
    if (await knex.schema.hasColumn("users", "account_origin")) {
      await knex.schema.alterTable("users", (table) => {
        table.dropColumn("source_updated_at");
        table.dropColumn("source_created_at");
        table.dropColumn("profile_managed_by_customer");
        table.dropColumn("profile_completed_at");
        table.dropColumn("claimed_at");
        table.dropColumn("account_origin");
      });
    }
  },
};
