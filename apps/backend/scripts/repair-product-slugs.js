#!/usr/bin/env node
"use strict";

/**
 * Decode percent-encoded product slugs in Strapi (dry-run by default).
 *
 * Background: the catalog importer used to store WooCommerce slugs verbatim,
 * including percent-encoding. 1402 of 2940 production products have slugs like
 * `%d8%b3%d8%aa-…-y00574`. The storefront always requests the decoded Persian
 * form, so those products were unreachable until findBySlug gained a candidate
 * set. This script makes the *stored* canonical form match the human URL.
 *
 * Usage:
 *   node scripts/repair-product-slugs.js --env production            # dry-run
 *   node scripts/repair-product-slugs.js --env production --confirm  # write
 *
 * Safety:
 * - Aborts if decoding any slug would collide with another product's slug.
 * - Writes a redirect map JSON of old → new for SEO follow-up.
 * - Never deletes products.
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

function safeDecode(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

function parseArgs(argv) {
  const args = { env: "local", confirm: false, pageSize: 100, outDir: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--confirm") args.confirm = true;
    else if (a === "--env") args.env = argv[++i];
    else if (a === "--page-size") args.pageSize = Number(argv[++i]) || 100;
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function resolveStrapiConfig(envName) {
  const map = {
    production: {
      baseUrl: process.env.STRAPI_IMPORT_PRODUCTION_URL || "https://api.infinitycolor.co/api",
      token: process.env.STRAPI_API_TOKEN_PRODUCTION,
    },
    staging: {
      baseUrl: process.env.STRAPI_IMPORT_STAGING_URL || "https://api.staging.infinitycolor.co/api",
      token: process.env.STRAPI_API_TOKEN_STAGING,
    },
    local: {
      baseUrl: process.env.STRAPI_IMPORT_LOCAL_URL || "http://127.0.0.1:1337/api",
      token: process.env.STRAPI_API_TOKEN_LOCAL || process.env.STRAPI_API_TOKEN,
    },
  };
  const cfg = map[envName];
  if (!cfg) {
    throw new Error(`Unknown --env ${envName}. Use production|staging|local.`);
  }
  if (!cfg.token) {
    throw new Error(`Missing API token for env=${envName}`);
  }
  return cfg;
}

async function fetchAllProducts(http, pageSize) {
  const products = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount) {
    const { data } = await http.get("/products", {
      params: {
        "fields[0]": "Slug",
        "fields[1]": "Title",
        "fields[2]": "external_id",
        "pagination[page]": page,
        "pagination[pageSize]": pageSize,
        "pagination[withCount]": true,
        "sort[0]": "id:asc",
      },
    });
    const rows = data?.data || [];
    products.push(
      ...rows.map((row) => ({
        id: row.id,
        slug: row.attributes?.Slug ?? row.Slug,
        title: row.attributes?.Title ?? row.Title,
        externalId: row.attributes?.external_id ?? row.external_id,
      })),
    );
    pageCount = data?.meta?.pagination?.pageCount || 1;
    const total = data?.meta?.pagination?.total;
    if (page === 1) {
      console.info(`[repair-slugs] backend reports ${total} products, pageSize=${pageSize}`);
    }
    if (rows.length === 0) break;
    page += 1;
  }
  return products;
}

function planRepairs(products) {
  const byDecoded = new Map();
  for (const p of products) {
    if (!p.slug) continue;
    const decoded = safeDecode(p.slug);
    const list = byDecoded.get(decoded) || [];
    list.push(p);
    byDecoded.set(decoded, list);
  }

  const collisions = [];
  for (const [decoded, list] of byDecoded.entries()) {
    const distinctIds = new Set(list.map((p) => p.id));
    // Collision = two different products would share the same decoded slug.
    if (distinctIds.size > 1) {
      collisions.push({ decoded, products: list });
    }
  }

  const changes = [];
  for (const p of products) {
    if (!p.slug) continue;
    const decoded = safeDecode(p.slug);
    if (decoded === p.slug) continue;
    changes.push({
      id: p.id,
      externalId: p.externalId,
      title: p.title,
      from: p.slug,
      to: decoded,
    });
  }

  return { changes, collisions, total: products.length };
}

async function ensureAlias(http, fromSlug, productId) {
  // Prefer create; on unique conflict, re-point the existing alias to this product.
  try {
    await http.post("/product-slug-aliases", {
      data: { Slug: fromSlug, product: productId },
    });
    return "created";
  } catch (error) {
    const status = error.response?.status;
    // Content type not deployed yet (404) or method not routed (405) — skippable.
    if (status === 404 || status === 405) {
      const skipErr = new Error("product-slug-aliases endpoint unavailable");
      skipErr.code = "ALIAS_ENDPOINT_MISSING";
      throw skipErr;
    }
    if (status !== 400 && status !== 409) throw error;
    const { data } = await http.get("/product-slug-aliases", {
      params: {
        "filters[Slug][$eq]": fromSlug,
        "pagination[pageSize]": 1,
      },
    });
    const row = data?.data?.[0];
    if (!row?.id) throw error;
    await http.put(`/product-slug-aliases/${row.id}`, {
      data: { product: productId },
    });
    return "updated";
  }
}

async function applyChanges(http, changes) {
  let ok = 0;
  let failed = 0;
  let aliases = 0;
  let aliasSkipped = 0;
  let aliasesUnavailable = false;
  for (const change of changes) {
    try {
      // Record the prior form first so a mid-run abort still leaves a working alias.
      // If ProductSlugAlias is not deployed yet, still decode the product Slug —
      // the redirect map JSON remains the source of truth for a later backfill.
      if (!aliasesUnavailable) {
        try {
          await ensureAlias(http, change.from, change.id);
          aliases += 1;
        } catch (aliasError) {
          if (aliasError.code === "ALIAS_ENDPOINT_MISSING") {
            aliasesUnavailable = true;
            aliasSkipped += 1;
            console.warn(
              "[repair-slugs] product-slug-aliases not deployed; continuing with Slug updates only. Redirect map was written for later backfill.",
            );
          } else {
            throw aliasError;
          }
        }
      } else {
        aliasSkipped += 1;
      }
      await http.put(`/products/${change.id}`, { data: { Slug: change.to } });
      ok += 1;
      if (ok % 50 === 0 || ok === changes.length) {
        console.info(`[repair-slugs] progress updated=${ok}/${changes.length}`);
      }
    } catch (error) {
      failed += 1;
      console.error(
        `[repair-slugs] FAILED id=${change.id}:`,
        error.response?.status,
        error.response?.data || error.message,
      );
    }
  }
  return { ok, failed, aliases, aliasSkipped };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node scripts/repair-product-slugs.js --env production [--confirm] [--out-dir DIR]`);
    process.exit(0);
  }

  const cfg = resolveStrapiConfig(args.env);
  const http = axios.create({
    baseURL: cfg.baseUrl.replace(/\/$/, ""),
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "repair-product-slugs/1.0",
    },
  });

  console.info(`[repair-slugs] env=${args.env} confirm=${args.confirm} base=${cfg.baseUrl}`);
  const products = await fetchAllProducts(http, args.pageSize);
  const { changes, collisions, total } = planRepairs(products);

  console.info(`[repair-slugs] examined=${total}`);
  console.info(`[repair-slugs] needing decode=${changes.length}`);
  console.info(`[repair-slugs] collisions=${collisions.length}`);

  if (collisions.length > 0) {
    console.error("[repair-slugs] ABORT: decoding would create duplicate slugs:");
    for (const c of collisions.slice(0, 20)) {
      console.error(
        `  ${JSON.stringify(c.decoded)} ← ids ${c.products.map((p) => p.id).join(",")}`,
      );
    }
    process.exit(2);
  }

  const outDir =
    args.outDir ||
    path.join(__dirname, "woocommerce-importer", "import-tracking", args.env, "slug-repairs");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(outDir, `slug-repair-${stamp}.json`);
  const redirectMapPath = path.join(outDir, `slug-redirects-${stamp}.json`);

  const report = {
    env: args.env,
    confirm: args.confirm,
    examined: total,
    changes: changes.length,
    collisions: 0,
    sample: changes.slice(0, 20),
    allChanges: changes,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const redirectMap = Object.fromEntries(changes.map((c) => [c.from, c.to]));
  fs.writeFileSync(redirectMapPath, JSON.stringify(redirectMap, null, 2));
  console.info(`[repair-slugs] wrote report ${reportPath}`);
  console.info(`[repair-slugs] wrote redirect map ${redirectMapPath}`);

  if (!args.confirm) {
    console.info("[repair-slugs] dry-run only. Re-run with --confirm to write.");
    return;
  }

  const { ok, failed, aliases, aliasSkipped } = await applyChanges(http, changes);
  console.info(
    `[repair-slugs] updated=${ok} failed=${failed} aliases=${aliases} aliasSkipped=${aliasSkipped}`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("[repair-slugs] fatal:", error.message || error);
  process.exit(1);
});
