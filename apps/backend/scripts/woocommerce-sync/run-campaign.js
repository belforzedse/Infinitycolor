#!/usr/bin/env node
"use strict";

/**
 * One-shot trigger for the nightly full cutover campaign (service.js#friday):
 * new-products -> catalog-full -> stock -> price -> users/wallets -> orders.
 *
 * Normally `friday()` only runs off the BullMQ cron scheduler
 * (WOOCOMMERCE_SYNC_FRIDAY_CRON / WOOCOMMERCE_SYNC_ENABLE_FRIDAY) inside the
 * long-running `sync:woocommerce` worker. This calls the exact same method
 * directly, for an on-demand run (e.g. a fast-profile benchmark) without
 * waiting for the cron or leaving a worker listening afterward.
 *
 * `--variant cutover` overlaps catalog-full with users/wallets and replaces the
 * separate stock+price stages with one in-stock inventory pass — the shape used
 * to fit a fixed maintenance window. `--variant full` (the default, unless
 * WOOCOMMERCE_SYNC_CAMPAIGN_VARIANT says otherwise) is the historical sequence.
 *
 * Prefer this over enqueueing a job by hand: the runbook's force-a-campaign
 * snippet calls queue.resume(), which also releases any paused hourly jobs and
 * re-arms the 23:59 scheduler — not what you want during a cutover window.
 *
 * Still goes through the same `campaign:friday` Postgres lease as the
 * scheduled path, so it refuses to run concurrently with another campaign —
 * but that lease does NOT exclude the separate `drain:hourly` lease. Quiesce
 * the hourly poller first (WOOCOMMERCE_SYNC_ENABLE_HOURLY=false, or stop the
 * `sync:woocommerce` worker process) before a manual benchmark, so nothing
 * else writes the catalog/orders concurrently.
 */

const { parseArgs } = require("node:util");
const { Pool } = require("pg");
const { getSyncConfig, resolveCampaignVariant } = require("./config");
const { WooSyncService } = require("./service");

async function main() {
  const { values } = parseArgs({ options: { variant: { type: "string" } }, allowPositionals: false });
  // Validate the flag before loading secrets, so a typo fails immediately.
  const requestedVariant = values.variant ? resolveCampaignVariant(values.variant) : null;
  const config = getSyncConfig();
  const variant = requestedVariant || config.campaignVariant;
  const pool = new Pool({ ...config.postgres, max: 4, idleTimeoutMillis: 30_000 });
  const service = new WooSyncService(config, { pool });
  try {
    console.error(`Starting friday campaign (variant=${variant})`);
    const result = await service.friday(Date.now(), { variant });
    console.log(JSON.stringify(result, null, 2));
    if (result?.status === "failed") process.exitCode = 1;
  } finally {
    await service.close();
  }
}

main().catch((error) => {
  console.error(`Friday campaign run failed: ${error.message}`);
  process.exitCode = 1;
});
