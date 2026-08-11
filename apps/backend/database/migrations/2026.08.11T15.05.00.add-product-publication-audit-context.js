"use strict";

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable("products"))) return;
    if (!(await knex.schema.hasColumn("products", "scheduled_publish_audit_context"))) {
      await knex.schema.alterTable("products", (table) => {
        table.jsonb("scheduled_publish_audit_context").nullable();
      });
    }
  },

  async down(knex) {
    if (
      (await knex.schema.hasTable("products")) &&
      (await knex.schema.hasColumn("products", "scheduled_publish_audit_context"))
    ) {
      await knex.schema.alterTable("products", (table) => {
        table.dropColumn("scheduled_publish_audit_context");
      });
    }
  },
};

