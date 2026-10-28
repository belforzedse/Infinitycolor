"use strict";
const { LOCK_KEY, registerSnapshotTable, ensureStorage } = require("../order-search-storage");
module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [LOCK_KEY]);
    await registerSnapshotTable(knex);
    await ensureStorage(knex);
  },
  // Delivery history is deliberately retained on application rollback.
  async down() {},
};
