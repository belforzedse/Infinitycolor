/**
 * Migration: indexes backing the admin list screens
 *
 * The admin orders/users/products lists run server-side search and sort over
 * ~50k orders, but nothing indexed the columns they actually touch:
 *
 * - `orders.updated_at` — the DEFAULT sort ("last-edited") on the orders list,
 *   so every page load was an unindexed sort of the whole table.
 * - The `$containsi` search predicates, which compile to `ILIKE '%term%'`:
 *   `users_permissions_user.phone`, `local_user_infos.FirstName/LastName`,
 *   `contracts.external_id`, `products.Title`, `orders.ShippingBarcode`.
 *
 * Leading-wildcard ILIKE cannot use a btree index, so the text columns get
 * trigram GIN indexes. `pg_trgm` may not be installable on a managed instance
 * without superuser, so extension creation is attempted and the trigram
 * indexes are skipped (not failed) when it is unavailable — the btree index on
 * `updated_at` is created either way.
 *
 * Additive only: no schema, column or data changes.
 */

module.exports = {
  async up(knex) {
    const tableExists = async (tableName) => {
      try {
        return await knex.schema.hasTable(tableName);
      } catch (error) {
        console.warn(`Failed to check table ${tableName}:`, error.message);
        return false;
      }
    };

    const resolveColumn = async (tableName, candidates) => {
      for (const columnName of candidates) {
        try {
          const result = await knex.raw(
            `SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?
             LIMIT 1`,
            [tableName, columnName],
          );
          if (result.rows.length > 0) return columnName;
        } catch {
          // fall through to the next candidate
        }
      }
      return null;
    };

    const createIndex = async (sql, label) => {
      try {
        await knex.raw(sql);
        console.log(`✓ ${label}`);
      } catch (error) {
        console.warn(`✗ ${label}: ${error.message}`);
      }
    };

    // --- btree: default orders sort -----------------------------------------
    if (await tableExists("orders")) {
      const updatedAt = await resolveColumn("orders", ["updated_at", "updatedAt"]);
      if (updatedAt) {
        await createIndex(
          `CREATE INDEX IF NOT EXISTS idx_orders_updated_at
           ON orders ("${updatedAt}" DESC)`,
          "idx_orders_updated_at",
        );
      }
    }

    // --- trigram: free-text search ------------------------------------------
    let hasTrigram = false;
    try {
      await knex.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      hasTrigram = true;
    } catch (error) {
      console.warn(
        `pg_trgm unavailable, skipping trigram indexes (search still works, just unindexed): ${error.message}`,
      );
    }

    if (!hasTrigram) return;

    // Table names are probed rather than assumed: the users-permissions table
    // is `up_users` on Strapi 4 but has been named differently across versions.
    const resolveTable = async (candidates) => {
      for (const name of candidates) {
        if (await tableExists(name)) return name;
      }
      return null;
    };

    const trigramTargets = [
      { tables: ["orders"], columns: ["ShippingBarcode", "shipping_barcode"], index: "idx_orders_shipping_barcode_trgm" },
      { tables: ["contracts"], columns: ["external_id"], index: "idx_contracts_external_id_trgm" },
      { tables: ["up_users", "users_permissions_user"], columns: ["phone"], index: "idx_up_users_phone_trgm" },
      { tables: ["local_user_infos"], columns: ["FirstName", "first_name"], index: "idx_local_user_infos_first_name_trgm" },
      { tables: ["local_user_infos"], columns: ["LastName", "last_name"], index: "idx_local_user_infos_last_name_trgm" },
      { tables: ["products"], columns: ["Title", "title"], index: "idx_products_title_trgm" },
    ];

    for (const target of trigramTargets) {
      const table = await resolveTable(target.tables);
      if (!table) {
        console.warn(`✗ ${target.index}: no table matching ${target.tables.join(", ")}`);
        continue;
      }
      const column = await resolveColumn(table, target.columns);
      if (!column) {
        console.warn(`✗ ${target.index}: no matching column on ${table}`);
        continue;
      }
      await createIndex(
        `CREATE INDEX IF NOT EXISTS ${target.index}
         ON ${table} USING gin ("${column}" gin_trgm_ops)`,
        target.index,
      );
    }
  },

  async down(knex) {
    const indexes = [
      "idx_orders_updated_at",
      "idx_orders_shipping_barcode_trgm",
      "idx_contracts_external_id_trgm",
      "idx_up_users_phone_trgm",
      "idx_local_user_infos_first_name_trgm",
      "idx_local_user_infos_last_name_trgm",
      "idx_products_title_trgm",
    ];

    for (const index of indexes) {
      try {
        await knex.raw(`DROP INDEX IF EXISTS ${index}`);
      } catch (error) {
        console.warn(`Failed to drop ${index}: ${error.message}`);
      }
    }
    // pg_trgm is intentionally left installed: other objects may depend on it.
  },
};
