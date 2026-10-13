"use strict";

const TABLE = "product_edit_leases";

async function retainCatalogEditTable(knex) {
  const store = await knex("strapi_core_store_settings")
    .where({ key: "core_persisted_tables" }).whereNull("environment").whereNull("tag")
    .forUpdate().first();
  const entries = store ? JSON.parse(store.value) : [];
  if (!Array.isArray(entries)) throw new Error("Invalid persisted table registry");
  if (!entries.some((entry) => (typeof entry === "string" ? entry : entry.name) === TABLE)) {
    entries.push(TABLE);
    const data = { value: JSON.stringify(entries), type: "object" };
    if (store) await knex("strapi_core_store_settings").where({ id: store.id }).update(data);
    else await knex("strapi_core_store_settings").insert({
      key: "core_persisted_tables", environment: null, tag: null, ...data,
    });
  }
}

async function ensureCatalogEditStorage(knex) {
  if (!(await knex.schema.hasTable(TABLE))) {
    await knex.schema.createTable(TABLE, (table) => {
      table.integer("product_id").primary();
      table.bigInteger("generation").notNullable().defaultTo(0);
      table.integer("owner_id").nullable();
      table.string("owner_label", 255).nullable();
      table.string("session_id", 128).nullable();
      table.string("editor_instance_id", 36).nullable();
      table.string("token_hash", 64).nullable();
      table.timestamp("acquired_at", { useTz: true }).nullable();
      table.timestamp("expires_at", { useTz: true }).nullable();
    });
  }
  for (const [table, column] of [["products", "edit_revision"], ["product_stocks", "stock_revision"], ["settings", "homepage_products_revision"]]) {
    if (await knex.schema.hasTable(table) && !(await knex.schema.hasColumn(table, column))) {
      await knex.schema.alterTable(table, (definition) => definition.integer(column).notNullable().defaultTo(0));
    }
  }
  if (await knex.schema.hasTable("product_stocks")) {
    await knex.raw(`CREATE OR REPLACE FUNCTION infinity_advance_stock_revision()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.count IS DISTINCT FROM OLD.count OR NEW.reserved_count IS DISTINCT FROM OLD.reserved_count THEN
          NEW.stock_revision := COALESCE(OLD.stock_revision, 0) + 1;
        ELSE
          NEW.stock_revision := COALESCE(OLD.stock_revision, 0);
        END IF;
        RETURN NEW;
      END $$`);
    await knex.raw("DROP TRIGGER IF EXISTS infinity_stock_revision ON product_stocks");
    await knex.raw("CREATE TRIGGER infinity_stock_revision BEFORE UPDATE ON product_stocks FOR EACH ROW EXECUTE FUNCTION infinity_advance_stock_revision()");
  }
}

module.exports = { ensureCatalogEditStorage, retainCatalogEditTable };
