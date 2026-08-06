#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { configureEnvironment, migrationStateDir } = require("./lib/env");
const { RunLedger, loadRun } = require("./lib/ledger");
const { WordPressSource } = require("./lib/source");
const { Destination } = require("./lib/destination");
const { runDryRun } = require("./dry-run");
const { runPilot } = require("./pilot");
const { runFull, acceptedCatalogState } = require("./full");
const { runReconcile, buildFullReconciliationInputs } = require("./reconcile");
const { CatalogRunStore } = require("../catalog/lib/runStore");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function printSummary(summary) {
  console.log(`run=${summary.runId} status=${summary.status}`);
  if (summary.sample?.limitPerEntity) {
    console.log(`sample_limit_per_entity=${summary.sample.limitPerEntity}`);
  }
  for (const [entity, counts] of Object.entries(summary.entities || {})) {
    console.log(
      `${entity} source=${counts.source || 0} eligible=${counts.eligible || 0} ` +
      `insert=${counts.inserted || 0} update=${counts.updated || 0} unchanged=${counts.unchanged || 0} ` +
      `skip=${counts.skipped || 0} fail=${counts.failed || 0} verified=${counts.verified || 0}`,
    );
  }
  console.log(`failures=${(summary.failures || []).length}`);
}

function listRuns(stateDir) {
  const runsDir = path.join(stateDir, "runs");
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir)
    .map((runId) => {
      try { return loadRun(stateDir, runId); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || !["dry-run", "pilot", "reconcile", "full", "resume", "runs", "show"].includes(command)) {
    throw new Error("Usage: migration-v2/cli.js dry-run | pilot | full | resume | runs | show");
  }
  if (command === "runs") {
    for (const run of listRuns(migrationStateDir()).slice(0, 30)) printSummary(run);
    return;
  }
  if (command === "show") {
    if (!options.run) throw new Error("show requires --run <id>");
    printSummary(loadRun(migrationStateDir(), options.run));
    return;
  }

  const config = configureEnvironment();
  const sampleLimit = options["limit-per-entity"] === undefined
    ? null
    : Number(options["limit-per-entity"]);
  if (sampleLimit !== null && (!Number.isSafeInteger(sampleLimit) || sampleLimit <= 0)) {
    throw new Error("--limit-per-entity must be a positive integer");
  }
  if (sampleLimit !== null && command !== "dry-run") {
    throw new Error("--limit-per-entity is supported only for dry-run");
  }

  if (command === "pilot") {
    if (options.confirm !== "Gate1Pilot") throw new Error("Pilot requires --confirm Gate1Pilot");
    if (!options["from-run"]) throw new Error("Pilot requires --from-run <completed-dry-run-id>");
  }
  if (command === "reconcile" && !options["from-run"]) {
    throw new Error("reconcile requires --from-run <pilot-run-id>");
  }
  if (["full", "resume"].includes(command) && options.confirm !== "Gate2FullImport") {
    throw new Error(`${command} requires --confirm Gate2FullImport`);
  }
  if (command === "resume" && !options.run) throw new Error("resume requires --run <id>");

  const ledger = command === "resume"
    ? RunLedger.resume(config.stateDir, options.run)
    : new RunLedger(config.stateDir, command, options["run-id"]).start();
  const release = () => ledger.release();
  process.once("SIGINT", release);
  process.once("SIGTERM", release);
  try {
    const source = new WordPressSource(config);
    const destination = new Destination(config);
    if (command === "dry-run") {
      await runDryRun({ config, source, destination, ledger, sampleLimit });
    } else if (command === "pilot") {
      const dryRun = loadRun(config.stateDir, options["from-run"]);
      if (dryRun.command !== "dry-run" || !String(dryRun.status).startsWith("completed")) {
        throw new Error("Pilot source run must be a completed dry-run");
      }
      await runPilot({ config, source, destination, ledger, dryRun });
    } else if (command === "reconcile") {
      const sourceRun = loadRun(config.stateDir, options["from-run"]);
      if (!String(sourceRun.status).startsWith("completed")) {
        throw new Error("Reconciliation source run must be terminal completed");
      }
      if (sourceRun.command === "pilot") {
        const dryRun = loadRun(config.stateDir, sourceRun.sourceDryRunId);
        await runReconcile({ source, destination, ledger, pilot: sourceRun, dryRun });
      } else if (["full", "resume"].includes(sourceRun.command)) {
        const catalogRunId = sourceRun.checkpoints?.catalog?.runId || `${sourceRun.runId}-catalog`;
        const catalogRun = new CatalogRunStore(path.join(config.stateDir, "catalog")).getRun(catalogRunId);
        if (!acceptedCatalogState(catalogRun)) {
          throw new Error("Full reconciliation requires a completed or accepted-exception catalog run");
        }
        const inputs = await buildFullReconciliationInputs(source, sourceRun, catalogRun);
        await runReconcile({ source, destination, ledger, ...inputs });
      } else {
        throw new Error("Reconciliation source run must be a completed pilot, full, or resume run");
      }
    } else {
      await runFull({ config, source, destination, ledger, resume: command === "resume" });
    }
    const failureCount = Object.values(ledger.summary.entities)
      .reduce((sum, entity) => sum + Number(entity.failed || 0), 0);
    const hasAcceptedCatalogExceptions = Boolean(ledger.summary.catalogExceptions?.manifestSha256);
    const completedWithExceptions = failureCount > 0 || hasAcceptedCatalogExceptions;
    ledger.finish(completedWithExceptions ? "completed-with-exceptions" : "completed");
    printSummary(ledger.summary);
    process.exitCode = completedWithExceptions ? 2 : 0;
  } catch (error) {
    ledger.event("fatal", { code: error?.code || error?.name || "ERROR", message: String(error.message || error) });
    ledger.finish("failed");
    printSummary(ledger.summary);
    throw error;
  }
}

main().catch((error) => {
  console.error(`migration-v2 failed: ${error.message}`);
  process.exitCode = 1;
});
