#!/usr/bin/env node
/**
 * Backfill WooCommerce delivery addresses (+ optionally Unknown payment gateways).
 *
 * Why historical geo sales shows "نامشخص":
 *   older migration/sync releases intentionally omitted delivery addresses.
 *   Geography reports join order → local_user_address → shipping_city → shipping_province.
 *
 * This script:
 *   1. Reads shipping/billing from Woo (read-only GET)
 *   2. Maps Woo state codes (THR/GLS/…) to shipping_provinces.code
 *   3. Matches city titles within that province
 *   4. Creates local_user_addresses + order links (IsTemporary=true)
 *   5. Re-derives PaymentGateway for orders still marked Unknown
 *
 * Usage (on alp-prod sync container, which has Woo + DB env + pg):
 *   node /tmp/backfill-woo-order-addresses.js            # dry-run
 *   node /tmp/backfill-woo-order-addresses.js --apply --force
 *
 * Options:
 *   --apply --force --limit N --batch N --pages N --statuses done,processing,completed
 *   --woo-order-id N --addresses-only
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const REPORT_DIR = path.resolve(
  __dirname,
  "woocommerce-importer/import-tracking/production/address-backfill",
);

function parseArgs(argv) {
  const options = {
    apply: false,
    force: false,
    limit: null,
    batch: 100,
    pages: null,
    statuses: "completed,processing",
    wooOrderId: null,
    addressesOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--apply") options.apply = true;
    else if (token === "--force") options.force = true;
    else if (token === "--limit" && next) { options.limit = Number(next); i += 1; }
    else if (token === "--batch" && next) { options.batch = Number(next); i += 1; }
    else if (token === "--pages" && next) { options.pages = Number(next); i += 1; }
    else if (token === "--statuses" && next) { options.statuses = next; i += 1; }
    else if (token === "--woo-order-id" && next) { options.wooOrderId = Number(next); i += 1; }
    else if (token === "--addresses-only") options.addressesOnly = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`Unexpected argument: ${token}`);
  }
  if (options.limit != null && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isSafeInteger(options.batch) || options.batch < 1 || options.batch > 500) {
    throw new Error("--batch must be 1..500");
  }
  if (options.pages != null && (!Number.isSafeInteger(options.pages) || options.pages < 1)) {
    throw new Error("--pages must be a positive integer");
  }
  if (options.wooOrderId != null && (!Number.isSafeInteger(options.wooOrderId) || options.wooOrderId < 1)) {
    throw new Error("--woo-order-id must be a positive integer");
  }
  return options;
}

function looksLikeProduction(dbName) {
  return process.env.NODE_ENV === "production" || /prod/i.test(String(dbName || ""));
}

function dbConfig() {
  const sslRaw = String(process.env.DATABASE_SSL || "").toLowerCase();
  const ssl = ["true", "1", "require"].includes(sslRaw) ? { rejectUnauthorized: false } : false;
  return {
    host: process.env.DATABASE_HOST || "127.0.0.1",
    port: Number(process.env.DATABASE_PORT || 5432),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USERNAME || process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    ssl,
  };
}

function normalizeFa(value) {
  return String(value || "")
    .replace(/[يى]/g, "ی")
    .replace(/[ك]/g, "ک")
    .replace(/[\u200c\u200d\u200e\u200f]/g, "")
    .replace(/[‌]/g, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function paymentGateway(value, title = "") {
  const key = `${value || ""} ${title || ""}`.toLowerCase();
  if (key.includes("wallet") || key.includes("کیف پول")) return "Wallet";
  if (key.includes("snapp") || key.includes("اسنپ")) return "SnappPay";
  if (key.includes("mellat") || key.includes("behpardakht") || key.includes("ملت")) return "Mellat";
  if (key.includes("saman") || key.includes("sep") || key.includes("سامان")) return "SamanKish";
  if (key.includes("zarin") || key.includes("زرین")) return "ZarinPal";
  return "Unknown";
}

function toEnglishDigits(value) {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function canonicalPhone(raw) {
  let digits = toEnglishDigits(raw).replace(/\D/g, "");
  if (digits.startsWith("0098")) digits = digits.slice(4);
  else if (digits.startsWith("98")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return /^9\d{9}$/.test(digits) ? `+98${digits}` : null;
}

function postalCode(raw) {
  const digits = toEnglishDigits(raw).replace(/\D/g, "");
  if (/^\d{10}$/.test(digits) && digits !== "0000000000") return digits;
  return "0000000000";
}

function addressFromOrder(order) {
  const shipping = order?.shipping || {};
  const billing = order?.billing || {};
  const state = String(shipping.state || billing.state || "").trim().toUpperCase();
  const city = String(shipping.city || billing.city || "").trim();
  const line1 = String(shipping.address_1 || billing.address_1 || "").trim();
  const line2 = String(shipping.address_2 || billing.address_2 || "").trim();
  const postcode = shipping.postcode || billing.postcode || "";
  const firstName = String(shipping.first_name || billing.first_name || "").trim();
  const lastName = String(shipping.last_name || billing.last_name || "").trim();
  return {
    stateCode: state,
    cityTitle: city,
    fullAddress: [line1, line2].filter(Boolean).join(" — ").slice(0, 4000),
    postalCode: postalCode(postcode),
    recipientName: [firstName, lastName].filter(Boolean).join(" ").slice(0, 255),
    recipientPhone: canonicalPhone(shipping.phone || billing.phone),
  };
}

async function loadLocationMaps(client) {
  const provinces = await client.query(`SELECT id, title, code FROM shipping_provinces`);
  const cities = await client.query(`
    SELECT sc.id, sc.title, l.shipping_province_id AS province_id
    FROM shipping_cities sc
    JOIN shipping_cities_shipping_province_links l ON l.shipping_city_id = sc.id
  `);
  /** @type {Map<string, {id:number,title:string}>} */
  const provinceByCode = new Map();
  for (const row of provinces.rows) {
    if (row.code) provinceByCode.set(String(row.code).toUpperCase(), { id: Number(row.id), title: row.title });
  }
  /** @type {Map<number, Map<string, number>>} */
  const citiesByProvince = new Map();
  for (const row of cities.rows) {
    const provinceId = Number(row.province_id);
    if (!citiesByProvince.has(provinceId)) citiesByProvince.set(provinceId, new Map());
    citiesByProvince.get(provinceId).set(normalizeFa(row.title), Number(row.id));
  }
  return { provinceByCode, citiesByProvince };
}

function cityCandidates(cityTitle) {
  const raw = String(cityTitle || "").trim();
  if (!raw) return [];
  const out = [raw];
  for (const sep of [" ـ ", " - ", "–", "—", "،", ","]) {
    if (raw.includes(sep)) out.push(raw.split(sep)[0].trim());
  }
  // Common Woo spelling variants.
  out.push(raw.replace(/کاوس/g, "کاووس"));
  out.push(raw.replace(/شهرجدید/g, "شهر جدید "));
  out.push(raw.replace(/^بندر\s*/g, ""));
  out.push(raw.replace(/^شهر\s*/g, ""));
  return [...new Set(out.filter(Boolean))];
}

function resolveCity(locationMaps, stateCode, cityTitle) {
  const province = locationMaps.provinceByCode.get(String(stateCode || "").toUpperCase());
  if (!province) return { ok: false, reason: "PROVINCE_CODE_UNKNOWN", province: null, cityId: null };
  const cityMap = locationMaps.citiesByProvince.get(province.id) || new Map();
  const candidates = cityCandidates(cityTitle).map(normalizeFa).filter(Boolean);
  if (candidates.length === 0) return { ok: false, reason: "CITY_EMPTY", province, cityId: null };
  for (const normalized of candidates) {
    const direct = cityMap.get(normalized);
    if (direct) return { ok: true, reason: "CITY_MATCH", province, cityId: direct };
  }
  // Fallback: city title equals province title (e.g. تهران/تهران).
  const provinceCity = cityMap.get(normalizeFa(province.title));
  if (provinceCity && candidates.includes(normalizeFa(province.title))) {
    return { ok: true, reason: "CITY_EQUALS_PROVINCE", province, cityId: provinceCity };
  }
  return { ok: false, reason: "CITY_UNMATCHED", province, cityId: null };
}

async function loadStrapiOrders(client) {
  const { rows } = await client.query(`
    SELECT
      o.id AS order_id,
      o.external_id,
      o.payment_gateway,
      oul.user_id,
      oal.local_user_address_id AS address_id
    FROM orders o
    LEFT JOIN orders_user_links oul ON oul.order_id = o.id
    LEFT JOIN orders_delivery_address_links oal ON oal.order_id = o.id
    WHERE o.external_source = 'woocommerce'
  `);
  /** @type {Map<string, any>} */
  const byExternalId = new Map();
  for (const row of rows) byExternalId.set(String(row.external_id), row);
  return byExternalId;
}

async function createAddress(client, {
  orderId,
  userId,
  cityId,
  postal,
  fullAddress,
  fullName,
  phone,
  wooOrderId,
}) {
  await client.query(`SELECT id FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  const existingLink = await client.query(
    `SELECT local_user_address_id FROM orders_delivery_address_links WHERE order_id = $1 LIMIT 1`,
    [orderId],
  );
  if (existingLink.rows.length > 0) return null;
  const insert = await client.query(
    `
    INSERT INTO local_user_addresses (
      postal_code, description, full_address, full_name, phone, is_temporary,
      created_at, updated_at, created_by_id, updated_by_id
    )
    VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW(), NULL, NULL)
    RETURNING id
    `,
    [
      postal,
      `woo-order:${wooOrderId}`,
      fullAddress || null,
      fullName || null,
      phone || null,
    ],
  );
  const addressId = Number(insert.rows[0].id);
  await client.query(
    `
    INSERT INTO local_user_addresses_shipping_city_links (local_user_address_id, shipping_city_id)
    VALUES ($1, $2)
    `,
    [addressId, cityId],
  );
  if (userId) {
    await client.query(
      `
      INSERT INTO local_user_addresses_user_links (local_user_address_id, user_id)
      SELECT $1, $2
      WHERE NOT EXISTS (
        SELECT 1 FROM local_user_addresses_user_links WHERE local_user_address_id = $1
      )
      `,
      [addressId, userId],
    );
  }
  await client.query(
    `
    INSERT INTO orders_delivery_address_links (order_id, local_user_address_id)
    SELECT $1, $2
    WHERE NOT EXISTS (
      SELECT 1 FROM orders_delivery_address_links WHERE order_id = $1
    )
    `,
    [orderId, addressId],
  );
  return addressId;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node backfill-woo-order-addresses.js [--apply] [--force] [--limit N] [--pages N] [--woo-order-id N] [--addresses-only]");
    return;
  }

  const config = dbConfig();
  if (!config.database || !config.user || config.password == null) {
    throw new Error("DATABASE_* env required");
  }
  if (options.apply && looksLikeProduction(config.database) && !options.force) {
    throw new Error(`Refusing --apply against "${config.database}" without --force`);
  }

  // Prefer in-repo relative requires; fall back to /app paths used in the sync image.
  let getSyncConfig;
  let WordPressSource;
  try {
    ({ getSyncConfig } = require("./woocommerce-sync/config"));
    ({ WordPressSource } = require("./woocommerce-importer/migration-v2/lib/source"));
  } catch {
    ({ getSyncConfig } = require("/app/scripts/woocommerce-sync/config"));
    ({ WordPressSource } = require("/app/scripts/woocommerce-importer/migration-v2/lib/source"));
  }
  const source = new WordPressSource(getSyncConfig().source);

  const client = new Client(config);
  await client.connect();

  const startedAt = new Date().toISOString();
  const report = {
    startedAt,
    apply: options.apply,
    wooOrderId: options.wooOrderId,
    addressesOnly: options.addressesOnly,
    database: config.database,
    summary: {
      wooScanned: 0,
      strapiMatched: 0,
      alreadyHadAddress: 0,
      addressCreated: 0,
      addressWouldCreate: 0,
      addressSkippedNoState: 0,
      addressSkippedNoCity: 0,
      addressSkippedEmpty: 0,
      gatewayUpdated: 0,
      gatewayWouldUpdate: 0,
      gatewayStillUnknown: 0,
      missingStrapiOrder: 0,
    },
    samples: [],
    unmatchedCities: {},
  };

  try {
    const locationMaps = await loadLocationMaps(client);
    const strapiOrders = await loadStrapiOrders(client);
    console.log(JSON.stringify({
      mode: options.apply ? "apply" : "dry-run",
      provinces: locationMaps.provinceByCode.size,
      strapiWooOrders: strapiOrders.size,
    }));

    let page = 1;
    let processed = 0;
    /** @type {any[]} */
    let pendingWrites = [];

    const flush = async () => {
      if (!options.apply || pendingWrites.length === 0) {
        pendingWrites = [];
        return;
      }
      await client.query("BEGIN");
      try {
        for (const job of pendingWrites) {
          if (job.type === "address") {
            const addressId = await createAddress(client, job);
            if (addressId) report.summary.addressCreated += 1;
            else report.summary.alreadyHadAddress += 1;
          } else if (job.type === "gateway") {
            await client.query(
              `UPDATE orders SET payment_gateway = $1, updated_at = NOW() WHERE id = $2`,
              [job.gateway, job.orderId],
            );
            report.summary.gatewayUpdated += 1;
          }
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      pendingWrites = [];
    };

    while (true) {
      if (options.pages != null && page > options.pages) break;
      if (options.limit != null && processed >= options.limit) break;

      const response = options.wooOrderId != null
        ? {
          data: page === 1 ? [await source.getOrder(String(options.wooOrderId))] : [],
          headers: {},
        }
        : await source.woo.get("/orders", {
          per_page: 100,
          page,
          status: options.statuses,
          orderby: "id",
          order: "asc",
          _fields: "id,payment_method,payment_method_title,shipping,billing",
        });
      const rows = Array.isArray(response.data) ? response.data : [];
      if (rows.length === 0) break;

      for (const wooOrder of rows) {
        if (options.limit != null && processed >= options.limit) break;
        report.summary.wooScanned += 1;
        processed += 1;
        const externalId = String(wooOrder.id);
        const strapi = strapiOrders.get(externalId);
        if (!strapi) {
          report.summary.missingStrapiOrder += 1;
          continue;
        }
        report.summary.strapiMatched += 1;

        // Gateway repair for Unknown.
        if (!options.addressesOnly && String(strapi.payment_gateway || "") === "Unknown") {
          const gateway = paymentGateway(wooOrder.payment_method, wooOrder.payment_method_title);
          if (gateway !== "Unknown") {
            if (report.samples.length < 30) {
              report.samples.push({
                kind: "gateway",
                orderId: strapi.order_id,
                wooId: externalId,
                from: "Unknown",
                to: gateway,
                method: wooOrder.payment_method,
                title: wooOrder.payment_method_title,
              });
            }
            report.summary.gatewayWouldUpdate += 1;
            if (options.apply) {
              pendingWrites.push({ type: "gateway", orderId: strapi.order_id, gateway });
            }
          } else {
            report.summary.gatewayStillUnknown += 1;
          }
        }

        if (strapi.address_id) {
          report.summary.alreadyHadAddress += 1;
          continue;
        }

        const addr = addressFromOrder(wooOrder);
        if ((!addr.stateCode && !addr.cityTitle) || !addr.fullAddress) {
          report.summary.addressSkippedEmpty += 1;
          continue;
        }
        const resolved = resolveCity(locationMaps, addr.stateCode, addr.cityTitle);
        if (!resolved.ok && resolved.reason === "PROVINCE_CODE_UNKNOWN") {
          report.summary.addressSkippedNoState += 1;
          continue;
        }
        if (!resolved.ok) {
          report.summary.addressSkippedNoCity += 1;
          const key = `${addr.stateCode}|${addr.cityTitle}`;
          report.unmatchedCities[key] = (report.unmatchedCities[key] || 0) + 1;
          continue;
        }

        if (report.samples.length < 40) {
          report.samples.push({
            kind: "address",
            orderId: strapi.order_id,
            wooId: externalId,
            state: addr.stateCode,
            city: addr.cityTitle,
            cityId: resolved.cityId,
            province: resolved.province.title,
          });
        }

        report.summary.addressWouldCreate = (report.summary.addressWouldCreate || 0) + 1;
        if (options.apply) {
          pendingWrites.push({
            type: "address",
            orderId: strapi.order_id,
            userId: strapi.user_id || null,
            cityId: resolved.cityId,
            postal: addr.postalCode,
            fullAddress: addr.fullAddress,
            fullName: addr.recipientName,
            phone: addr.recipientPhone,
            wooOrderId: externalId,
          });
          if (pendingWrites.length >= options.batch) await flush();
        }
      }

      const headerTotal = response.headers?.get?.("x-wp-totalpages")
        ?? response.headers?.["x-wp-totalpages"]
        ?? response.headers?.["X-WP-TotalPages"];
      const totalPages = Number(headerTotal || 0);
      if (options.wooOrderId != null) break;
      if (totalPages && page >= totalPages) break;
      if (rows.length < 100) break;
      page += 1;
      if (page % 10 === 0) console.log(`progress page=${page} scanned=${report.summary.wooScanned}`);
    }

    await flush();

    const after = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE oal.local_user_address_id IS NOT NULL)::bigint AS woo_with_address,
        COUNT(*) FILTER (WHERE o.payment_gateway = 'Unknown')::bigint AS woo_unknown_gateway
      FROM orders o
      LEFT JOIN orders_delivery_address_links oal ON oal.order_id = o.id
      WHERE o.external_source = 'woocommerce'
    `);
    report.after = after.rows[0];
  } finally {
    await client.end();
  }

  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(
    REPORT_DIR,
    `address-backfill-${options.apply ? "apply" : "dryrun"}-${stamp}.json`,
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ summary: report.summary, after: report.after, reportPath }, null, 2));
  const topUnmatched = Object.entries(report.unmatchedCities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  if (topUnmatched.length) console.log(JSON.stringify({ topUnmatchedCities: topUnmatched }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`backfill-woo-order-addresses failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  addressFromOrder,
  canonicalPhone,
  cityCandidates,
  parseArgs,
  postalCode,
  resolveCity,
};
