"use strict";

const anipoBarcodeWorkflowMigration = require("./2026.08.11T13.30.00.add-anipo-barcode-workflow.js");

/**
 * Reapply the idempotent Anipo schema migration under a new migration name.
 *
 * Production can retain an entry in strapi_migrations even when the physical
 * order columns are absent (for example after restoring an older schema). Since
 * Strapi runs each application migration only once, changing the original file
 * would not repair that database. A forward repair migration is therefore
 * required.
 */
module.exports = {
  async up(knex) {
    await anipoBarcodeWorkflowMigration.up(knex);
  },

  // Forward-only: removing workflow state would destroy shipping history.
  async down() {},

  __private: anipoBarcodeWorkflowMigration.__private,
};
