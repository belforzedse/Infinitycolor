"use strict";
const { ensureCatalogEditStorage, retainCatalogEditTable } = require("../catalog-edit-storage");
module.exports = {
  async up(knex) {
    await knex.raw("SELECT pg_advisory_xact_lock(?)", [827453139]);
    await retainCatalogEditTable(knex);
    await ensureCatalogEditStorage(knex);
  },
  // Coordination history must survive application rollbacks.
  async down() {},
};
