#!/usr/bin/env node
"use strict";

/**
 * Consolidates customers who own more than one cart (and, with --include-orphans,
 * re-attaches carts that lost their owner link), then installs idx_carts_one_per_user —
 * in one locked transaction. The rules live in src/api/cart/services/lib/cart-repair.ts.
 *
 * Default is a dry run: every step runs, including the index build and verification,
 * and the transaction is rolled back. The full JSON report goes to stdout (redirect it
 * to a file — it is the undo manifest); a one-line summary goes to stderr.
 *
 * Run inside an api container (it has DATABASE_* and the compiled dist/):
 *   node scripts/repair-duplicate-user-carts.js --include-orphans > dry-run.json
 *   node scripts/repair-duplicate-user-carts.js --include-orphans --apply \
 *     --confirm-database <DATABASE_NAME> > applied.json
 */

const path = require("node:path");
const { parseArgs } = require("node:util");
const { Pool } = require("pg");

try {
  require("dotenv").config({ path: path.join(__dirname, "../.env") });
} catch {}

function parseCliArgs(argv) {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    options: {
      apply: { type: "boolean", default: false },
      "include-orphans": { type: "boolean", default: false },
      "confirm-database": { type: "string" },
      "lock-timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.positionals.length > 0) throw new Error("Unexpected positional arguments");
  const lockTimeoutMs = parsed.values["lock-timeout-ms"]
    ? Number(parsed.values["lock-timeout-ms"])
    : undefined;
  if (lockTimeoutMs !== undefined && (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs <= 0)) {
    throw new Error("--lock-timeout-ms must be a positive integer");
  }
  return {
    apply: parsed.values.apply,
    includeOrphans: parsed.values["include-orphans"],
    confirmDatabase: parsed.values["confirm-database"] || "",
    lockTimeoutMs,
    help: parsed.values.help,
  };
}

function usage() {
  return [
    "Usage: node scripts/repair-duplicate-user-carts.js [--include-orphans] [--apply --confirm-database <name>]",
    "Default is a dry run (rolled back). --apply commits and requires --confirm-database to equal the connected database.",
  ].join("\n");
}

function connectionConfig(env) {
  const ssl =
    String(env.DATABASE_SSL || "").toLowerCase() === "true"
      ? { rejectUnauthorized: String(env.DATABASE_SSL_REJECT_UNAUTHORIZED || "true").toLowerCase() !== "false" }
      : false;
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, ssl };
  return {
    host: env.DATABASE_HOST || "localhost",
    port: Number(env.DATABASE_PORT || 5432),
    database: env.DATABASE_NAME || "strapi",
    user: env.DATABASE_USERNAME || "strapi",
    password: env.DATABASE_PASSWORD || "strapi",
    ssl,
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.error(usage());
    return;
  }

  const { repairUserCarts } = require(path.join(
    __dirname,
    "../dist/src/api/cart/services/lib/cart-repair.js",
  ));

  const pool = new Pool({
    ...connectionConfig(process.env),
    max: 1,
    application_name: "repair-duplicate-user-carts",
  });
  const client = await pool.connect();
  try {
    const target = (
      await client.query("SELECT current_database() AS database, current_user AS role")
    ).rows[0];
    if (options.apply && options.confirmDatabase !== target.database) {
      throw new Error(
        `--apply requires --confirm-database ${target.database} (got "${options.confirmDatabase}")`,
      );
    }
    console.error(
      `[cart-repair] database=${target.database} role=${target.role} mode=${options.apply ? "APPLY" : "dry-run"} orphans=${options.includeOrphans}`,
    );

    const report = await repairUserCarts(client, {
      apply: options.apply,
      includeOrphans: options.includeOrphans,
      lockTimeoutMs: options.lockTimeoutMs,
    });
    process.stdout.write(
      `${JSON.stringify({ database: target.database, generatedAt: new Date().toISOString(), ...report }, null, 2)}\n`,
    );
    console.error(`[cart-repair] ${report.applied ? "COMMITTED" : "rolled back (dry run)"} ${JSON.stringify(report.summary)}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[cart-repair] failed: ${error?.message || error}`);
  process.exitCode = 1;
});
