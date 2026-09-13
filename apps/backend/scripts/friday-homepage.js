#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadSecretFile } = require("./woocommerce-importer/migration-v2/lib/env");
const { WordPressSource } = require("./woocommerce-importer/migration-v2/lib/source");
const { JsonHttp } = require("./woocommerce-importer/migration-v2/lib/http");

const TEHRAN_OFFSET = "+03:30";
const VISIBLE_RAIL_LIMIT = 20;
const RAILS = Object.freeze([
  { section: "newest", field: "homeNewestProductIds" },
  { section: "favorites", field: "homeFavoriteProductIds" },
  { section: "custom", field: "homeCustomSectionAssignment" },
  { section: "weeklyPicks", field: "homeWeeklyPicksProductIds" },
  { section: "everyoneFollows", field: "homeEveryoneFollowsProductIds" },
]);

function usage() {
  return [
    "Usage: node scripts/friday-homepage.js --date YYYY-MM-DD [--date YYYY-MM-DD ...] [--apply] [--report-dir PATH]",
    "",
    "Reads currently published WooCommerce products added/published during any supplied Tehran calendar day.",
    "Without --apply it prints the proposed homepage assignments and performs no writes.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { apply: false, dates: [], reportDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--date") result.dates.push(String(argv[++index] || ""));
    else if (arg === "--report-dir") result.reportDir = String(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.help && result.dates.length === 0) throw new Error("at least one --date is required");
  result.dates = [...new Set(result.dates)];
  return result;
}

function requiredSetting(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`Missing homepage curation setting: ${name}`);
  return value;
}

function getHomepageConfig(env = process.env) {
  if (env === process.env) {
    loadSecretFile(env.FRIDAY_HOMEPAGE_SECRETS_FILE || env.WOOCOMMERCE_SYNC_SECRETS_FILE || env.MIGRATION_SECRETS_FILE);
  }
  return {
    source: {
      sourceBaseUrl: String(env.WORDPRESS_SOURCE_URL || "https://infinitycolor.co").replace(/\/$/, ""),
      wpUsername: requiredSetting(env, "WP_USERNAME"),
      wpApplicationPassword: requiredSetting(env, "WP_APPLICATION_PASSWORD"),
      wooKey: requiredSetting(env, "WOOCOMMERCE_CONSUMER_KEY"),
      wooSecret: requiredSetting(env, "WOOCOMMERCE_CONSUMER_SECRET"),
    },
    destination: {
      baseUrl: String(
        env.FRIDAY_HOMEPAGE_STRAPI_URL || env.STRAPI_IMPORT_PRODUCTION_URL || "http://api:1337/api",
      ).replace(/\/$/, ""),
      strapiToken: requiredSetting(env, "STRAPI_API_TOKEN_PRODUCTION"),
    },
  };
}

function tehranDayWindow(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error("--date must be YYYY-MM-DD");
  const [year, month, day] = dateText.split("-").map(Number);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    throw new Error("--date is not a valid calendar date");
  }
  const startMs = Date.parse(`${dateText}T00:00:00${TEHRAN_OFFSET}`);
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return {
    date: dateText,
    timezone: "Asia/Tehran",
    startMs,
    endMs,
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
  };
}

function sourceInstant(product) {
  const value = String(product?.date_created_gmt || "").trim();
  if (!value) return Number.NaN;
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
}

function selectPublishedProducts(rows, window) {
  const byId = new Map();
  for (const product of rows) {
    const id = Number(product?.id);
    const createdMs = sourceInstant(product);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    if (product?.status !== "publish") continue;
    if (!Number.isFinite(createdMs) || createdMs < window.startMs || createdMs >= window.endMs) continue;
    const current = byId.get(id);
    if (!current || sourceInstant(current) < createdMs) byId.set(id, product);
  }
  return [...byId.values()].sort((left, right) => {
    const byDate = sourceInstant(right) - sourceInstant(left);
    return byDate || Number(right.id) - Number(left.id);
  });
}

function buildProductMap(snapshotRows) {
  const result = new Map();
  const duplicates = [];
  for (const row of snapshotRows) {
    if (row?.external_source !== "woocommerce") continue;
    const sourceId = String(row?.external_id || "").trim();
    const targetId = Number(row?.id);
    if (!/^\d+$/.test(sourceId) || !Number.isSafeInteger(targetId) || targetId <= 0) continue;
    if (result.has(sourceId) && result.get(sourceId) !== targetId) duplicates.push(sourceId);
    result.set(sourceId, targetId);
  }
  if (duplicates.length > 0) {
    throw new Error(`Ambiguous WooCommerce product mappings: ${[...new Set(duplicates)].join(",")}`);
  }
  return result;
}

function distributeProducts(sourceProducts, targetBySourceId) {
  const missing = [];
  const mapped = sourceProducts.map((product) => {
    const sourceId = String(product.id);
    const targetId = targetBySourceId.get(sourceId);
    if (!targetId) missing.push(sourceId);
    return { sourceId, targetId, onSale: product.on_sale === true };
  });
  if (missing.length > 0) throw new Error(`Selected products missing from Strapi: ${missing.join(",")}`);

  const assignments = Object.fromEntries(RAILS.map(({ section }) => [section, []]));
  mapped.forEach((product, index) => {
    assignments[RAILS[index % RAILS.length].section].push(product.targetId);
  });
  return {
    mapped,
    assignments,
    discounted: mapped.filter((product) => product.onSale).map((product) => product.targetId),
  };
}

function attributesOf(payload) {
  return payload?.data?.attributes || payload?.data || payload || {};
}

function idsOfSection(payload, sectionId) {
  const sections = payload?.data?.sections || payload?.sections || [];
  const section = sections.find((candidate) => candidate?.id === sectionId);
  return Array.isArray(section?.products)
    ? section.products.map((product) => Number(product?.id)).filter(Number.isSafeInteger)
    : [];
}

function sameIds(actual, expected) {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

async function collectWindowProducts(source, window) {
  const rows = [];
  const query = {
    status: "publish",
    dates_are_gmt: "true",
    after: new Date(window.startMs - 1000).toISOString().replace(/Z$/, ""),
    before: new Date(window.endMs + 1000).toISOString().replace(/Z$/, ""),
    orderby: "date",
    order: "desc",
  };
  for await (const page of source.products(query, { concurrency: 1, pageSize: 100 })) {
    rows.push(...page.rows);
  }
  return selectPublishedProducts(rows, window);
}

async function collectProductMappings(destination, sourceProducts) {
  const sourceIds = sourceProducts.map((product) => String(product.id));
  const response = await destination.post("/settings/homepage-product-mappings", { data: { sourceIds } });
  return Array.isArray(response.data?.data) ? response.data.data : [];
}

function homepagePayload(distribution) {
  return {
    homeNewestProductIds: distribution.assignments.newest,
    homeFavoriteProductIds: distribution.assignments.favorites,
    homeDiscountedProductIds: distribution.discounted,
    homeWeeklyPicksEnabled: true,
    homeWeeklyPicksProductIds: distribution.assignments.weeklyPicks,
    homeEveryoneFollowsEnabled: true,
    homeEveryoneFollowsProductIds: distribution.assignments.everyoneFollows,
  };
}

function customPayload(distribution, before) {
  return {
    homeCustomSectionEnabled: true,
    homeCustomSectionTitle: typeof before.homeCustomSectionTitle === "string"
      ? before.homeCustomSectionTitle
      : "",
    homeCustomSectionAssignment: {
      mode: "manual",
      productIds: distribution.assignments.custom,
      categorySlug: "",
    },
  };
}

async function rollback(homepageClient, beforeHomepage, beforeCustom) {
  const failures = [];
  try {
    await homepageClient.put("/settings/homepage-products", { data: beforeHomepage });
  } catch (error) {
    failures.push(`homepage:${error.message}`);
  }
  try {
    await homepageClient.put("/settings/homepage-custom-section", { data: beforeCustom });
  } catch (error) {
    failures.push(`custom:${error.message}`);
  }
  if (failures.length > 0) throw new Error(`Rollback failed: ${failures.join(";")}`);
}

async function applyAssignments(homepageClient, distribution) {
  const beforeHomepage = attributesOf((await homepageClient.get("/settings/homepage-products")).data);
  const beforeCustom = attributesOf((await homepageClient.get("/settings/homepage-custom-section")).data);
  const nextHomepage = homepagePayload(distribution);
  const nextCustom = customPayload(distribution, beforeCustom);

  try {
    await homepageClient.put("/settings/homepage-products", { data: nextHomepage });
    await homepageClient.put("/settings/homepage-custom-section", { data: nextCustom });

    const savedHomepage = attributesOf((await homepageClient.get("/settings/homepage-products")).data);
    const savedCustom = attributesOf((await homepageClient.get("/settings/homepage-custom-section")).data);
    for (const [field, expected] of Object.entries(nextHomepage)) {
      const actual = savedHomepage[field];
      if (Array.isArray(expected) ? !sameIds(actual || [], expected) : actual !== expected) {
        throw new Error(`Homepage readback mismatch: ${field}`);
      }
    }
    if (
      savedCustom.homeCustomSectionEnabled !== true ||
      savedCustom.homeCustomSectionTitle !== nextCustom.homeCustomSectionTitle ||
      savedCustom.homeCustomSectionAssignment?.mode !== "manual" ||
      !sameIds(savedCustom.homeCustomSectionAssignment?.productIds || [], nextCustom.homeCustomSectionAssignment.productIds)
    ) {
      throw new Error("Homepage readback mismatch: custom");
    }

    const sections = (await homepageClient.get("/products/homepage-sections")).data;
    const visible = {};
    for (const { section } of RAILS) {
      visible[section] = idsOfSection(sections, section);
    }
    visible.discounted = idsOfSection(sections, "discounted");
    return { beforeHomepage, beforeCustom, nextHomepage, nextCustom, visible };
  } catch (error) {
    try {
      await rollback(homepageClient, beforeHomepage, beforeCustom);
    } catch (rollbackError) {
      error.message = `${error.message}; ${rollbackError.message}`;
    }
    throw error;
  }
}

function writeReport(report, reportDir) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (!reportDir) return;
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o750 });
  const dateSlug = report.dates.join("_");
  const target = path.join(reportDir, `friday-homepage-${dateSlug}-${report.startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(target, serialized, { mode: 0o640 });
  report.reportFile = target;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const config = getHomepageConfig(env);
  const windows = args.dates.map(tehranDayWindow);
  const startedAt = new Date().toISOString();
  const source = new WordPressSource(config.source);
  const homepageClient = new JsonHttp({
    baseUrl: config.destination.baseUrl,
    headers: { Authorization: `Bearer ${config.destination.strapiToken}` },
    timeoutMs: 60_000,
  });

  const sourceById = new Map();
  for (const window of windows) {
    for (const product of await collectWindowProducts(source, window)) {
      sourceById.set(Number(product.id), product);
    }
  }
  const sourceProducts = [...sourceById.values()].sort((left, right) => {
    const byDate = sourceInstant(right) - sourceInstant(left);
    return byDate || Number(right.id) - Number(left.id);
  });
  if (sourceProducts.length === 0) {
    throw new Error(`No published WooCommerce products found for ${args.dates.join(",")}`);
  }
  const mappings = await collectProductMappings(homepageClient, sourceProducts);
  const distribution = distributeProducts(sourceProducts, buildProductMap(mappings));
  const report = {
    mode: args.apply ? "apply" : "preview",
    dates: args.dates,
    timezone: "Asia/Tehran",
    windowsUtc: windows.map((window) => ({ date: window.date, start: window.startUtc, end: window.endUtc })),
    startedAt,
    completedAt: null,
    sourceProductCount: sourceProducts.length,
    mappedProductCount: distribution.mapped.length,
    onSaleProductCount: distribution.discounted.length,
    assignmentCounts: Object.fromEntries(
      Object.entries(distribution.assignments).map(([section, ids]) => [section, ids.length]),
    ),
    visibleRailLimit: VISIBLE_RAIL_LIMIT,
    sourceProductIds: distribution.mapped.map((product) => Number(product.sourceId)),
    targetProductIds: distribution.mapped.map((product) => product.targetId),
    assignments: distribution.assignments,
    discounted: distribution.discounted,
    applied: false,
  };
  if (args.apply) {
    const result = await applyAssignments(homepageClient, distribution);
    report.applied = true;
    report.visible = result.visible;
  }
  report.completedAt = new Date().toISOString();
  writeReport(report, args.reportDir);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message, at: new Date().toISOString() })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  RAILS,
  applyAssignments,
  buildProductMap,
  collectProductMappings,
  distributeProducts,
  getHomepageConfig,
  homepagePayload,
  parseArgs,
  selectPublishedProducts,
  tehranDayWindow,
};
