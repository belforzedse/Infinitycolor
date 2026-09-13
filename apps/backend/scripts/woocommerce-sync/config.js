"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const { loadSecretFile } = require("../woocommerce-importer/migration-v2/lib/env");
const { resolveImportProfile, profileDefault } = require("../woocommerce-importer/catalog/lib/concurrency");

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

/**
 * Which shape the nightly campaign runs in.
 *
 *  - "full"    today's stage sequence, unchanged:
 *              new-products -> catalog-full -> stock -> price -> users/wallets -> orders
 *  - "cutover" the 5-hour window shape: catalog-full runs *concurrently* with
 *              users/wallets, then orders, then a single combined
 *              stock+price inventory pass restricted to sellable products.
 *
 * Deliberately NOT folded into WOOCOMMERCE_IMPORT_PROFILE: that knob's contract
 * is "defaults only, never behaviour", and having two different things named
 * "fast" at 01:00 on cutover night is an operator hazard.
 */
const CAMPAIGN_VARIANTS = Object.freeze(["full", "cutover"]);

function resolveCampaignVariant(value) {
  const raw = String(value || "full").trim().toLowerCase() || "full";
  if (!CAMPAIGN_VARIANTS.includes(raw)) {
    throw new Error(
      `WOOCOMMERCE_SYNC_CAMPAIGN_VARIANT must be one of ${CAMPAIGN_VARIANTS.join(", ")}; received "${raw}"`,
    );
  }
  return raw;
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
  // WOOCOMMERCE_IMPORT_PROFILE=fast only changes which *default* a
  // concurrency knob below falls back to when its own env var is unset — an
  // explicit IMPORT_CONCURRENCY_* / WOOCOMMERCE_SYNC_FRIDAY_* value always
  // wins, and "default" (unset) reproduces today's exact values.
  const importProfile = resolveImportProfile(env);
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
      // Nightly full cutover (products/media/stock/price/users/orders). Off by
      // default in code; production enables it explicitly.
      friday: booleanSetting(env.WOOCOMMERCE_SYNC_ENABLE_FRIDAY, {
        name: "WOOCOMMERCE_SYNC_ENABLE_FRIDAY", fallback: false,
      }),
      // Off by default, unlike `hourly` — full-catalog reconciliation is a
      // higher-blast-radius capability (it enumerates and can write across the
      // entire catalog) that should be turned on deliberately after review,
      // not silently active on every deploy.
      reconcile: booleanSetting(env.WOOCOMMERCE_SYNC_ENABLE_RECONCILE, {
        name: "WOOCOMMERCE_SYNC_ENABLE_RECONCILE", fallback: false,
      }),
    },
    // Nightly cutover wall-clock (Asia/Tehran by default). Daily at 23:59 —
    // once per night, not rapid/frequent.
    fridayCron: env.WOOCOMMERCE_SYNC_FRIDAY_CRON || "59 23 * * *",
    // Cron cadence for full-catalog reconciliation, off-peak by default.
    // Unlike hourly/friday's cadence (hardcoded), this is configurable per the
    // requirement that reconciliation cadence live in normal app config.
    reconcileCron: env.WOOCOMMERCE_SYNC_RECONCILE_CRON || "30 2 * * *",
    campaignVariant: resolveCampaignVariant(env.WOOCOMMERCE_SYNC_CAMPAIGN_VARIANT),
    // Rehearsal-only cross-check: re-read every non-zero wallet balance (plus a
    // sample of zeroes) through the per-id endpoint and count divergences from
    // the bulk list. Must report 0 before the real cutover runs without it.
    walletVerify: booleanSetting(env.WOOCOMMERCE_SYNC_WALLET_VERIFY, {
      name: "WOOCOMMERCE_SYNC_WALLET_VERIFY", fallback: false,
    }),
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
      images: boundedInt(env.IMPORT_CONCURRENCY_IMAGES, {
        name: "IMPORT_CONCURRENCY_IMAGES", fallback: profileDefault(importProfile, { default: 4, fast: 8 }), max: 16,
      }),
      variations: boundedInt(env.IMPORT_CONCURRENCY_VARIATIONS, {
        name: "IMPORT_CONCURRENCY_VARIATIONS", fallback: profileDefault(importProfile, { default: 8, fast: 16 }), max: 32,
      }),
      videos: boundedInt(env.IMPORT_CONCURRENCY_VIDEOS, { name: "IMPORT_CONCURRENCY_VIDEOS", fallback: 1, max: 2 }),
      entities: boundedInt(env.IMPORT_CONCURRENCY_ENTITIES, {
        name: "IMPORT_CONCURRENCY_ENTITIES", fallback: profileDefault(importProfile, { default: 8, fast: 24 }), max: 32,
      }),
      // Nightly cutover runs off-peak with a large catalog — allow high parallelism.
      // fridayInventory is already at its ceiling (max 32); with ~8.6 variations/product
      // on average, per-product variation concurrency was never the bottleneck — see
      // fridayProducts below, which is.
      fridayInventory: boundedInt(env.WOOCOMMERCE_SYNC_FRIDAY_INVENTORY_CONCURRENCY, {
        name: "WOOCOMMERCE_SYNC_FRIDAY_INVENTORY_CONCURRENCY", fallback: 32, max: 32,
      }),
      fridayImages: boundedInt(env.WOOCOMMERCE_SYNC_FRIDAY_IMAGE_CONCURRENCY, {
        name: "WOOCOMMERCE_SYNC_FRIDAY_IMAGE_CONCURRENCY",
        fallback: profileDefault(importProfile, { default: 12, fast: 16 }), max: 16,
      }),
      fridayEntities: boundedInt(env.WOOCOMMERCE_SYNC_FRIDAY_ENTITY_CONCURRENCY, {
        name: "WOOCOMMERCE_SYNC_FRIDAY_ENTITY_CONCURRENCY",
        fallback: profileDefault(importProfile, { default: 24, fast: 32 }), max: 32,
      }),
      // Product *parents* during the friday campaign's catalog-full stage stay
      // serial regardless of this value (CatalogEngine#resolveProductConcurrency
      // forces it for any scope that writes products/tags/attributes/media).
      // It only actually parallelizes the "stock" and "price" stages, which is
      // where most of the 90-minute-each cost lived (a fully sequential
      // per-product loop, not variation concurrency — see AGENTS.md task notes).
      fridayProducts: boundedInt(env.WOOCOMMERCE_SYNC_FRIDAY_PRODUCT_CONCURRENCY, {
        name: "WOOCOMMERCE_SYNC_FRIDAY_PRODUCT_CONCURRENCY",
        fallback: profileDefault(importProfile, { default: 1, fast: 4 }), max: 6,
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
    // How long any Woo-bound stage will hold, waiting for an unreachable source
    // to answer again, before the campaign gives up with SOURCE_UNAVAILABLE.
    // A 2026-09-13 cutover died because a ~4 minute Woo outage exhausted the
    // preflight retry budget outright. See migration-v2/lib/sourceGate.js.
    sourceHoldMaxMs: Number(env.WOOCOMMERCE_SYNC_SOURCE_HOLD_MAX_MS || 60 * 60 * 1000),
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

module.exports = { getSyncConfig, boundedInt, booleanSetting, resolveCampaignVariant, CAMPAIGN_VARIANTS };
