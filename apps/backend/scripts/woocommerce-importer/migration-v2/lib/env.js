"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadSecretFile(filePath) {
  if (!filePath) return;
  const resolved = path.resolve(filePath);
  const stat = fs.statSync(resolved);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Migration secret file must be mode 600 or stricter: ${resolved}`);
  }
  for (const rawLine of fs.readFileSync(resolved, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const splitAt = line.indexOf("=");
    const key = line.slice(0, splitAt).trim();
    let value = line.slice(splitAt + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function requireSecret(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required migration secret: ${name}`);
  return value;
}

function migrationStateDir() {
  return path.resolve(process.env.MIGRATION_STATE_DIR || "/var/lib/infinity-migrations/wordpress-v2");
}

function configureSourceEnvironment() {
  loadSecretFile(process.env.MIGRATION_SECRETS_FILE);
  process.env.WOOCOMMERCE_CONSUMER_KEY ||= process.env.WC_CONSUMER_KEY || "";
  process.env.WOOCOMMERCE_CONSUMER_SECRET ||= process.env.WC_CONSUMER_SECRET || "";
  return {
    sourceBaseUrl: String(process.env.WORDPRESS_SOURCE_URL || "https://infinitycolor.co").replace(/\/$/, ""),
    wpUsername: requireSecret("WP_USERNAME"),
    wpApplicationPassword: requireSecret("WP_APPLICATION_PASSWORD"),
    wooKey: requireSecret("WOOCOMMERCE_CONSUMER_KEY"),
    wooSecret: requireSecret("WOOCOMMERCE_CONSUMER_SECRET"),
  };
}

function configureEnvironment() {
  const source = configureSourceEnvironment();
  process.env.STRAPI_API_TOKEN_PRODUCTION ||= process.env.STRAPI_TOKEN || "";

  const controlToken = requireSecret("MIGRATION_CONTROL_TOKEN");
  if (controlToken.length < 32) throw new Error("MIGRATION_CONTROL_TOKEN must be at least 32 characters");

  return {
    ...source,
    destinationBaseUrl: String(process.env.STRAPI_IMPORT_PRODUCTION_URL || "https://api.infinitycolor.co/api").replace(/\/$/, ""),
    stateDir: migrationStateDir(),
    strapiToken: requireSecret("STRAPI_API_TOKEN_PRODUCTION"),
    controlToken,
  };
}

module.exports = { loadSecretFile, configureEnvironment, configureSourceEnvironment, migrationStateDir };
