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
const { WooSyncService, describeError } = require("./service");

/**
 * A campaign killed out-of-band leaves its row `running`. That status is NOT
 * terminal, so `startCampaign`'s ON CONFLICT resets it and the next scheduled
 * campaign re-runs everything from the top instead of skipping. Worse, the
 * failure is invisible: no `failed` row, no error code, nothing to alert on.
 *
 * On 2026-09-12 a network blip rejected a speculative prefetch that nothing was
 * awaiting; Node terminated the process, `main().catch` never ran, and the row
 * sat `running` for hours. These handlers close that gap for every cause of
 * sudden death, not just that one.
 */
function installFatalHandlers(getService) {
  let handling = false;
  const die = (label, reason) => {
    if (handling) return;
    handling = true;
    console.error(`Friday campaign ${label}: ${describeError(reason)}`);
    if (reason?.stack) console.error(reason.stack);
    const service = getService();
    const settle = service
      ? service.finalizeActiveCampaign(`PROCESS_${label.toUpperCase().replace(/[^A-Z]+/g, "_")}`)
      : Promise.resolve(false);
    // Bounded: never let cleanup itself hang the exit.
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref?.();
    settle
      .then((marked) => console.error(`campaign row marked failed: ${marked}`))
      .catch(() => undefined)
      .finally(() => process.exit(1));
  };
  process.on("unhandledRejection", (reason) => die("unhandled rejection", reason));
  process.on("uncaughtException", (error) => die("uncaught exception", error));
  // The handbook's stop procedure (§10) is `kill -TERM <pid>`, and Node's default
  // SIGTERM disposition is to terminate without running any of the above — so an
  // operator following the documented steps left the row stuck at `running`, the
  // exact invisible failure the rest of this function exists to prevent. The
  // SIGTERM handlers in service.js cover only the long-running worker, not this
  // one-shot path.
  process.once("SIGTERM", (signal) => die(signal, new Error("operator sent SIGTERM")));
  process.once("SIGINT", (signal) => die(signal, new Error("operator sent SIGINT")));
}

async function main() {
  const { values } = parseArgs({ options: { variant: { type: "string" } }, allowPositionals: false });
  // Validate the flag before loading secrets, so a typo fails immediately.
  const requestedVariant = values.variant ? resolveCampaignVariant(values.variant) : null;
  const config = getSyncConfig();
  const variant = requestedVariant || config.campaignVariant;
  const pool = new Pool({ ...config.postgres, max: 4, idleTimeoutMillis: 30_000 });
  const service = new WooSyncService(config, { pool });
  serviceRef = service;
  try {
    console.error(`Starting friday campaign (variant=${variant})`);
    const result = await service.friday(Date.now(), { variant });
    console.log(JSON.stringify(result, null, 2));
    if (result?.status === "failed") process.exitCode = 1;
  } finally {
    await service.close();
  }
}

let serviceRef = null;
installFatalHandlers(() => serviceRef);

main().catch(async (error) => {
  console.error(`Friday campaign run failed: ${describeError(error)}`);
  // The in-band catch inside friday() already marks the row failed; this is the
  // backstop for anything that threw before or outside it.
  await serviceRef?.finalizeActiveCampaign("PROCESS_RUN_FAILED").catch(() => undefined);
  process.exitCode = 1;
});
