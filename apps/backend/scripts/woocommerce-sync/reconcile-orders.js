"use strict";

/**
 * Read-only / apply reconciliation of WooCommerce order IDs vs Infinity
 * `orders.external_id` (external_source = woocommerce).
 *
 *   node scripts/woocommerce-sync/reconcile-orders.js --dry-run
 *   node scripts/woocommerce-sync/reconcile-orders.js --apply
 *   node scripts/woocommerce-sync/reconcile-orders.js --dry-run --after 2026-07-01 --before 2026-09-01
 *   node scripts/woocommerce-sync/reconcile-orders.js --apply --ids-file /tmp/missing.json
 */

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { getSyncConfig } = require("./config");
const { WooSyncService, orderRevision, sourceModifiedAt, safeErrorCode } = require("./service");
const { WordPressSource } = require("../woocommerce-importer/migration-v2/lib/source");

const STATUS_MAP = {
  pending: "Paying",
  processing: "Started",
  "on-hold": "Paying",
  completed: "Done",
  cancelled: "Cancelled",
  refunded: "Returned",
  failed: "Cancelled",
};

function parseArgs(argv) {
  const options = {
    dryRun: false,
    apply: false,
    after: null,
    before: null,
    status: null,
    idsFile: null,
    limit: null,
    pageSize: 100,
    requeueFailed: true,
    jsonOut: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === "--dry-run") options.dryRun = true;
    else if (token === "--apply") options.apply = true;
    else if (token === "--after") { options.after = next; i += 1; }
    else if (token === "--before") { options.before = next; i += 1; }
    else if (token === "--status") { options.status = next; i += 1; }
    else if (token === "--ids-file") { options.idsFile = next; i += 1; }
    else if (token === "--limit") { options.limit = Number(next); i += 1; }
    else if (token === "--page-size") { options.pageSize = Number(next); i += 1; }
    else if (token === "--no-requeue") options.requeueFailed = false;
    else if (token === "--json-out") { options.jsonOut = next; i += 1; }
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`Unexpected argument: ${token}`);
  }
  if (options.help) return options;
  if (options.dryRun === options.apply) {
    throw new Error("Specify exactly one of --dry-run or --apply");
  }
  if (options.limit !== null && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  if (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) {
    throw new Error("--page-size must be an integer between 1 and 100");
  }
  return options;
}

function loadIdsFile(filePath) {
  const raw = fs.readFileSync(path.resolve(filePath), "utf8").trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.ids || parsed.missing || []);
    return list.map(String);
  }
  return raw.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean);
}

/**
 * Pure comparison used by tests and the CLI.
 * @param {Iterable<string>} sourceIds
 * @param {Map<string, { status?: string, count?: number }>} destinationByExternalId
 * @param {Map<string, string>} [sourceStatusById]
 */
function compareOrderIds(sourceIds, destinationByExternalId, sourceStatusById = new Map()) {
  const missing = [];
  const present = [];
  const statusMismatches = [];
  const duplicates = [];
  const seen = new Set();

  for (const rawId of sourceIds) {
    const sourceId = String(rawId);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const dest = destinationByExternalId.get(sourceId);
    if (!dest) {
      missing.push(sourceId);
      continue;
    }
    if (Number(dest.count || 1) > 1) {
      duplicates.push(sourceId);
    }
    present.push(sourceId);
    const expectedStatus = sourceStatusById.get(sourceId);
    if (expectedStatus && dest.status && dest.status !== expectedStatus) {
      statusMismatches.push({
        sourceId,
        sourceStatus: expectedStatus,
        destinationStatus: dest.status,
      });
    }
  }

  return {
    expectedSourceCount: seen.size,
    importedCount: present.length,
    missingCount: missing.length,
    missing,
    presentCount: present.length,
    duplicates,
    statusMismatches,
  };
}

async function loadDestinationIndex(pool) {
  const result = await pool.query(
    `SELECT external_id,
            (array_agg(status ORDER BY CASE WHEN status = 'Done' THEN 0 ELSE 1 END))[1] AS status,
            COUNT(*)::int AS count
       FROM orders
      WHERE external_source = 'woocommerce'
        AND external_id IS NOT NULL
      GROUP BY external_id`,
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(String(row.external_id), { status: row.status, count: Number(row.count) });
  }
  return map;
}

async function* iterateWooOrders(source, options) {
  const { after, before, status, pageSize, limit } = options;
  // Always use a lightweight field set for ID enumeration — full payloads are
  // fetched later only for orders that need apply.
  const params = {
    orderby: "id",
    order: "asc",
    status: status || "any",
    per_page: pageSize,
    _fields: "id,status",
  };
  if (after) params.after = after;
  if (before) params.before = before;

  let page = 1;
  let totalPages = null;
  let yielded = 0;
  do {
    const response = await source.woo.get("/orders", { ...params, page });
    const rows = Array.isArray(response.data) ? response.data : [];
    const headerPages = Number(response.headers.get("x-wp-totalpages"));
    if (Number.isSafeInteger(headerPages) && headerPages > 0) totalPages = headerPages;
    for (const order of rows) {
      yield order;
      yielded += 1;
      if (limit && yielded >= limit) return;
    }
    if ((totalPages && page >= totalPages) || (!totalPages && rows.length < pageSize)) break;
    page += 1;
  } while (true);
}

async function runDryRun({ source, pool, options }) {
  const destination = await loadDestinationIndex(pool);
  const sourceIds = [];
  const sourceStatusById = new Map();
  let scanned = 0;

  if (options.idsFile) {
    for (const id of loadIdsFile(options.idsFile)) {
      sourceIds.push(id);
      try {
        const order = await source.getOrder(id);
        sourceStatusById.set(String(id), STATUS_MAP[order.status] || "Paying");
      } catch {
        /* status compare optional when source fetch fails */
      }
    }
  } else {
    for await (const order of iterateWooOrders(source, options)) {
      const id = String(order.id);
      sourceIds.push(id);
      sourceStatusById.set(id, STATUS_MAP[order.status] || "Paying");
      scanned += 1;
      if (scanned % 1000 === 0) {
        const line = `[reconcile-orders] scanned ${scanned} source orders…\n`;
        process.stderr.write(line);
        try { fs.appendFileSync("/var/lib/infinity-sync/woocommerce/order-reconcile-apply.progress", line); } catch { /* optional */ }
      }
    }
  }

  const report = compareOrderIds(sourceIds, destination, sourceStatusById);
  report.destinationWooOrderRows = destination.size;
  report.mode = "dry-run";
  console.error(`[reconcile-orders] dry-run complete expected=${report.expectedSourceCount} missing=${report.missingCount}`);
  return report;
}

async function runApply({ service, source, pool, options }) {
  const dry = await runDryRun({ source, pool, options });
  const targets = new Set(dry.missing);

  if (options.requeueFailed) {
    const requeued = await service.state.requeueOrders({
      statuses: ["quarantined", "failed"],
      limit: 50_000,
    });
    for (const row of requeued) targets.add(String(row.source_id));
    console.error(`[reconcile-orders] requeued ${requeued.length} failed/quarantined sync items`);
  }

  const results = {
    mode: "apply",
    dryRun: dry,
    attempted: 0,
    created: 0,
    updated: 0,
    failed: 0,
    failures: [],
  };

  const ids = Array.from(targets);
  if (options.limit) ids.splice(options.limit);
  console.error(`[reconcile-orders] applying ${ids.length} orders…`);

  for (const sourceId of ids) {
    results.attempted += 1;
    try {
      const order = await source.getOrder(sourceId);
      const result = await service.syncOrderRow({ source_id: sourceId });
      await service.state.recordOrderOutcome({
        sourceId,
        revisionSha256: orderRevision(order),
        modifiedAt: sourceModifiedAt(order),
        outcome: "completed",
        errorCode: result?.hasSoftIssues
          ? String([...(result.sideIssues || []), ...(result.identityIssues || []), ...(result.itemIssues || [])][0] || "ORDER_SOFT_ISSUES").slice(0, 128)
          : null,
      });
      if (result?.mode === "created") results.created += 1;
      else results.updated += 1;
    } catch (error) {
      results.failed += 1;
      const errorCode = safeErrorCode(error);
      if (results.failures.length < 200) {
        results.failures.push({ sourceId: String(sourceId), errorCode });
      }
      try {
        const order = await source.getOrder(sourceId).catch(() => ({ id: sourceId }));
        await service.state.recordOrderOutcome({
          sourceId,
          revisionSha256: orderRevision(order),
          modifiedAt: sourceModifiedAt(order),
          outcome: "failed",
          errorCode,
        });
      } catch {
        /* best-effort */
      }
    }
    if (results.attempted % 50 === 0 || results.attempted === ids.length) {
      console.error(
        `[reconcile-orders] progress attempted=${results.attempted}/${ids.length} ` +
        `created=${results.created} updated=${results.updated} failed=${results.failed}`,
      );
    }
  }

  return results;
}

function printReport(report) {
  if (report.mode === "dry-run") {
    console.log(JSON.stringify({
      mode: report.mode,
      expectedSourceCount: report.expectedSourceCount,
      importedCount: report.importedCount,
      missingCount: report.missingCount,
      destinationWooOrderRows: report.destinationWooOrderRows,
      duplicateCount: report.duplicates.length,
      statusMismatchCount: report.statusMismatches.length,
      missingSample: report.missing.slice(0, 50),
      duplicateSample: report.duplicates.slice(0, 20),
      statusMismatchSample: report.statusMismatches.slice(0, 20),
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    mode: report.mode,
    dryRun: {
      expectedSourceCount: report.dryRun.expectedSourceCount,
      importedCount: report.dryRun.importedCount,
      missingCount: report.dryRun.missingCount,
    },
    attempted: report.attempted,
    created: report.created,
    updated: report.updated,
    failed: report.failed,
    failureSample: report.failures.slice(0, 50),
  }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage:
  node reconcile-orders.js --dry-run [--after ISO] [--before ISO] [--status STATUS] [--limit N]
  node reconcile-orders.js --apply [--ids-file path] [--no-requeue] [--limit N]
`);
    return;
  }

  const config = getSyncConfig();
  const pool = new Pool({ ...config.postgres, max: 4, idleTimeoutMillis: 30_000 });
  const source = new WordPressSource(config.source);
  const service = new WooSyncService(config, { pool, source });

  try {
    const report = options.dryRun
      ? await runDryRun({ source, pool, options })
      : await runApply({ service, source, pool, options });
    printReport(report);
    if (options.jsonOut) {
      fs.writeFileSync(path.resolve(options.jsonOut), JSON.stringify(report, null, 2));
    }
    if (options.apply && report.failed > 0) process.exitCode = 2;
    else if (options.dryRun && report.missingCount > 0) process.exitCode = 0; // informational
  } finally {
    await service.close();
  }
}

module.exports = {
  parseArgs,
  compareOrderIds,
  loadIdsFile,
  STATUS_MAP,
  iterateWooOrders,
  runDryRun,
  runApply,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`reconcile-orders failed: ${error.message}`);
    process.exitCode = 1;
  });
}
