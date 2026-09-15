#!/usr/bin/env node
"use strict";

/**
 * Compare WooCommerce products with Woo-sourced Strapi products and,
 * when explicitly confirmed, import only selected missing ids.
 *
 * This is deliberately not a catalog campaign. The write path feeds a frozen
 * set of individually fetched products into CatalogEngine's product-only and
 * media-only scopes, so categories, category editorial, users and orders are
 * never enumerated or changed.
 *
 * Examples (inside the production sync container):
 *   node scripts/woocommerce-sync/sync-missing-products.js diff
 *   node scripts/woocommerce-sync/sync-missing-products.js apply \
 *     --ids 1298820,1298902 --confirm WooMissingProductsSync
 *   node scripts/woocommerce-sync/sync-missing-products.js apply \
 *     --all-missing --unmanaged-stock zero --confirm WooMissingProductsSync
 */

const fs = require("node:fs");
const path = require("node:path");

// When this file is streamed to `node -`, __dirname is the working directory.
// Accept that no-image-build operator path while still working as a normal file.
const APP_ROOT = fs.existsSync(path.join(process.cwd(), "scripts/woocommerce-sync/service.js"))
  ? process.cwd()
  : path.resolve(__dirname, "../..");
const importerModules = path.join(APP_ROOT, "scripts/woocommerce-importer/node_modules");
if (fs.existsSync(importerModules)) module.paths.unshift(importerModules);

const APPLY_CONFIRMATION = "WooMissingProductsSync";
const ALLOWED_STATUSES = new Set(["publish", "draft", "pending", "private", "future", "any"]);

function parseIdList(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const ids = String(raw).split(",").map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("--ids requires at least one WooCommerce id");
  for (const id of ids) {
    if (!/^\d+$/.test(id)) {
      throw new Error(`--ids expects numeric WooCommerce ids; received "${id}"`);
    }
  }
  return [...new Set(ids)];
}

function usage() {
  return `Usage: sync-missing-products.js diff [--status any]
       sync-missing-products.js apply (--ids ID,... | --all-missing)
         --confirm ${APPLY_CONFIRMATION} [--status any]
         [--unmanaged-stock zero]

The default command is diff. Apply is add-only and refuses ids that are not in
the fresh missing-product snapshot. --unmanaged-stock zero permits otherwise
ineligible products but forces every imported stock row to zero. WooCommerce is
read-only.`;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "diff";
  if (!new Set(["diff", "apply"]).has(command)) throw new Error(usage());
  const options = {
    status: "any",
    ids: null,
    allMissing: false,
    confirm: null,
    unmanagedStock: null,
  };
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--all-missing") {
      options.allMissing = true;
      continue;
    }
    if (!new Set(["--status", "--ids", "--confirm", "--unmanaged-stock"]).has(flag)) {
      throw new Error(`Unknown option: ${flag}\n\n${usage()}`);
    }
    if (args.length === 0) throw new Error(`${flag} requires a value`);
    const value = args.shift();
    if (flag === "--status") options.status = value;
    if (flag === "--ids") options.ids = parseIdList(value);
    if (flag === "--confirm") options.confirm = value;
    if (flag === "--unmanaged-stock") options.unmanagedStock = value;
  }
  if (!ALLOWED_STATUSES.has(options.status)) {
    throw new Error(`Unsupported --status ${options.status}; use ${[...ALLOWED_STATUSES].join(", ")}`);
  }
  if (options.unmanagedStock !== null && options.unmanagedStock !== "zero") {
    throw new Error("--unmanaged-stock only supports zero");
  }
  if (command === "apply") {
    if (options.confirm !== APPLY_CONFIRMATION) {
      throw new Error(`apply requires --confirm ${APPLY_CONFIRMATION}`);
    }
    if (Boolean(options.ids) === options.allMissing) {
      throw new Error("apply requires exactly one of --ids or --all-missing");
    }
  }
  return { command, options };
}

function entityExternalId(entity) {
  return String(entity?.attributes?.external_id ?? entity?.external_id ?? "");
}

function buildDiff(sourceProducts, destinationEntities) {
  const destinationIds = new Set(destinationEntities.map(entityExternalId).filter(Boolean));
  const sourceIds = new Set(sourceProducts.map((product) => String(product.id)));
  const missing = sourceProducts
    .filter((product) => !destinationIds.has(String(product.id)))
    .map((product) => ({
      id: String(product.id),
      name: String(product.name || ""),
      slug: String(product.slug || ""),
      status: String(product.status || ""),
      type: String(product.type || ""),
      modifiedGmt: product.date_modified_gmt || null,
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const appOnly = [...destinationIds]
    .filter((id) => !sourceIds.has(id))
    .sort((a, b) => Number(a) - Number(b));
  return {
    comparedAt: new Date().toISOString(),
    sourceCount: sourceIds.size,
    appWooCount: destinationIds.size,
    missingCount: missing.length,
    missing,
    appOnlyCount: appOnly.length,
    appOnly,
  };
}

function selectMissingIds(diff, options) {
  const missingIds = new Set(diff.missing.map((product) => product.id));
  const selected = options.allMissing ? [...missingIds] : options.ids || [];
  const notMissing = selected.filter((id) => !missingIds.has(String(id)));
  if (notMissing.length > 0) {
    throw new Error(`Refusing ids that are not currently missing: ${notMissing.join(",")}`);
  }
  return selected.map(String);
}

async function compare(engine, status) {
  await engine.preflight();
  const sourceProducts = [];
  for await (const product of engine.woo.iterateProducts({
    params: {
      status,
      _fields: "id,name,slug,status,type,date_modified_gmt",
    },
  })) {
    sourceProducts.push(product);
  }
  const destinationEntities = await engine.repo.fetchAllWooEntities("/products");
  return buildDiff(sourceProducts, destinationEntities);
}

function failuresToObject(failures) {
  return Object.fromEntries([...failures.entries()].sort(([a], [b]) => Number(a) - Number(b)));
}

/**
 * One-run compatibility shim for Woo products whose stock is not quantity
 * managed. It changes only this process' in-memory transform module: the normal
 * importer remains fail-closed. Every sellable unit, including otherwise
 * managed variations on a mixed product, is written with Count=0 so the
 * imported product cannot become purchasable accidentally.
 */
function installZeroStockOverride() {
  const transforms = require(path.join(
    APP_ROOT,
    "scripts/woocommerce-importer/catalog/lib/transforms",
  ));
  const originalEligibility = transforms.evaluateProductStockEligibility;
  const originalMapStock = transforms.mapStock;
  transforms.evaluateProductStockEligibility = () => ({
    eligible: true,
    reason: null,
    unmanagedVariationIds: [],
  });
  transforms.mapStock = (entity) => originalMapStock({
    ...entity,
    manage_stock: true,
    stock_quantity: 0,
  });
  return () => {
    transforms.evaluateProductStockEligibility = originalEligibility;
    transforms.mapStock = originalMapStock;
  };
}

async function execute(parsed) {
  const { WooSyncService } = require(path.join(APP_ROOT, "scripts/woocommerce-sync/service"));
  const { getSyncConfig } = require(path.join(APP_ROOT, "scripts/woocommerce-sync/config"));
  const service = new WooSyncService(getSyncConfig());
  try {
    const diff = await compare(service.catalogEngine(), parsed.options.status);
    if (parsed.command === "diff") {
      console.log(JSON.stringify({ scope: parsed.options.status, ...diff }, null, 2));
      return { ok: true, diff };
    }

    const selectedIds = selectMissingIds(diff, parsed.options);
    const restoreStockTransforms = parsed.options.unmanagedStock === "zero"
      ? installZeroStockOverride()
      : () => {};
    let result;
    try {
      result = await service.withLease("drain:hourly", async () => {
        const rows = selectedIds.map((source_id) => ({ source_id: Number(source_id) }));
        const productFailures = await service.processProductRows(rows, "product-no-media");
        const mediaFailures = await service.processProductRows(rows, "media");
        return {
          selectedIds,
          unmanagedStock: parsed.options.unmanagedStock,
          productFailures: failuresToObject(productFailures),
          mediaFailures: failuresToObject(mediaFailures),
        };
      });
    } finally {
      restoreStockTransforms();
    }
    if (result?.skipped) throw new Error(`Import lease unavailable: ${result.reason}`);

    const afterEntities = await service.catalogEngine().repo.fetchAllWooEntities("/products");
    const afterIds = new Set(afterEntities.map(entityExternalId).filter(Boolean));
    const stillMissing = selectedIds.filter((id) => !afterIds.has(id));
    const output = {
      scope: parsed.options.status,
      before: {
        sourceCount: diff.sourceCount,
        appWooCount: diff.appWooCount,
        missingCount: diff.missingCount,
      },
      ...result,
      stillMissing,
      ok:
        Object.keys(result.productFailures).length === 0
        && Object.keys(result.mediaFailures).length === 0
        && stillMissing.length === 0,
    };
    console.log(`MISSING_PRODUCT_SYNC_RESULT ${JSON.stringify(output)}`);
    if (!output.ok) process.exitCode = 1;
    return output;
  } finally {
    await service.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(usage());
    return;
  }
  await execute(parsed);
}

if (require.main === module || process.argv[1] === "-") {
  main().catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  APPLY_CONFIRMATION,
  buildDiff,
  parseArgs,
  parseIdList,
  selectMissingIds,
  installZeroStockOverride,
};
