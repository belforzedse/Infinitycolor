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

const { program } = require("commander");
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

function runStoreForEnv(environment) {
  const envConfig = ENV_CONFIG[environment];
  if (!envConfig) {
    throw new Error(`Unknown environment: ${environment}. Use production, staging, or local.`);
  }
  return new CatalogRunStore(path.resolve(process.cwd(), envConfig.trackingDir));
}

function printRunSummary(run) {
  const failures = typeof run.failures === "number" ? run.failures : run.failures?.length || 0;
  console.log(
    `${run.id}  status=${run.status} scope=${run.scope || run.options?.scope || "?"} ` +
      `env=${run.environment} failures=${failures} updated=${run.updatedAt}`,
  );
}

async function listRuns(options) {
  const store = runStoreForEnv(options.env || "production");
  const statuses = options.resumable ? Array.from(RESUMABLE_STATUSES) : undefined;
  const runs = store.listRuns({ statuses }).slice(0, Number(options.limit || 20));
  if (runs.length === 0) {
    console.log("No catalog runs found.");
    return;
  }
  runs.forEach(printRunSummary);
}

async function showRunStatus(runId, options) {
  const store = runStoreForEnv(options.env || "production");
  const run = store.getRun(runId);
  console.log(JSON.stringify(run, null, 2));
}

async function cancelRun(runId, options) {
  const store = runStoreForEnv(options.env || "production");
  const run = store.requestCancel(runId);
  printRunSummary(store.summarize(run));
}

async function resumeRun(runId, options) {
  requireEnv("WOOCOMMERCE_CONSUMER_KEY");
  requireEnv("WOOCOMMERCE_CONSUMER_SECRET");

  const environment = options.env || "production";
  process.env.IMPORT_LOG_LEVEL = options.logLevel || process.env.IMPORT_LOG_LEVEL || "info";

  const { config } = buildConfig(environment);
  config.logging.level = process.env.IMPORT_LOG_LEVEL;
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

function commonOptions(cmd) {
  return cmd
    .option("--env <name>", "Target environment: production, staging, local", "production")
    .option("--limit <n>", "Max products to process")
    .option("--log-level <level>", "error | warn | info | debug");
}

async function main() {
  program.name("catalog").description("WooCommerce → Strapi catalog importer (idempotent)");

  commonOptions(program.command("dry-run").description("Preview without writing"))
    .option("--scope <name>", "full | full-sync | no-media | categories | stock | price | media", "full")
    .option("--skip-media", "Skip media upload")
    .option("--start-after-external-id <id>", "Skip Woo products with id/external_id <= this value")
    .action((opts) => run("dry-run", opts));

  commonOptions(program.command("sync").description("Apply catalog sync"))
    .option("--scope <name>", "full | full-sync | no-media | categories | stock | price | media", "full")
    .option("--skip-media", "Skip media upload")
    .option("--run-id <id>", "Optional stable run id for tracking/resume")
    .option("--start-after-external-id <id>", "Skip Woo products with id/external_id <= this value")
    .action((opts) => run("sync", opts));

  commonOptions(program.command("verify").description("Compare WooCommerce and Strapi catalogs"))
    .action((opts) => run("verify", opts));

  commonOptions(program.command("resume <runId>").description("Resume a tracked catalog run"))
    .option("--retry-failed", "Retry failed rows instead of leaving them skipped")
    .option("--pause-signal-path <path>", "Pause when this file exists")
    .action((runId, opts) => resumeRun(runId, opts));

  program
    .command("runs")
    .description("List tracked catalog runs")
    .option("--env <name>", "Target environment: production, staging, local", "production")
    .option("--limit <n>", "Max runs to show", "20")
    .option("--resumable", "Only show resumable runs")
    .action((opts) => listRuns(opts));

  program
    .command("run-status <runId>")
    .description("Show tracked catalog run details")
    .option("--env <name>", "Target environment: production, staging, local", "production")
    .action((runId, opts) => showRunStatus(runId, opts));

  program
    .command("cancel <runId>")
    .description("Request cancellation for a tracked catalog run")
    .option("--env <name>", "Target environment: production, staging, local", "production")
    .action((runId, opts) => cancelRun(runId, opts));

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
