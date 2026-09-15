#!/usr/bin/env node
"use strict";

const { Pool } = require("pg");
const { getSyncConfig } = require("./config");
const { SyncStateStore } = require("./stateStore");

/**
 * `--source-ids 1,2,3` or `--source-ids @/path/ids.txt` (one id per line, `#`
 * comments allowed). Numeric WooCommerce ids only.
 */
function readSourceIds(value) {
  if (!value) return null;
  const raw = String(value).startsWith("@")
    ? require("node:fs").readFileSync(String(value).slice(1), "utf8")
    : String(value);
  const ids = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .join(",")
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error(`--source-ids expects numeric WooCommerce ids; received "${id}"`);
  }
  if (ids.length === 0) throw new Error("--source-ids resolved to no ids");
  return [...new Set(ids)];
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) options[token.slice(2)] = true;
    else {
      options[token.slice(2)] = next;
      index += 1;
    }
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!new Set(["status", "set-mode", "requeue"]).has(command)) {
    throw new Error(
      "Usage: control.js status"
      + " | set-mode --mode disabled|shadow|active"
      + " | requeue --source-types customer,wallet [--statuses quarantined,failed]"
      + " [--error-codes A,B] [--error-prefixes TYPEERROR,ERROR:] [--source-ids 1,2 | @/path/ids.txt]"
      + " [--limit 5000] --confirm WooSyncRequeue",
    );
  }
  const config = getSyncConfig();
  const pool = new Pool({ ...config.postgres, max: 1 });
  const state = new SyncStateStore(pool, { owner: config.instanceId, leaseSeconds: config.leaseSeconds });
  try {
    if (command === "status") {
      const control = await state.control();
      console.log(JSON.stringify(control, null, 2));
      return;
    }
    if (command === "requeue") {
      // Puts quarantined rows back on the hourly lane; the next drain retries
      // them. Meant for rows a source outage quarantined (`TYPEERROR:*`,
      // `ERROR:*`), never for `excluded` rows, which the store refuses anyway.
      if (options.confirm !== "WooSyncRequeue") throw new Error("requeue requires --confirm WooSyncRequeue");
      const list = (value) => String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
      const sourceTypes = list(options["source-types"]);
      if (sourceTypes.length === 0) throw new Error("requeue requires --source-types");
      const sourceIds = readSourceIds(options["source-ids"]);
      const rows = await state.requeueItems({
        sourceTypes,
        statuses: list(options.statuses).length > 0 ? list(options.statuses) : ["quarantined"],
        errorCodes: list(options["error-codes"]).length > 0 ? list(options["error-codes"]) : null,
        errorCodePrefixes: list(options["error-prefixes"]).length > 0 ? list(options["error-prefixes"]) : null,
        sourceIds,
        limit: Number(options.limit || (sourceIds ? sourceIds.length : 5000)),
      });
      const byCode = {};
      for (const row of rows) byCode[row.last_error_code || "UNKNOWN"] = (byCode[row.last_error_code || "UNKNOWN"] || 0) + 1;
      console.log(JSON.stringify({ requeued: rows.length, byCode }, null, 2));
      return;
    }
    const mode = String(options.mode || "");
    if (mode === "active" && options.confirm !== "HistoricalReconciliationAccepted") {
      throw new Error("Active mode requires --confirm HistoricalReconciliationAccepted");
    }
    if (mode !== "active" && options.confirm !== "WooSyncControlChange") {
      throw new Error("Non-active mode changes require --confirm WooSyncControlChange");
    }
    if (mode === "active") {
      const baseline = await state.baselineStatus();
      if (!baseline.ready) throw new Error("Active mode requires a complete shadow product/order baseline");
    }
    const control = await state.setMode(mode, {
      reconciliationRunId: options["reconciliation-run"],
      reconciliationSha256: options.sha256,
    });
    console.log(JSON.stringify(control, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Woo sync control failed: ${error.message}`);
  process.exitCode = 1;
});
