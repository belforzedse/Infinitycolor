"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const { loadSecretFile } = require("../woocommerce-importer/migration-v2/lib/env");

function boundedInt(value, { name, fallback, min = 1, max }) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`Missing Woo sync setting: ${name}`);
  return value;
}

function booleanSetting(value, { name, fallback }) {
  if (value === undefined || value === "") return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function getSyncConfig(env = process.env) {
  if (env === process.env) loadSecretFile(env.WOOCOMMERCE_SYNC_SECRETS_FILE || env.MIGRATION_SECRETS_FILE);
  const redisUrl = env.QUEUE_REDIS_URL || "redis://localhost:6379";
  const pollSeconds = boundedInt(env.WOOCOMMERCE_SYNC_POLL_SECONDS, {
    name: "WOOCOMMERCE_SYNC_POLL_SECONDS", fallback: 30, min: 15, max: 300,
  });
  const config = {
    instanceId: `${os.hostname()}:${process.pid}:${crypto.randomBytes(8).toString("hex")}`,
    timezone: env.WOOCOMMERCE_SYNC_TIMEZONE || "Asia/Tehran",
    redisUrl,
    redisPassword: env.QUEUE_REDIS_PASSWORD || undefined,
    queuePrefix: env.QUEUE_PREFIX || "bull:infinity",
    pollMs: pollSeconds * 1000,
    overlapMs: boundedInt(env.WOOCOMMERCE_SYNC_OVERLAP_SECONDS, {
      name: "WOOCOMMERCE_SYNC_OVERLAP_SECONDS", fallback: 300, min: 60, max: 3600,
    }) * 1000,
    leaseSeconds: boundedInt(env.WOOCOMMERCE_SYNC_LEASE_SECONDS, {
      name: "WOOCOMMERCE_SYNC_LEASE_SECONDS", fallback: 300, min: 60, max: 3600,
    }),
    lateCampaignHours: boundedInt(env.WOOCOMMERCE_SYNC_LATE_CAMPAIGN_HOURS, {
      name: "WOOCOMMERCE_SYNC_LATE_CAMPAIGN_HOURS", fallback: 6, min: 1, max: 24,
    }),
    schedules: {
      discovery: booleanSetting(env.WOOCOMMERCE_SYNC_ENABLE_DISCOVERY, {
        name: "WOOCOMMERCE_SYNC_ENABLE_DISCOVERY", fallback: false,
      }),
      hourly: booleanSetting(env.WOOCOMMERCE_SYNC_ENABLE_HOURLY, {
        name: "WOOCOMMERCE_SYNC_ENABLE_HOURLY", fallback: true,
      }),
      friday: booleanSetting(env.WOOCOMMERCE_SYNC_ENABLE_FRIDAY, {
        name: "WOOCOMMERCE_SYNC_ENABLE_FRIDAY", fallback: false,
      }),
    },
    variationSweepProducts: boundedInt(env.WOOCOMMERCE_SYNC_VARIATION_SWEEP_PRODUCTS, {
      name: "WOOCOMMERCE_SYNC_VARIATION_SWEEP_PRODUCTS", fallback: 100, min: 10, max: 500,
    }),
    identitySweepPages: boundedInt(env.WOOCOMMERCE_SYNC_IDENTITY_SWEEP_PAGES, {
      name: "WOOCOMMERCE_SYNC_IDENTITY_SWEEP_PAGES", fallback: 0, min: 0, max: 25,
    }),
    sourcePageConcurrency: boundedInt(env.WOOCOMMERCE_SYNC_SOURCE_PAGE_CONCURRENCY, {
      name: "WOOCOMMERCE_SYNC_SOURCE_PAGE_CONCURRENCY", fallback: 4, min: 1, max: 8,
    }),
    concurrency: {
      products: 1,
      images: boundedInt(env.IMPORT_CONCURRENCY_IMAGES, { name: "IMPORT_CONCURRENCY_IMAGES", fallback: 4, max: 16 }),
      variations: boundedInt(env.IMPORT_CONCURRENCY_VARIATIONS, { name: "IMPORT_CONCURRENCY_VARIATIONS", fallback: 8, max: 32 }),
      videos: boundedInt(env.IMPORT_CONCURRENCY_VIDEOS, { name: "IMPORT_CONCURRENCY_VIDEOS", fallback: 1, max: 2 }),
      entities: boundedInt(env.IMPORT_CONCURRENCY_ENTITIES, { name: "IMPORT_CONCURRENCY_ENTITIES", fallback: 8, max: 32 }),
      fridayInventory: boundedInt(env.WOOCOMMERCE_SYNC_FRIDAY_INVENTORY_CONCURRENCY, {
        name: "WOOCOMMERCE_SYNC_FRIDAY_INVENTORY_CONCURRENCY", fallback: 32, max: 32,
      }),
    },
    postgres: env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {
      host: env.DATABASE_HOST || "localhost",
      port: Number(env.DATABASE_PORT || 5432),
      database: env.DATABASE_NAME || "strapi",
      user: env.DATABASE_USERNAME || "strapi",
      password: required(env, "DATABASE_PASSWORD"),
      ssl: env.DATABASE_SSL === "true" ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" } : false,
    },
    source: {
      sourceBaseUrl: String(env.WORDPRESS_SOURCE_URL || "https://infinitycolor.co").replace(/\/$/, ""),
      wpUsername: required(env, "WP_USERNAME"),
      wpApplicationPassword: required(env, "WP_APPLICATION_PASSWORD"),
      wooKey: required(env, "WOOCOMMERCE_CONSUMER_KEY"),
      wooSecret: required(env, "WOOCOMMERCE_CONSUMER_SECRET"),
    },
    destination: {
      destinationBaseUrl: String(env.STRAPI_IMPORT_PRODUCTION_URL || "http://api:1337/api").replace(/\/$/, ""),
      strapiToken: required(env, "STRAPI_API_TOKEN_PRODUCTION"),
      controlToken: required(env, "MIGRATION_CONTROL_TOKEN"),
    },
    trackingDir: env.WOOCOMMERCE_SYNC_STATE_DIR || "/var/lib/infinity-sync/woocommerce",
  };
  if (config.destination.controlToken.length < 32) throw new Error("MIGRATION_CONTROL_TOKEN must be at least 32 characters");
  return config;
}

module.exports = { getSyncConfig, boundedInt, booleanSetting };
