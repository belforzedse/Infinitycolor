#!/usr/bin/env node
/**
 * Backfill WooCommerce order contracts + Success settlement transactions for analytics.
 *
 * Context:
 * - Migration/sync already creates contracts for Woo orders.
 * - It does NOT create contract_transactions.
 * - Analytics `paidOrdersCte` only counts orders with Status='Success' settlements.
 * - `contract_transactions.amount` is IRR (Toman * 10); Woo `contracts.amount` is Toman.
 *
 * Usage:
 *   # dry-run (default) against env DATABASE_* or --env-file
 *   node scripts/backfill-woo-order-contracts.js \
 *     --env-file /home/belforzedse/Projects/Infinitycolor/prod.backend.main.env
 *
 *   # apply writes (prod requires --force)
 *   node scripts/backfill-woo-order-contracts.js \
 *     --env-file /home/belforzedse/Projects/Infinitycolor/prod.backend.main.env \
 *     --apply --force
 *
 * Options:
 *   --env-file <path>   Load DATABASE_* from a dotenv file
 *   --apply             Persist changes (default is dry-run)
 *   --force             Required when DATABASE_NAME looks like production
 *   --limit <n>         Max paid orders to process (default: all)
 *   --batch <n>         Commit batch size (default: 200)
 *   --statuses <list>   Comma-separated paid order statuses (default: Done,Started)
 *   --external-ids <list>  Optional Woo order external_id filter (comma-separated)
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const REPORT_DIR = path.resolve(
  __dirname,
  "woocommerce-importer/import-tracking/production/contract-backfill",
);

function parseArgs(argv) {
  const options = {
    apply: false,
    force: false,
    limit: null,
    batch: 200,
    envFile: null,
    statuses: ["Done", "Started"],
    externalIds: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--apply") options.apply = true;
    else if (token === "--force") options.force = true;
    else if (token === "--env-file" && next) {
      options.envFile = next;
      index += 1;
    } else if (token === "--limit" && next) {
      options.limit = Number(next);
      index += 1;
    } else if (token === "--batch" && next) {
      options.batch = Number(next);
      index += 1;
    } else if (token === "--statuses" && next) {
      options.statuses = next.split(",").map((value) => value.trim()).filter(Boolean);
      index += 1;
    } else if (token === "--external-ids" && next) {
      options.externalIds = next.split(",").map((value) => value.trim()).filter(Boolean);
      index += 1;
    } else if (token === "--help" || token === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unexpected argument: ${token}`);
    }
  }
  if (options.externalIds != null && options.externalIds.length === 0) {
    throw new Error("--external-ids must not be empty");
  }
  if (options.limit != null && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isSafeInteger(options.batch) || options.batch < 1 || options.batch > 2000) {
    throw new Error("--batch must be an integer between 1 and 2000");
  }
  if (options.statuses.length === 0) throw new Error("--statuses must not be empty");
  return options;
}

function loadEnvFile(filePath) {
  const absolute = path.resolve(filePath);
  const text = fs.readFileSync(absolute, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const trimmed = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function looksLikeProduction(dbName) {
  return process.env.NODE_ENV === "production" || /prod/i.test(String(dbName || ""));
}

function contractStatusForOrder(status) {
  switch (status) {
    case "Done":
      return "Finished";
    case "Started":
    case "Shipment":
      return "Confirmed";
    case "Cancelled":
    case "Returned":
      return "Cancelled";
    case "Paying":
    default:
      return "Not Ready";
  }
}

function contractTypeForGateway(gateway) {
  return gateway === "SnappPay" ? "Credit" : "Cash";
}

function tomanToIrr(toman) {
  const value = BigInt(String(toman));
  if (value < 0n) throw new Error(`NEGATIVE_AMOUNT:${toman}`);
  return (value * 10n).toString();
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

async function loadGatewayMap(client) {
  const { rows } = await client.query(`SELECT id, title FROM payment_gateways`);
  /** @type {Map<string, number>} */
  const byNormalized = new Map();
  for (const row of rows) {
    const title = String(row.title || "").trim();
    if (!title) continue;
    const compact = title.toLowerCase().replace(/[\s_-]+/g, "");
    byNormalized.set(compact, Number(row.id));
    byNormalized.set(title.toLowerCase(), Number(row.id));
  }
  // Order enum → known gateway titles.
  const aliases = {
    samankish: ["samankish", "samankish"],
    mellat: ["mellat"],
    snappay: ["snappay", "snapp pay"],
    zarinpal: ["zarinpal"],
    wallet: ["wallet"],
  };
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const [gateway, keys] of Object.entries(aliases)) {
    for (const key of keys) {
      const id = byNormalized.get(key.replace(/[\s_-]+/g, "")) ?? byNormalized.get(key);
      if (id) map.set(gateway, id);
    }
  }
  // Direct enum matches when titles already align.
  for (const gateway of ["SamanKish", "Mellat", "SnappPay", "ZarinPal", "Wallet", "Unknown"]) {
    const compact = gateway.toLowerCase().replace(/[\s_-]+/g, "");
    const id = byNormalized.get(compact);
    if (id) map.set(gateway, id);
  }
  return map;
}

async function audit(client, statuses) {
  const { rows: summary } = await client.query(
    `
    SELECT
      COUNT(*)::bigint AS woo_orders,
      COUNT(*) FILTER (WHERE ocl.contract_id IS NULL)::bigint AS missing_contract,
      COUNT(*) FILTER (
        WHERE o.status = ANY($1::text[])
          AND ocl.contract_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM contract_transactions_contract_links ctl
            JOIN contract_transactions ct ON ct.id = ctl.contract_transaction_id
            WHERE ctl.contract_id = ocl.contract_id
              AND ct.status = 'Success'
              AND ct.type <> 'Return'
          )
      )::bigint AS paid_missing_success_txn,
      COUNT(*) FILTER (
        WHERE o.status = ANY($1::text[])
          AND ocl.contract_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM contract_transactions_contract_links ctl
            JOIN contract_transactions ct ON ct.id = ctl.contract_transaction_id
            WHERE ctl.contract_id = ocl.contract_id
              AND ct.status = 'Success'
              AND ct.type <> 'Return'
          )
      )::bigint AS paid_already_settled
    FROM orders o
    LEFT JOIN orders_contract_links ocl ON ocl.order_id = o.id
    WHERE o.external_source = 'woocommerce'
    `,
    [statuses],
  );
  return summary[0];
}

async function fetchCandidates(client, { statuses, limit, externalIds }) {
  const params = [statuses];
  let filterSql = "";
  let limitSql = "";
  if (externalIds != null && externalIds.length > 0) {
    params.push(externalIds);
    filterSql = `AND o.external_id = ANY($${params.length}::text[])`;
  }
  if (limit != null) {
    params.push(limit);
    limitSql = `LIMIT $${params.length}`;
  }
  const { rows } = await client.query(
    `
    SELECT
      o.id AS order_id,
      o.external_id AS order_external_id,
      o.status AS order_status,
      o.date AS order_date,
      o.payment_gateway AS payment_gateway,
      COALESCE(o.shipping_cost, 0)::numeric AS shipping_cost,
      oul.user_id AS user_id,
      ocl.contract_id AS contract_id,
      c.amount AS contract_amount,
      c.status AS contract_status,
      c.type AS contract_type,
      c.external_id AS contract_external_id,
      COALESCE((
        SELECT SUM(oi.per_amount::numeric * oi.count)
        FROM order_items_order_links oil
        JOIN order_items oi ON oi.id = oil.order_item_id
        WHERE oil.order_id = o.id
      ), 0)::numeric AS items_total
    FROM orders o
    LEFT JOIN orders_contract_links ocl ON ocl.order_id = o.id
    LEFT JOIN contracts c ON c.id = ocl.contract_id
    LEFT JOIN orders_user_links oul ON oul.order_id = o.id
    WHERE o.external_source = 'woocommerce'
      AND o.status = ANY($1::text[])
      ${filterSql}
      AND (
        ocl.contract_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM contract_transactions_contract_links ctl
          JOIN contract_transactions ct ON ct.id = ctl.contract_transaction_id
          WHERE ctl.contract_id = ocl.contract_id
            AND ct.status = 'Success'
            AND ct.type <> 'Return'
        )
      )
    ORDER BY o.id ASC
    ${limitSql}
    `,
    params,
  );
  return rows;
}

/**
 * @param {import("pg").PoolClient | import("pg").Client} client
 * @param {object} row
 * @param {Map<string, number>} gatewayMap
 */
async function ensureContractAndSettlement(client, row, gatewayMap) {
  const sourceId = String(row.order_external_id || "");
  if (!/^\d+$/.test(sourceId)) {
    return { action: "skip", reason: "ORDER_EXTERNAL_ID_INVALID", orderId: row.order_id };
  }

  let contractId = row.contract_id ? Number(row.contract_id) : null;
  let contractAmountToman = row.contract_amount != null ? String(row.contract_amount) : null;
  let createdContract = false;

  if (!contractId) {
    const amountToman = (
      BigInt(Math.round(Number(row.items_total || 0)))
      + BigInt(Math.round(Number(row.shipping_cost || 0)))
    ).toString();
    const contractExternalId = `contract_${sourceId}`;
    const insert = await client.query(
      `
      INSERT INTO contracts (
        type, status, amount, tax_percent, date,
        external_source, external_id, created_at, updated_at, created_by_id, updated_by_id
      )
      VALUES ($1, $2, $3, 0, $4, 'woocommerce', $5, NOW(), NOW(), NULL, NULL)
      ON CONFLICT (external_source, external_id) DO NOTHING
      RETURNING id, amount
      `,
      [
        contractTypeForGateway(row.payment_gateway),
        contractStatusForOrder(row.order_status),
        amountToman,
        row.order_date,
        contractExternalId,
      ],
    );

    if (insert.rows[0]) {
      contractId = Number(insert.rows[0].id);
      contractAmountToman = String(insert.rows[0].amount);
      createdContract = true;
    } else {
      const existing = await client.query(
        `
        SELECT id, amount
        FROM contracts
        WHERE external_source = 'woocommerce' AND external_id = $1
        LIMIT 1
        `,
        [contractExternalId],
      );
      if (!existing.rows[0]) {
        return { action: "skip", reason: "CONTRACT_CREATE_FAILED", orderId: row.order_id };
      }
      contractId = Number(existing.rows[0].id);
      contractAmountToman = String(existing.rows[0].amount);
    }

    await client.query(
      `
      INSERT INTO orders_contract_links (order_id, contract_id)
      SELECT $1, $2
      WHERE NOT EXISTS (
        SELECT 1 FROM orders_contract_links WHERE order_id = $1 OR contract_id = $2
      )
      `,
      [row.order_id, contractId],
    );

    if (row.user_id) {
      await client.query(
        `
        INSERT INTO contracts_local_user_links (contract_id, user_id)
        SELECT $1, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM contracts_local_user_links WHERE contract_id = $1
        )
        `,
        [contractId, row.user_id],
      );
    }
  }

  const txnExternalId = `transaction_${sourceId}`;
  const existingTxn = await client.query(
    `
    SELECT ct.id
    FROM contract_transactions ct
    WHERE ct.external_source = 'woocommerce' AND ct.external_id = $1
    LIMIT 1
    `,
    [txnExternalId],
  );
  if (existingTxn.rows[0]) {
    return {
      action: "noop",
      reason: "TRANSACTION_EXISTS",
      orderId: row.order_id,
      contractId,
      createdContract,
      transactionId: Number(existingTxn.rows[0].id),
    };
  }

  const existingSuccess = await client.query(
    `
    SELECT ct.id
    FROM contract_transactions_contract_links ctl
    JOIN contract_transactions ct ON ct.id = ctl.contract_transaction_id
    WHERE ctl.contract_id = $1
      AND ct.status = 'Success'
      AND ct.type <> 'Return'
    LIMIT 1
    `,
    [contractId],
  );
  if (existingSuccess.rows[0]) {
    return {
      action: "noop",
      reason: "SUCCESS_TXN_EXISTS",
      orderId: row.order_id,
      contractId,
      createdContract,
      transactionId: Number(existingSuccess.rows[0].id),
    };
  }

  if (contractAmountToman == null) {
    return { action: "skip", reason: "CONTRACT_AMOUNT_MISSING", orderId: row.order_id, contractId };
  }

  const amountIrr = tomanToIrr(contractAmountToman);
  const txnInsert = await client.query(
    `
    INSERT INTO contract_transactions (
      type, amount, discount_amount, step, status, date, track_id,
      external_source, external_id, created_at, updated_at, created_by_id, updated_by_id
    )
    VALUES (
      'Gateway', $1, '0', 1, 'Success', $2, $3,
      'woocommerce', $4, NOW(), NOW(), NULL, NULL
    )
    RETURNING id
    `,
    [amountIrr, row.order_date, `woo_${sourceId}`, txnExternalId],
  );
  const transactionId = Number(txnInsert.rows[0].id);

  await client.query(
    `
    INSERT INTO contract_transactions_contract_links (contract_transaction_id, contract_id)
    VALUES ($1, $2)
    `,
    [transactionId, contractId],
  );

  const gatewayId = gatewayMap.get(String(row.payment_gateway || ""))
    || gatewayMap.get(String(row.payment_gateway || "").toLowerCase());
  if (gatewayId) {
    await client.query(
      `
      INSERT INTO contract_transactions_payment_gateway_links (
        contract_transaction_id, payment_gateway_id
      )
      VALUES ($1, $2)
      `,
      [transactionId, gatewayId],
    );
  }

  return {
    action: createdContract ? "created_contract_and_txn" : "created_txn",
    orderId: row.order_id,
    contractId,
    transactionId,
    amountToman: contractAmountToman,
    amountIrr,
    paymentGateway: row.payment_gateway,
    gatewayLinked: Boolean(gatewayId),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/backfill-woo-order-contracts.js [--env-file PATH] [--apply] [--force] [--limit N] [--external-ids IDS]`);
    return;
  }

  try {
    require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
  } catch {
    /* optional */
  }
  if (options.envFile) loadEnvFile(options.envFile);

  const config = dbConfig();
  if (!config.database || !config.user || config.password == null) {
    throw new Error("DATABASE_NAME / DATABASE_USERNAME / DATABASE_PASSWORD are required");
  }
  if (options.apply && looksLikeProduction(config.database) && !options.force) {
    throw new Error(
      `Refusing --apply against "${config.database}" without --force`,
    );
  }

  const client = new Client(config);
  await client.connect();

  const startedAt = new Date().toISOString();
  const report = {
    startedAt,
    apply: options.apply,
    database: config.database,
    host: config.host,
    statuses: options.statuses,
    externalIds: options.externalIds,
    limit: options.limit,
    batch: options.batch,
    summaryBefore: null,
    summaryAfter: null,
    processed: 0,
    createdContracts: 0,
    createdTransactions: 0,
    skipped: 0,
    noop: 0,
    errors: [],
    samples: [],
  };

  try {
    report.summaryBefore = await audit(client, options.statuses);
    console.log(JSON.stringify({ mode: options.apply ? "apply" : "dry-run", before: report.summaryBefore }, null, 2));

    const candidates = await fetchCandidates(client, {
      statuses: options.statuses,
      limit: options.limit,
      externalIds: options.externalIds,
    });
    console.log(`candidates=${candidates.length}`);

    const gatewayMap = await loadGatewayMap(client);
    if (!options.apply) {
      const sample = candidates.slice(0, 10).map((row) => ({
        orderId: row.order_id,
        externalId: row.order_external_id,
        status: row.order_status,
        paymentGateway: row.payment_gateway,
        contractId: row.contract_id,
        contractAmountToman: row.contract_amount,
        plannedTxnAmountIrr: row.contract_amount != null ? tomanToIrr(row.contract_amount) : null,
        needsContract: row.contract_id == null,
      }));
      report.samples = sample;
      report.processed = candidates.length;
      console.log(JSON.stringify({ dryRunSample: sample }, null, 2));
    } else {
      for (let offset = 0; offset < candidates.length; offset += options.batch) {
        const batch = candidates.slice(offset, offset + options.batch);
        await client.query("BEGIN");
        try {
          for (const row of batch) {
            try {
              const result = await ensureContractAndSettlement(client, row, gatewayMap);
              report.processed += 1;
              if (result.action === "created_contract_and_txn") {
                report.createdContracts += 1;
                report.createdTransactions += 1;
              } else if (result.action === "created_txn") {
                report.createdTransactions += 1;
              } else if (result.action === "noop") {
                report.noop += 1;
              } else {
                report.skipped += 1;
              }
              if (report.samples.length < 20) report.samples.push(result);
            } catch (error) {
              report.errors.push({
                orderId: row.order_id,
                message: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          }
          await client.query("COMMIT");
          console.log(`committed batch offset=${offset} size=${batch.length}`);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      report.summaryAfter = await audit(client, options.statuses);
      console.log(JSON.stringify({ after: report.summaryAfter }, null, 2));
    }
  } finally {
    await client.end();
  }

  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(
    REPORT_DIR,
    `contract-backfill-${options.apply ? "apply" : "dryrun"}-${stamp}.json`,
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report=${reportPath}`);
  console.log(JSON.stringify({
    processed: report.processed,
    createdContracts: report.createdContracts,
    createdTransactions: report.createdTransactions,
    skipped: report.skipped,
    noop: report.noop,
    errors: report.errors.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(`backfill-woo-order-contracts failed: ${error.message}`);
  process.exitCode = 1;
});
