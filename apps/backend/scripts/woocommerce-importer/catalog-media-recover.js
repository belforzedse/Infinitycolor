#!/usr/bin/env node
"use strict";

const path = require("path");
const { buildConfig } = require("./catalog/config");
const { CatalogEngine } = require("./catalog/engine");
const { CatalogRunStore } = require("./catalog/lib/runStore");
const { auditLegacyMedia, reconcileMissingProductMedia } = require("./catalog/lib/mediaRecovery");
const Logger = require("./utils/Logger");

function parse(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) options[key.slice(2)] = true;
    else { options[key.slice(2)] = next; index += 1; }
  }
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const mode = options.mode || (options.run ? "audit" : "repair");
  process.env.WOOCOMMERCE_CONSUMER_KEY ||= process.env.WC_CONSUMER_KEY || "";
  process.env.WOOCOMMERCE_CONSUMER_SECRET ||= process.env.WC_CONSUMER_SECRET || "";
  process.env.STRAPI_API_TOKEN_PRODUCTION ||= process.env.STRAPI_TOKEN || "";

  const { config } = buildConfig(options.env || "production");
  if (options["tracking-dir"]) {
    const trackingDir = path.resolve(options["tracking-dir"]);
    config.duplicateTracking.storageDir = trackingDir;
    config.catalog.trackingDirAbs = trackingDir;
  }
  const logger = new Logger({ ...config.logging, level: options["log-level"] || "warn" });
  const engine = new CatalogEngine(config, logger, { environment: options.env || "production" });

  if (mode === "audit") {
    if (!options.run || !options["tracking-dir"]) {
      throw new Error("Usage: catalog-media-recover.js --mode audit --run <id> --tracking-dir <dir> --dry-run | --confirm CatalogMediaRecovery");
    }
    if (options["dry-run"] && options.confirm) throw new Error("Choose either --dry-run or --confirm, not both");
    if (!options["dry-run"] && !options.confirm) throw new Error("Recovery requires --dry-run or --confirm CatalogMediaRecovery");
    const result = await auditLegacyMedia({
      runStore: new CatalogRunStore(path.resolve(options["tracking-dir"])),
      runId: options.run,
      woo: engine.woo,
      repo: engine.repo,
      mediaStore: engine.mediaStore,
      dryRun: Boolean(options["dry-run"]),
      confirm: options.confirm || "",
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === "repair") {
    if (options["dry-run"] && options.confirm) throw new Error("Choose either --dry-run or --confirm, not both");
    if (!options["dry-run"] && !options.confirm) {
      throw new Error("Usage: catalog-media-recover.js --mode repair --dry-run | --confirm CatalogMediaRepair [--limit N] [--concurrency N]");
    }
    const result = await reconcileMissingProductMedia({
      woo: engine.woo,
      repo: engine.repo,
      media: engine.media,
      logger,
      dryRun: Boolean(options["dry-run"]),
      confirm: options.confirm || "",
      limit: options.limit ? Number(options.limit) : Infinity,
      concurrency: options.concurrency ? Number(options.concurrency) : 2,
      startAfterExternalId: options["start-after"] ? Number(options["start-after"]) : null,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.unresolved?.length) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown mode: ${mode}. Use audit or repair.`);
}

main().catch((error) => {
  console.error(`Media recovery failed: ${error.message}`);
  process.exitCode = 1;
});
