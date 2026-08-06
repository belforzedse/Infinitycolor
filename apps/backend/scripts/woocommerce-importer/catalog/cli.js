#!/usr/bin/env node
"use strict";

/**
 * Catalog importer CLI: WooCommerce (read-only source of truth) → Strapi (target).
 *
 *   node catalog/cli.js dry-run --env local --limit 20
 *   node catalog/cli.js sync    --env production
 *   node catalog/cli.js verify  --env production
 */

const fs = require("fs");
const path = require("path");
const { parseArgs } = require("node:util");

// Resolve deps from the importer's node_modules when launched from elsewhere.
const localNodeModules = path.join(__dirname, "..", "node_modules");
if (fs.existsSync(localNodeModules)) {
  module.paths.unshift(localNodeModules);
}

// Optional env files (credentials may also come from the shell).
try {
  require("dotenv").config({ path: path.join(__dirname, "../../../.env") });
  require("dotenv").config({ path: path.join(__dirname, "../../../.env.local") });
} catch {
  /* dotenv optional */
}

const { buildConfig, ENV_CONFIG } = require("./config");
const Logger = require("../utils/Logger");
const { CatalogEngine } = require("./engine");
const { CatalogRunStore, RESUMABLE_STATUSES } = require("./lib/runStore");

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

async function run(command, options) {
  requireEnv("WOOCOMMERCE_CONSUMER_KEY");
  requireEnv("WOOCOMMERCE_CONSUMER_SECRET");

  const environment = options.env || "production";
  process.env.IMPORT_LOG_LEVEL = options.logLevel || process.env.IMPORT_LOG_LEVEL || "info";

  const { config } = buildConfig(environment);
  config.logging.level = process.env.IMPORT_LOG_LEVEL;

  const logger = new Logger(config.logging);
  logger.info(`Catalog ${command} → env=${environment}, Strapi=${config.strapi.baseUrl}`);
  logger.info("WooCommerce is read-only (source of truth)");

  const engine = new CatalogEngine(config, logger, { environment });
  const runStore = new CatalogRunStore(config.catalog.trackingDirAbs);

  if (command === "verify") {
    const result = await engine.runVerify({ limit: options.limit ? Number(options.limit) : Infinity });
    process.exit(result.ok ? 0 : 1);
  }

  const report = await engine.runSync({
    dryRun: command === "dry-run",
    scope: options.scope || (options.skipCategories ? "no-media" : "full"),
    skipMedia: Boolean(options.skipMedia),
    limit: options.limit ? Number(options.limit) : Infinity,
    startAfterExternalId: options.startAfterExternalId,
    runStore,
    runId: options.runId,
  });

  process.exit(report.hasFailures() ? 1 : 0);
}

function runStoreForEnv(environment, options = {}) {
  const envConfig = ENV_CONFIG[environment];
  if (!envConfig) {
    throw new Error(`Unknown environment: ${environment}. Use production, staging, or local.`);
  }
  const trackingDir = options.trackingDir || process.env.IMPORT_TRACKING_DIR || envConfig.trackingDir;
  return new CatalogRunStore(path.resolve(process.cwd(), trackingDir));
}

function printRunSummary(run) {
  const failures = typeof run.failures === "number" ? run.failures : run.failures?.length || 0;
  console.log(
    `${run.id}  status=${run.status} scope=${run.scope || run.options?.scope || "?"} ` +
      `env=${run.environment} failures=${failures} updated=${run.updatedAt}`,
  );
}

async function listRuns(options) {
  const store = runStoreForEnv(options.env || "production", options);
  const statuses = options.resumable ? Array.from(RESUMABLE_STATUSES) : undefined;
  const runs = store.listRuns({ statuses }).slice(0, Number(options.limit || 20));
  if (runs.length === 0) {
    console.log("No catalog runs found.");
    return;
  }
  runs.forEach(printRunSummary);
}

async function showRunStatus(runId, options) {
  const store = runStoreForEnv(options.env || "production", options);
  const run = store.getRun(runId);
  console.log(JSON.stringify(run, null, 2));
}

async function cancelRun(runId, options) {
  const store = runStoreForEnv(options.env || "production", options);
  const run = store.requestCancel(runId);
  printRunSummary(store.summarize(run));
}

async function pauseRun(runId, options) {
  const store = runStoreForEnv(options.env || "production", options);
  printRunSummary(store.summarize(store.requestPause(runId)));
}

async function convertLegacy(runId, options) {
  const store = runStoreForEnv(options.env || "production", options);
  const dryRun = !options.confirm;
  const result = store.convertLegacy(runId, { dryRun, confirm: options.confirm || "" });
  console.log(JSON.stringify(result, null, 2));
}

async function auditExceptions(runId, options) {
  const store = runStoreForEnv(options.env || "production", options);
  console.log(JSON.stringify(store.exceptionAudit(runId), null, 2));
}

async function acceptExceptions(runId, options) {
  if (!options.manifest) throw new Error("accept-exceptions requires --manifest <path>");
  const manifestPath = path.resolve(process.cwd(), options.manifest);
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifest = parsed.manifest || parsed;
  const store = runStoreForEnv(options.env || "production", options);
  const result = store.acceptExceptions(runId, manifest, { confirm: options.confirm || "" });
  console.log(JSON.stringify(result, null, 2));
}

async function resumeRun(runId, options) {
  requireEnv("WOOCOMMERCE_CONSUMER_KEY");
  requireEnv("WOOCOMMERCE_CONSUMER_SECRET");

  const environment = options.env || "production";
  process.env.IMPORT_LOG_LEVEL = options.logLevel || process.env.IMPORT_LOG_LEVEL || "info";

  const { config } = buildConfig(environment);
  config.logging.level = process.env.IMPORT_LOG_LEVEL;
  if (options.trackingDir) {
    const trackingDir = path.resolve(process.cwd(), options.trackingDir);
    config.duplicateTracking.storageDir = trackingDir;
    config.catalog.trackingDirAbs = trackingDir;
  }
  const logger = new Logger(config.logging);
  const engine = new CatalogEngine(config, logger, { environment });
  const runStore = new CatalogRunStore(config.catalog.trackingDirAbs);
  const report = await engine.runSync({
    runStore,
    runId,
    resume: true,
    retryFailed: Boolean(options.retryFailed),
    pauseSignalPath: options.pauseSignalPath,
  });
  process.exit(report.hasFailures() ? 1 : 0);
}

const CLI_OPTIONS = {
  env: { type: "string", default: "production" },
  limit: { type: "string" },
  "log-level": { type: "string" },
  scope: { type: "string", default: "full" },
  "skip-media": { type: "boolean", default: false },
  "start-after-external-id": { type: "string" },
  "run-id": { type: "string" },
  "tracking-dir": { type: "string" },
  "retry-failed": { type: "boolean", default: false },
  "pause-signal-path": { type: "string" },
  resumable: { type: "boolean", default: false },
  confirm: { type: "string" },
  manifest: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
};

const COMMANDS_WITH_RUN_ID = new Set([
  "resume", "run-status", "cancel", "pause", "convert-v1", "exceptions", "accept-exceptions",
]);

function usage() {
  return `Usage: catalog <command> [runId] [options]

Commands:
  dry-run | sync | verify
  resume <runId> [--retry-failed]
  runs [--resumable]
  run-status | cancel | pause | convert-v1 | exceptions <runId>
  accept-exceptions <runId> --manifest <path> --confirm CatalogExceptionsAccepted

Options:
  --env <production|staging|local>  --tracking-dir <path>
  --scope <name>  --limit <n>  --log-level <level>
  --skip-media  --start-after-external-id <id>  --run-id <id>
  --pause-signal-path <path>  --confirm <phrase>  -h, --help`;
}

function parseCliArgs(args) {
  const parsed = parseArgs({ args, options: CLI_OPTIONS, allowPositionals: true, strict: true });
  const [command, runId, ...extra] = parsed.positionals;
  if (parsed.values.help) return { help: true };
  const known = new Set([
    "dry-run", "sync", "verify", "resume", "runs", "run-status", "cancel", "pause",
    "convert-v1", "exceptions", "accept-exceptions",
  ]);
  if (!command || !known.has(command)) throw new Error(`${usage()}\n\nUnknown or missing command: ${command || "(none)"}`);
  if (extra.length > 0) throw new Error(`Unexpected positional arguments: ${extra.join(" ")}`);
  if (COMMANDS_WITH_RUN_ID.has(command) && !runId) throw new Error(`${command} requires <runId>`);
  if (!COMMANDS_WITH_RUN_ID.has(command) && runId) throw new Error(`Unexpected run id for ${command}: ${runId}`);

  const values = parsed.values;
  return {
    command,
    runId,
    options: {
      env: values.env,
      limit: values.limit,
      logLevel: values["log-level"],
      scope: values.scope,
      skipMedia: values["skip-media"],
      startAfterExternalId: values["start-after-external-id"],
      runId: values["run-id"],
      trackingDir: values["tracking-dir"],
      retryFailed: values["retry-failed"],
      pauseSignalPath: values["pause-signal-path"],
      resumable: values.resumable,
      confirm: values.confirm,
      manifest: values.manifest,
    },
  };
}

async function main(args = process.argv.slice(2)) {
  const parsed = parseCliArgs(args);
  if (parsed.help) {
    console.log(usage());
    return;
  }
  const { command, runId, options } = parsed;
  if (command === "dry-run" || command === "sync" || command === "verify") return run(command, options);
  if (command === "resume") return resumeRun(runId, options);
  if (command === "runs") return listRuns(options);
  if (command === "run-status") return showRunStatus(runId, options);
  if (command === "cancel") return cancelRun(runId, options);
  if (command === "pause") return pauseRun(runId, options);
  if (command === "convert-v1") return convertLegacy(runId, options);
  if (command === "exceptions") return auditExceptions(runId, options);
  if (command === "accept-exceptions") return acceptExceptions(runId, options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, parseCliArgs, usage };
