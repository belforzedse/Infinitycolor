"use strict";

const customerIdentityLifecycle = require("./2026.08.07T18.00.00.add-customer-identity-lifecycle.js");
const productScheduledPublication = require("./2026.08.08T12.00.00.add-product-scheduled-publication.js");
const umamiAnalyticsOutbox = require("./2026.08.09T09.00.00.add-umami-analytics-outbox.js");
const checkoutLineIdentity = require("./2026.08.11T09.00.00.add-checkout-line-identity-and-coupon-claim.js");
const commerceIntegrityState = require("./2026.08.11T12.00.00.add-commerce-integrity-state.js");

/**
 * Reapply the idempotent August schema migrations under a new migration name.
 *
 * On 2026-08-29 a Strapi process running an older backend image ran schema sync
 * against production with the default `forceMigration: true`. Every column the
 * 2026-08-07..2026-08-11 migrations had added was classified as "removed" and
 * dropped, and the resulting older shape was persisted to
 * `strapi_database_schema`. Nothing self-healed afterwards:
 *
 *   - `strapi_migrations` still recorded each migration as applied, so Strapi
 *     never re-ran them.
 *   - `@strapi/database` `sync()` short-circuits on the persisted schema hash;
 *     with no pending migration it never inspects the real database.
 *
 * The missing `orders.analytics_correlation_id` broke storefront checkout
 * outright — `createOrderAndItems` writes that column on every order, so both
 * the payment gateway and the wallet failed at order creation.
 *
 * Editing the original files would not repair such a database, so a forward
 * repair migration is required. Each wrapped `up` is guarded by
 * `hasTable`/`hasColumn` and takes its own advisory lock, so this is safe to
 * run against an already-correct database.
 *
 * Deliberately NOT wrapped: `2026.08.11T15.00.00.rebuild-admin-audit-events.js`.
 * Its column additions are idempotent, but its legacy backfill `UPDATE` is
 * rejected by the append-only trigger the same migration installs, which would
 * fail this migration on every boot. Repair that table separately.
 */
module.exports = {
  async up(knex) {
    await customerIdentityLifecycle.up(knex);
    await productScheduledPublication.up(knex);
    await umamiAnalyticsOutbox.up(knex);
    await checkoutLineIdentity.up(knex);
    await commerceIntegrityState.up(knex);
  },

  // Forward-only: rolling this back would drop commerce state still owned by
  // the migrations it repairs.
  async down() {},
};
