"use strict";

// Declared in the content type too: Strapi schema sync must retain these fields.
const schema = require("../../src/api/reserve-group/content-types/reserve-group/schema.json");
const columnName = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [827453110]);
    if (!(await knex.schema.hasTable("reserve_groups"))) return;
    for (const [name, definition] of Object.entries(schema.attributes)) {
      if (!name.startsWith("Anipo") && !["ShippingWeight", "ShippingBoxSizeId"].includes(name)) continue;
      const column = columnName(name);
      if (await knex.schema.hasColumn("reserve_groups", column)) continue;
      await knex.schema.alterTable("reserve_groups", (table) => {
        const field = definition.type === "json" ? table.jsonb(column)
          : definition.type === "datetime" ? table.timestamp(column, { useTz: true })
          : definition.type === "integer" ? table.integer(column)
          : definition.type === "boolean" ? table.boolean(column)
          : definition.type === "text" ? table.text(column)
          : table.string(column, definition.maxLength || 255);
        field.nullable();
        if (definition.default !== undefined) field.defaultTo(definition.default);
      });
    }
  },
  // Forward-only: never discard a carrier reference or an issued label.
  async down() {},
};
