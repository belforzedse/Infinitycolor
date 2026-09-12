#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { parseArgs } = require("node:util");
const { Pool } = require("pg");
const { createClient } = require("redis");

try {
  require("dotenv").config({ path: path.join(__dirname, "../.env") });
  require("dotenv").config({ path: path.join(__dirname, "../.env.local") });
} catch {}

const { buildConfig } = require("./woocommerce-importer/catalog/config");
const { CatalogEngine } = require("./woocommerce-importer/catalog/engine");
const Logger = require("./woocommerce-importer/utils/Logger");
const { getSyncConfig } = require("./woocommerce-sync/config");
const Repair = require("./woocommerce-importer/catalog/lib/variationAttributeRepair");

const LOCK_CLASS = 845734;
const LOCK_KEY = 1;

function parseCliArgs(argv) {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    options: {
      target: { type: "string", default: "local" },
      apply: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      "confirm-production": { type: "string" },
      "product-external-id": { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (parsed.positionals.length > 0) throw new Error("Unexpected positional arguments");
  const options = {
    target: parsed.values.target,
    apply: parsed.values.apply,
    verify: parsed.values.verify,
    confirmProduction: parsed.values["confirm-production"] || "",
    productExternalIds: parsed.values["product-external-id"] || [],
    help: parsed.values.help,
  };
  if (!['local', 'staging', 'production'].includes(options.target)) throw new Error("Unknown target");
  if (options.apply && options.verify) throw new Error("--apply and --verify are mutually exclusive");
  if (options.apply && options.target === "production" && options.confirmProduction !== "infinity-prod") {
    throw new Error("Production apply requires --confirm-production infinity-prod");
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/repair-woocommerce-variation-attributes.js --target <environment> [--apply|--verify]",
    "Default mode is dry-run. Production mutation requires --target production --apply --confirm-production infinity-prod.",
    "Optional: --product-external-id <Woo id> (repeatable).",
  ].join("\n");
}

const jsonArray = (value) => Array.isArray(value) ? value : [];

async function loadSnapshot(pool, productExternalIds = []) {
  const params = [];
  const filter = productExternalIds.length > 0
    ? ` AND p.external_id = ANY($${params.push(productExternalIds.map(String))}::text[])`
    : "";
  const assignmentResult = await pool.query(`
    SELECT p.id AS product_id, p.external_id AS product_external_id, p.slug,
           paa.id AS assignment_id, paa.external_id AS assignment_external_id,
           pa.id AS attribute_id, pa.external_id AS definition_external_id,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object('id', pat.id, 'externalId', pat.external_id)
                              ORDER BY pat.id)
             FROM product_attribute_assignments_terms_links patl
             JOIN product_attribute_terms pat ON pat.id = patl.product_attribute_term_id
             WHERE patl.product_attribute_assignment_id = paa.id
           ), '[]'::jsonb) AS terms
    FROM products p
    JOIN product_attribute_assignments_product_links papl ON papl.product_id = p.id
    JOIN product_attribute_assignments paa ON paa.id = papl.product_attribute_assignment_id
    JOIN product_attribute_assignments_product_attribute_links paal
      ON paal.product_attribute_assignment_id = paa.id
    JOIN product_attributes pa ON pa.id = paal.product_attribute_id
    WHERE p.external_source = 'woocommerce'
      AND paa.is_variation IS TRUE
      AND pa.legacy_projection = 'None'${filter}
    ORDER BY p.id, paa.id
  `, params);

  const products = new Map();
  for (const row of assignmentResult.rows) {
    let product = products.get(Number(row.product_id));
    if (!product) {
      product = {
        id: Number(row.product_id), externalId: String(row.product_external_id), slug: row.slug,
        genericAssignments: [], variations: [],
      };
      products.set(product.id, product);
    }
    product.genericAssignments.push({
      id: Number(row.assignment_id), externalId: row.assignment_external_id,
      attributeId: Number(row.attribute_id), definitionExternalId: row.definition_external_id,
      terms: jsonArray(row.terms),
    });
  }

  if (products.size === 0) return { products: [], legacyMaps: { Color: new Map(), Size: new Map(), Model: new Map() } };
  const productIds = [...products.keys()];
  const variationResult = await pool.query(`
    SELECT pv.id, pv.external_id, pv.sku, pv.price, pv.discount_price, pv.is_published,
      COALESCE(pv.attribute_signature, '') AS attribute_signature,
      COALESCE((SELECT array_agg(product_id ORDER BY product_id)
                FROM product_variations_product_links WHERE product_variation_id = pv.id), '{}') AS product_ids,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', ps.id, 'count', ps.count,
                        'reservedCount', ps.reserved_count) ORDER BY ps.id)
                FROM product_variations_product_stock_links psl
                JOIN product_stocks ps ON ps.id = psl.product_stock_id
                WHERE psl.product_variation_id = pv.id), '[]'::jsonb) AS stocks,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', pat.id, 'externalId', pat.external_id,
                        'attributeId', pa.id, 'definitionExternalId', pa.external_id) ORDER BY pat.id)
                FROM product_variations_selected_attribute_terms_links pvtl
                JOIN product_attribute_terms pat ON pat.id = pvtl.product_attribute_term_id
                LEFT JOIN product_attribute_terms_product_attribute_links patal
                  ON patal.product_attribute_term_id = pat.id
                LEFT JOIN product_attributes pa ON pa.id = patal.product_attribute_id
                WHERE pvtl.product_variation_id = pv.id), '[]'::jsonb) AS selected_terms,
      COALESCE((SELECT array_agg(product_variation_color_id ORDER BY product_variation_color_id)
                FROM product_variations_product_variation_color_links WHERE product_variation_id = pv.id), '{}') AS color_ids,
      COALESCE((SELECT array_agg(product_variation_size_id ORDER BY product_variation_size_id)
                FROM product_variations_product_variation_size_links WHERE product_variation_id = pv.id), '{}') AS size_ids,
      COALESCE((SELECT array_agg(product_variation_model_id ORDER BY product_variation_model_id)
                FROM product_variations_product_variation_model_links WHERE product_variation_id = pv.id), '{}') AS model_ids
    FROM product_variations pv
    JOIN product_variations_product_links pvl ON pvl.product_variation_id = pv.id
    WHERE pvl.product_id = ANY($1::int[]) AND pv.external_source = 'woocommerce'
    ORDER BY pv.id
  `, [productIds]);
  for (const row of variationResult.rows) {
    const productId = Number(row.product_ids?.[0]);
    const product = products.get(productId);
    if (!product) continue;
    product.variations.push({
      id: Number(row.id), externalId: String(row.external_id), sku: row.sku,
      price: row.price === null ? null : String(row.price),
      discountPrice: row.discount_price === null ? null : String(row.discount_price),
      isPublished: row.is_published === true, attributeSignature: row.attribute_signature,
      productIds: (row.product_ids || []).map(Number), stocks: jsonArray(row.stocks),
      selectedTerms: jsonArray(row.selected_terms), colorIds: (row.color_ids || []).map(Number),
      sizeIds: (row.size_ids || []).map(Number), modelIds: (row.model_ids || []).map(Number),
    });
  }

  const legacyMaps = { Color: new Map(), Size: new Map(), Model: new Map() };
  for (const [projection, table] of Object.entries({
    Color: "product_variation_colors", Size: "product_variation_sizes", Model: "product_variation_models",
  })) {
    const result = await pool.query(`SELECT id, external_id FROM ${table} WHERE external_source = 'woocommerce'`);
    for (const row of result.rows) {
      const rows = legacyMaps[projection].get(String(row.external_id)) || [];
      rows.push(Number(row.id));
      legacyMaps[projection].set(String(row.external_id), rows);
    }
  }
  return { products: [...products.values()], legacyMaps };
}

async function buildPlan({ classified, legacyMaps, engine, registry }) {
  const actions = [];
  const ambiguous = [];
  for (const product of classified.products.filter((row) => row.classification.status !== "healthy")) {
    if (product.classification.status === "ambiguous") {
      ambiguous.push({ productId: product.id, externalId: product.externalId, reasons: product.classification.reasons });
      continue;
    }
    try {
      const sourceProduct = await engine.woo.fetchProductById(product.externalId);
      if (!sourceProduct) throw new Error("SOURCE_PRODUCT_MISSING");
      const sourceVariations = await engine.woo.fetchAllVariations(product.externalId);
      const sourceById = new Map();
      for (const variation of sourceVariations) {
        const key = String(variation.id);
        if (sourceById.has(key)) throw new Error(`SOURCE_VARIATION_AMBIGUOUS:${key}`);
        sourceById.set(key, variation);
      }
      const context = Repair.resolveProductPlan(product, sourceProduct, registry, legacyMaps);
      const productActions = [];
      for (const variation of product.variations) {
        const sourceVariation = sourceById.get(String(variation.externalId));
        if (!sourceVariation) throw new Error(`SOURCE_VARIATION_MISSING:${variation.externalId}`);
        const desired = Repair.desiredForVariation(sourceVariation, context);
        if (Repair.variationNeedsRepair(variation, desired)) {
          productActions.push({
            productId: product.id, productExternalId: product.externalId, slug: product.slug,
            variationId: variation.id, variationExternalId: variation.externalId,
            before: {
              selectedTermIds: variation.selectedTerms.map((term) => Number(term.id)).sort((a, b) => a - b),
              attributeSignature: variation.attributeSignature || null,
            },
            after: {
              selectedTermIds: desired.selected_attribute_terms,
              attributeSignature: desired.AttributeSignature,
            },
            desired,
          });
        }
      }
      actions.push(...productActions);
    } catch (error) {
      ambiguous.push({
        productId: product.id, externalId: product.externalId,
        reasons: [String(error.code || error.message || error).slice(0, 240)],
      });
    }
  }
  return { actions, ambiguous };
}

async function purgeAndRevalidate(slugs, syncConfig) {
  const uniqueSlugs = [...new Set(slugs.filter(Boolean))];
  const redis = createClient({ url: syncConfig.redisUrl, password: syncConfig.redisPassword });
  await redis.connect();
  let cacheKeysRemoved = 0;
  try {
    for await (const key of redis.scanIterator({ MATCH: "endpoint-cache:product.*", COUNT: 100 })) {
      cacheKeysRemoved += await redis.del(key);
    }
  } finally {
    await redis.quit();
  }
  const origins = String(process.env.NEXTJS_REVALIDATION_URL || process.env.FRONTEND_URL || "")
    .split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
  const secret = String(process.env.REVALIDATION_SECRET || "");
  if (origins.length === 0 || !secret) throw new Error("STOREFRONT_REVALIDATION_NOT_CONFIGURED");
  let revalidated = 0;
  for (const origin of origins) {
    for (const slug of uniqueSlugs) {
      const response = await fetch(`${origin}/api/revalidate`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ type: "product", path: slug }),
      });
      if (!response.ok) throw new Error(`STOREFRONT_REVALIDATION_FAILED:${response.status}`);
      revalidated += 1;
    }
  }
  return { cacheKeysRemoved, revalidated };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const { config } = buildConfig(options.target);
  const syncConfig = getSyncConfig();
  const logger = new Logger({ ...config.logging, level: "warn" });
  const engine = new CatalogEngine(config, logger, { environment: options.target });
  const pool = new Pool({ ...syncConfig.postgres, max: 2, idleTimeoutMillis: 10_000 });
  let lockClient = null;
  try {
    await engine.preflight();
    const snapshot = await loadSnapshot(pool, options.productExternalIds);
    const classified = Repair.classifyPopulation(snapshot.products);
    const registry = await engine.woo.fetchGlobalAttributeRegistry();
    const plan = await buildPlan({ classified, legacyMaps: snapshot.legacyMaps, engine, registry });
    const mode = options.apply ? "apply" : options.verify ? "verify" : "dry-run";
    const report = {
      mode, target: options.target, population: classified.summary,
      deterministicChanges: plan.actions.length, ambiguousProducts: plan.ambiguous,
      changes: plan.actions.map(({ desired: _desired, ...action }) => action),
    };
    console.log(JSON.stringify(report, null, 2));
    if (options.verify) {
      if (plan.actions.length > 0) process.exitCode = 1;
      return;
    }
    if (!options.apply) return;
    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock($1, $2)", [LOCK_CLASS, LOCK_KEY]);
    const lockedSnapshot = await loadSnapshot(lockClient, options.productExternalIds);
    const lockedClassified = Repair.classifyPopulation(lockedSnapshot.products);
    const lockedPlan = await buildPlan({
      classified: lockedClassified, legacyMaps: lockedSnapshot.legacyMaps, engine, registry,
    });
    if (JSON.stringify(lockedPlan.actions) !== JSON.stringify(plan.actions)) {
      throw new Error("REPAIR_PLAN_CHANGED_AFTER_LOCK");
    }
    const identitiesBefore = lockedSnapshot.products.flatMap((product) => product.variations);
    for (const action of lockedPlan.actions) {
      await engine.repo.http.put(`/product-variations/${action.variationId}`, {
        data: {
          selected_attribute_terms: action.desired.selected_attribute_terms,
          AttributeSignature: action.desired.AttributeSignature,
        },
      });
      const check = await engine.verifyVariationAttributeRelations(action.variationId, action.desired);
      if (!check.ok) throw new Error(`REPAIR_RELATION_READBACK_FAILED:${action.variationId}:${check.error}`);
    }
    const afterSnapshot = await loadSnapshot(lockClient, options.productExternalIds);
    Repair.assertIdentityUnchanged(
      identitiesBefore,
      afterSnapshot.products.flatMap((product) => product.variations),
    );
    const afterClassified = Repair.classifyPopulation(afterSnapshot.products);
    const afterPlan = await buildPlan({
      classified: afterClassified, legacyMaps: afterSnapshot.legacyMaps, engine, registry,
    });
    if (afterPlan.actions.length > 0) {
      throw new Error("REPAIR_POST_APPLY_VERIFICATION_FAILED");
    }
    const cache = await purgeAndRevalidate(
      lockedPlan.actions.map((action) => action.slug),
      syncConfig,
    );
    console.log(JSON.stringify({
      mode: "apply-complete", changed: lockedPlan.actions.length,
      identityPreserved: true, remainingChanges: 0, ...cache,
    }, null, 2));
  } finally {
    if (lockClient) {
      await lockClient.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_CLASS, LOCK_KEY]).catch(() => undefined);
      lockClient.release();
    }
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: String(error.code || error.message || error).slice(0, 500) }));
    process.exitCode = 1;
  });
}

module.exports = { parseCliArgs, loadSnapshot, buildPlan, purgeAndRevalidate, main };
