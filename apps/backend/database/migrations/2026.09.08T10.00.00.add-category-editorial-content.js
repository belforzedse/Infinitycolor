"use strict";

const CONTENT_TABLE = "product_category_contents";
const LINK_TABLE = "product_category_contents_product_category_links";
const UNIQUE_CONSTRAINT = "uq_category_editorial_product_category";

async function assertNoDuplicateCategoryLinks(knex) {
  if (!(await knex.schema.hasTable(LINK_TABLE))) return;

  const duplicates = await knex(LINK_TABLE)
    .select("product_category_id")
    .count("* as count")
    .whereNotNull("product_category_id")
    .groupBy("product_category_id")
    .havingRaw("COUNT(*) > 1")
    .limit(20);

  if (duplicates.length > 0) {
    const ids = duplicates.map((row) => String(row.product_category_id)).join(", ");
    throw new Error(
      `Category editorial migration refused duplicate category links (${ids}). Resolve them without deleting data, then retry.`,
    );
  }
}

module.exports = {
  async up(knex) {
    if (await knex.schema.hasTable(CONTENT_TABLE)) {
      if (!(await knex.schema.hasColumn(CONTENT_TABLE, "content"))) {
        await knex.schema.alterTable(CONTENT_TABLE, (table) => {
          table.text("content").nullable();
        });
      }
    }

    await assertNoDuplicateCategoryLinks(knex);

    if (await knex.schema.hasTable(LINK_TABLE)) {
      await knex.raw(`
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
    }
  },

  async down(knex) {
    await knex.raw(
      `ALTER TABLE IF EXISTS ${LINK_TABLE} DROP CONSTRAINT IF EXISTS ${UNIQUE_CONSTRAINT}`,
    );
    // Keep the rich-text column and all editorial data on rollback.
  },
};
