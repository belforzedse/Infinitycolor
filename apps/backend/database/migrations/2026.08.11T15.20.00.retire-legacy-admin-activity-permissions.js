"use strict";

const RETIRED_ACTIONS = [
  "api::admin-activity.admin-activity.create",
  "api::admin-activity.admin-activity.delete",
  "api::admin-activity.admin-activity.find",
  "api::admin-activity.admin-activity.findOne",
  "api::admin-activity.admin-activity.update",
];

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable("up_permissions"))) return;

    const permissionIds = await knex("up_permissions")
      .whereIn("action", RETIRED_ACTIONS)
      .pluck("id");
    if (permissionIds.length === 0) return;

    if (await knex.schema.hasTable("up_permissions_role_links")) {
      await knex("up_permissions_role_links")
        .whereIn("permission_id", permissionIds)
        .delete();
    }
    await knex("up_permissions").whereIn("id", permissionIds).delete();
  },

  // These permissions pointed at intentionally removed generic CRUD routes.
  async down() {},

  __private: { RETIRED_ACTIONS },
};
