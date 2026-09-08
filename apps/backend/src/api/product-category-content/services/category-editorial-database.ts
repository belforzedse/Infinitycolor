import type { Strapi } from "@strapi/strapi";

const LINK_TABLE = "product_category_contents_product_category_links";
const UNIQUE_CONSTRAINT = "uq_category_editorial_product_category";

/**
 * Strapi removes custom relation-table constraints during schema sync. Restore
 * the migration's one-category invariant before the server begins accepting
 * traffic, after rechecking that doing so cannot discard or merge any row.
 */
export async function ensureCategoryEditorialDatabaseInvariant(strapi: Strapi): Promise<void> {
  const connection = strapi.db.connection as any;
  if (!(await connection.schema.hasTable(LINK_TABLE))) return;

  await connection.transaction(async (trx: any) => {
    await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [17347073, 0]);
    const duplicates = await trx(LINK_TABLE)
      .select("product_category_id")
      .count("* as count")
      .whereNotNull("product_category_id")
      .groupBy("product_category_id")
      .havingRaw("COUNT(*) > 1")
      .limit(20);
    if (duplicates.length > 0) {
      const ids = duplicates.map((row: any) => String(row.product_category_id)).join(", ");
      throw new Error(
        `Category editorial invariant refused duplicate category links (${ids}). No data was changed.`,
      );
    }

    await trx.raw(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = '${UNIQUE_CONSTRAINT}'
            AND conrelid = '${LINK_TABLE}'::regclass
        ) THEN
          ALTER TABLE ${LINK_TABLE}
            ADD CONSTRAINT ${UNIQUE_CONSTRAINT} UNIQUE (product_category_id);
        END IF;
      END
      $$
    `);
  });
}
