"use strict";

/**
 * Forward repair for environments that already recorded the original Umami
 * outbox migration before the table was registered in core_persisted_tables.
 * Calling the original idempotent `up` function both registers and recreates
 * the schema. A fresh database also runs this harmlessly after the original.
 */

const outboxMigration = require("./2026.08.09T09.00.00.add-umami-analytics-outbox.js");

module.exports = {
  async up(knex) {
    await outboxMigration.up(knex);
  },

  // This migration only repairs the invariant established by the preceding
  // migration. Rolling it back must not remove a schema still owned there.
  async down() {},
};
