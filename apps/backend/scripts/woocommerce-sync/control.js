#!/usr/bin/env node
"use strict";

const { Pool } = require("pg");
const { getSyncConfig } = require("./config");
const { SyncStateStore } = require("./stateStore");

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
  if (!new Set(["status", "set-mode"]).has(command)) {
    throw new Error("Usage: control.js status | set-mode --mode disabled|shadow|active");
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
