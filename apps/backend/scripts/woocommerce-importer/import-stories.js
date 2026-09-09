#!/usr/bin/env node

/**
 * Import currently displayed WP Story Premium homepage stories into Strapi.
 *
 *   node scripts/woocommerce-importer/import-stories.js --env production --dry-run
 *   node scripts/woocommerce-importer/import-stories.js --env production --deactivate-existing
 */

const fs = require("fs");
const path = require("path");
const { parseArgs } = require("node:util");

const localNodeModules = path.join(__dirname, "node_modules");
if (fs.existsSync(localNodeModules)) {
  module.paths.unshift(localNodeModules);
}

try {
  require("dotenv").config({ path: path.join(__dirname, "../../.env") });
  require("dotenv").config({ path: path.join(__dirname, "../../.env.local") });
} catch {
  // dotenv is optional
}

const Logger = require("./utils/Logger");
const StoryImporter = require("./importers/StoryImporter");

const ENV_CONFIG = {
  production: {
    strapiUrl: process.env.STRAPI_IMPORT_PRODUCTION_URL || "https://api.infinitycolor.co/api",
    trackingDir: "./import-tracking/production",
    tokenEnv: "STRAPI_API_TOKEN_PRODUCTION",
  },
  staging: {
    strapiUrl: process.env.STRAPI_IMPORT_STAGING_URL || "https://api.staging.infinitycolor.co/api",
    trackingDir: "./import-tracking/staging",
    tokenEnv: "STRAPI_API_TOKEN_STAGING",
  },
  local: {
    strapiUrl: process.env.STRAPI_IMPORT_LOCAL_URL || "http://localhost:1337/api",
    trackingDir: "./import-tracking/local",
    tokenEnv: "STRAPI_API_TOKEN_LOCAL",
  },
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function applyEnvironment(envName) {
  const envConfig = ENV_CONFIG[envName];
  if (!envConfig) {
    throw new Error(`Unknown environment: ${envName}. Use production, staging, or local.`);
  }

  process.env.IMPORT_TRACKING_DIR = envConfig.trackingDir;

  if (envName === "production") {
    process.env.STRAPI_API_TOKEN_PRODUCTION =
      process.env.STRAPI_API_TOKEN_PRODUCTION || requireEnv("STRAPI_API_TOKEN_PRODUCTION");
    process.env.STRAPI_IMPORT_PRODUCTION_URL =
      process.env.STRAPI_IMPORT_PRODUCTION_URL || envConfig.strapiUrl;
  } else if (envName === "staging") {
    process.env.STRAPI_API_TOKEN_STAGING =
      process.env.STRAPI_API_TOKEN_STAGING || requireEnv(envConfig.tokenEnv);
  } else {
    process.env.STRAPI_API_TOKEN =
      process.env.STRAPI_API_TOKEN_LOCAL || process.env.STRAPI_API_TOKEN || requireEnv(envConfig.tokenEnv);
  }

  return envConfig;
}

function buildConfig(envName, envConfig) {
  const config = require("./config");
  config.strapi.baseUrl = envConfig.strapiUrl;
  config.strapi.usePublicAccess = false;
  config.duplicateTracking.storageDir = envConfig.trackingDir;

  if (envName === "production") {
    config.strapi.auth.token = process.env.STRAPI_API_TOKEN_PRODUCTION.trim();
  } else if (envName === "staging") {
    config.strapi.auth.token = (process.env.STRAPI_API_TOKEN_STAGING || "").trim();
  } else {
    config.strapi.auth.token = (
      process.env.STRAPI_API_TOKEN_LOCAL ||
      process.env.STRAPI_API_TOKEN ||
      ""
    ).trim();
  }

  if (!config.strapi.auth.token) {
    throw new Error(`Missing Strapi API token for ${envName}`);
  }

  return config;
}

async function main() {
  const { values } = parseArgs({
    options: {
      env: { type: "string", default: "production" },
      "dry-run": { type: "boolean", default: false },
      "deactivate-existing": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`Usage: import-stories.js [--env production|staging|local] [--dry-run] [--deactivate-existing]`);
    return;
  }

  const envName = String(values.env || "production").trim();
  const envConfig = applyEnvironment(envName);
  const config = buildConfig(envName, envConfig);
  const logger = new Logger({ level: process.env.IMPORT_LOG_LEVEL || "info" });

  logger.info(`🎯 Target: ${config.strapi.baseUrl} (${envName})`);

  const importer = new StoryImporter(config, logger);
  const stats = await importer.import({
    dryRun: Boolean(values["dry-run"]),
    deactivateExisting: Boolean(values["deactivate-existing"]),
  });

  if (stats.failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Story import failed:", error.message || error);
  process.exit(1);
});
