#!/usr/bin/env node
"use strict";

/**
 * Second identity pass — re-runs ONLY the users/wallets stage
 * (service.js#fullUsersAndWallets), without the catalog, order or inventory
 * stages and without taking the `campaign:friday` lease.
 *
 * Why a second pass exists
 * -----------------------
 * `reconcileCustomerIdentity` resolves a customer three ways — by mapping, by
 * `external_id`, and by phone — and throws USER_IDENTITY_CONFLICT when they
 * disagree (customer-identity.ts:178-181). During a single pass that disagreement
 * is frequently an *ordering artifact* rather than a real collision:
 *
 *   - Customer A's phone is still held by customer B, who has not been
 *     reprocessed yet. Once B is rewritten to its own number, A's resolves
 *     cleanly.
 *   - The advisory locks are taken on the *incoming* phone, so at high entity
 *     concurrency a number freed by one worker can race another.
 *
 * Both settle once the table has converged, so a second pass over the same
 * source clears the residual. Run this after a campaign, never concurrently:
 * it deliberately does not hold the campaign lease, so nothing stops you
 * double-writing if a campaign is still going.
 *
 * Wallet verification defaults OFF here. The campaign already verified balances
 * (divergence 0 across 3,014 sampled rows on 2026-09-11); re-verifying on a
 * convergence pass costs a full extra source read for no new signal. Pass
 * --verify to force it back on.
 */

const { parseArgs } = require("node:util");
const { Pool } = require("pg");
const { getSyncConfig } = require("./config");
const { WooSyncService, describeError } = require("./service");

async function main() {
  const { values } = parseArgs({
    options: {
      verify: { type: "boolean", default: false },
      concurrency: { type: "string" },
    },
    allowPositionals: false,
  });

  const config = getSyncConfig();
  const concurrency = values.concurrency
    ? Number(values.concurrency)
    : config.concurrency.entities;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got: ${values.concurrency}`);
  }

  const pool = new Pool({ ...config.postgres, max: 4, idleTimeoutMillis: 30_000 });
  const service = new WooSyncService(config, { pool });
  const startedAt = Date.now();
  try {
    console.error(
      `Starting identity pass (concurrency=${concurrency}, verify=${values.verify})`,
    );
    const result = await service.fullUsersAndWallets({
      concurrency,
      verify: values.verify,
    });
    const durationMs = Date.now() - startedAt;
    console.log(JSON.stringify({ ...result, durationMs }, null, 2));
  } finally {
    await service.close();
  }
}

// This pass runs unattended for a long stretch against the same source that
// killed the 2026-09-12 campaign. Without these, an unhandled rejection exits
// silently with no usable diagnosis; `describeError` unwraps the `cause` chain
// where Node's fetch hides the real transport code. There is no campaign row to
// finalize here — this runner deliberately takes no `campaign:friday` lease.
let dying = false;
const dieFatal = (label) => (reason) => {
  if (dying) return;
  dying = true;
  console.error(`Identity pass ${label}: ${describeError(reason)}`);
  if (reason?.stack) console.error(reason.stack);
  process.exit(1);
};
process.on("unhandledRejection", dieFatal("unhandled rejection"));
process.on("uncaughtException", dieFatal("uncaught exception"));

main().catch((error) => {
  console.error(`Identity pass failed: ${describeError(error)}`);
  process.exitCode = 1;
});
