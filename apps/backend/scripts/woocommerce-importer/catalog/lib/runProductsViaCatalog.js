"use strict";

/**
 * Shared helper: run product (and optional category) import via CatalogEngine.
 * Used by interactive / dashboard so they never write product media through legacy ProductImporter.
 */

const path = require("path");
const { CatalogEngine } = require("../engine");
const { parsePublicationOptions } = require("./publication");

/**
 * @param {object} opts
 * @param {object} opts.logger
 * @param {object} [opts.config] existing importer config (preferred when interactive already configured Strapi)
 * @param {string} [opts.environment]
 * @param {boolean} [opts.dryRun]
 * @param {number} [opts.limit]
 * @param {boolean} [opts.skipMedia]
 * @param {boolean} [opts.skipCategories]
 * @param {object|null} [opts.publication]
 * @param {Record<string, unknown>} [opts.publicationRaw] raw CLI-style bag
 * @param {object} [opts.configOverrides] shallow merge onto catalog config.import
 */
async function runProductsViaCatalog(opts = {}) {
  let config = opts.config;
  const environment = opts.environment || "local";

  if (!config) {
    const { buildConfig } = require("../config");
    const built = buildConfig(environment);
    config = built.config || built;
  }

  // Ensure catalog knobs exist when reusing legacy interactive config.
  if (!config.catalog) {
    config.catalog = {
      allowHttpMedia: environment === "local" || process.env.IMPORT_MEDIA_ALLOW_HTTP === "true",
      perPage: Number.parseInt(process.env.IMPORT_BATCH_PRODUCTS || "100", 10),
      maxRetries: Number.parseInt(process.env.IMPORT_ERROR_MAX_RETRIES || "4", 10),
      baseRetryDelay: Number.parseInt(process.env.IMPORT_ERROR_RETRY_DELAY || "1000", 10),
      trackingDirAbs: path.resolve(
        process.cwd(),
        config.duplicateTracking?.storageDir || `./import-tracking/${environment}`,
      ),
      concurrency: {
        products: 1,
        variations: 8,
        images: 4,
        videos: 1,
        entities: 8,
      },
    };
  }

  if (opts.configOverrides?.images) {
    config.import.images = { ...config.import.images, ...opts.configOverrides.images };
  }

  const publication =
    opts.publication ||
    (opts.publicationRaw ? parsePublicationOptions(opts.publicationRaw) : null);

  const engine = new CatalogEngine(config, opts.logger, { environment, publication });
  const skipMedia = Boolean(opts.skipMedia);
  const skipCategories = opts.skipCategories !== false;
  const scope = skipMedia
    ? skipCategories
      ? "product-no-media"
      : "no-media"
    : skipCategories
      ? "full-sync"
      : "full";

  const report = await engine.runSync({
    dryRun: Boolean(opts.dryRun),
    scope,
    skipMedia,
    limit: opts.limit != null ? Number(opts.limit) : Infinity,
    publication,
  });

  const json = typeof report.toJSON === "function" ? report.toJSON() : report;
  const products = json.products || {};
  return {
    total: Number(products.seen || products.processed || 0),
    success: Number(products.created || 0) + Number(products.updated || 0),
    skipped: Number(products.skipped || 0),
    failed: Number(products.failed || (json.failures || []).length || 0),
    report,
    hasFailures: typeof report.hasFailures === "function" ? report.hasFailures() : false,
    trackingDir: path.resolve(
      process.cwd(),
      config.duplicateTracking?.storageDir || `./import-tracking/${environment}`,
    ),
  };
}

module.exports = { runProductsViaCatalog };
