"use strict";

/**
 * Reconciliation of WooCommerce orders against Infinity `orders`
 * (external_source = woocommerce), read-only by default.
 *
 *   node scripts/woocommerce-sync/reconcile-orders.js --dry-run
 *   node scripts/woocommerce-sync/reconcile-orders.js --dry-run --from 2026-07-23 --to 2026-08-23 --with-liquidity
 *   node scripts/woocommerce-sync/reconcile-orders.js --dry-run --failure-class ORDER_ITEMS_EMPTY
 *   node scripts/woocommerce-sync/reconcile-orders.js --apply --ids 1269185,1276485
 *   node scripts/woocommerce-sync/reconcile-orders.js --apply --ids-file /tmp/missing.json
 *
 * The report names every population explicitly (imported / missing / excluded /
 * duplicated / orphan-lined) and every money figure with its currency, so that
 * two numbers in it are never silently the same thing measured differently.
 */

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { getSyncConfig } = require("./config");
const { WooSyncService, orderRevision, sourceModifiedAt, safeErrorCode } = require("./service");
const { WordPressSource } = require("../woocommerce-importer/migration-v2/lib/source");
const { mapPoolOrdered } = require("../woocommerce-importer/catalog/lib/concurrency");
const T = require("../woocommerce-importer/migration-v2/lib/transforms");
const { classifyOrderLine, ORDER_LINE_ORPHAN } = require("../woocommerce-importer/migration-v2/lib/orderLines");

const STATUS_MAP = {
  pending: "Paying",
  processing: "Started",
  "on-hold": "Paying",
  completed: "Done",
  cancelled: "Cancelled",
  refunded: "Returned",
  failed: "Cancelled",
};

/** Fields needed to classify every population and sum source money exactly. */
const SOURCE_FIELDS = "id,status,total,shipping_total,date_created_gmt,line_items";
const DEFAULT_TIMEZONE = "Asia/Tehran";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    apply: false,
    after: null,
    before: null,
    from: null,
    to: null,
    timezone: DEFAULT_TIMEZONE,
    status: null,
    ids: null,
    idsFile: null,
    failureClasses: null,
    limit: null,
    pageSize: 100,
    concurrency: 1,
    withLiquidity: false,
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
    else if (token === "--from") { options.from = next; i += 1; }
    else if (token === "--to") { options.to = next; i += 1; }
    else if (token === "--timezone") { options.timezone = next; i += 1; }
    else if (token === "--status") { options.status = next; i += 1; }
    else if (token === "--ids") { options.ids = splitList(next); i += 1; }
    else if (token === "--ids-file") { options.idsFile = next; i += 1; }
    else if (token === "--failure-class") { options.failureClasses = splitList(next); i += 1; }
    else if (token === "--limit") { options.limit = Number(next); i += 1; }
    else if (token === "--page-size") { options.pageSize = Number(next); i += 1; }
    else if (token === "--concurrency") { options.concurrency = Number(next); i += 1; }
    else if (token === "--with-liquidity") options.withLiquidity = true;
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
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new Error("--concurrency must be an integer between 1 and 16");
  }
  if ((options.from || options.to) && (options.after || options.before)) {
    throw new Error("Use either --from/--to (local days) or --after/--before (raw ISO), not both");
  }
  if (Boolean(options.from) !== Boolean(options.to)) {
    throw new Error("--from and --to must be given together");
  }
  for (const [flag, value] of [["--from", options.from], ["--to", options.to]]) {
    if (value && !DAY_PATTERN.test(value)) throw new Error(`${flag} must be YYYY-MM-DD`);
  }
  if (options.ids && options.ids.length === 0) throw new Error("--ids requires at least one id");
  if (options.failureClasses && options.failureClasses.length === 0) {
    throw new Error("--failure-class requires at least one error code");
  }
  if (options.from) {
    const window = resolveWindow(options);
    if (!(window.endExclusive > window.startInclusive)) {
      throw new Error("--to must be after --from (--to is the exclusive end day)");
    }
  }
  return options;
}

function splitList(value) {
  return String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
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

/* ------------------------------------------------------------------ *
 * Local-day windows
 * ------------------------------------------------------------------ */

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function zoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asIfUtc - date.getTime();
}

/**
 * Midnight of a local calendar day as a UTC instant. Two passes so a day that
 * starts on the far side of a DST transition still resolves to the right
 * instant (Asia/Tehran has no DST today, but the helper must not depend on it).
 */
function localDayToUtcInstant(day, timeZone) {
  if (!DAY_PATTERN.test(String(day))) throw new Error("LOCAL_DAY_INVALID");
  const [year, month, dayOfMonth] = String(day).split("-").map(Number);
  const naive = Date.UTC(year, month - 1, dayOfMonth, 0, 0, 0);
  let instant = naive;
  for (let pass = 0; pass < 2; pass += 1) {
    instant = naive - zoneOffsetMs(new Date(instant), timeZone);
  }
  return new Date(instant);
}

/**
 * `--from` is inclusive, `--to` is EXCLUSIVE — the window is the half-open
 * local-day interval [from, to). Both bounds are echoed into the report so an
 * operator can see exactly which instants were compared.
 */
function resolveWindow({ from, to, timezone = DEFAULT_TIMEZONE }) {
  if (!from || !to) return null;
  const startInclusive = localDayToUtcInstant(from, timezone);
  const endExclusive = localDayToUtcInstant(to, timezone);
  return {
    timezone,
    fromDay: from,
    toDayExclusive: to,
    startInclusive,
    endExclusive,
    description: `[${from} 00:00 ${timezone}, ${to} 00:00 ${timezone}) = [${startInclusive.toISOString()}, ${endExclusive.toISOString()})`,
  };
}

/* ------------------------------------------------------------------ *
 * Exact money
 * ------------------------------------------------------------------ */

function exactIntegerString(value, code) {
  const raw = String(value ?? "").trim();
  const match = /^(-?\d+)(?:\.0+)?$/.exec(raw);
  if (!match) throw new Error(code || "MONEY_FORMAT_INVALID");
  return match[1];
}

function sumIntegerStrings(values) {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return total.toString();
}

/** Exact Rial → Toman, keeping any sub-Toman remainder visible. */
function rialToToman(rial) {
  const value = BigInt(exactIntegerString(rial));
  const quotient = value / 10n;
  const remainder = value % 10n;
  return { toman: quotient.toString(), remainderRial: remainder.toString(), exact: remainder === 0n };
}

/* ------------------------------------------------------------------ *
 * Source enumeration
 * ------------------------------------------------------------------ */

/**
 * Per-order facts the report needs, derived only from the source payload.
 * Money problems are captured, never thrown — a single malformed total must
 * not blind the whole reconciliation.
 */
function summarizeSourceOrder(order) {
  const sourceId = String(order?.id ?? "");
  const lines = Array.isArray(order?.line_items) ? order.line_items : [];
  let orphanLineCount = 0;
  for (const line of lines) {
    if (classifyOrderLine(line).kind === ORDER_LINE_ORPHAN) orphanLineCount += 1;
  }
  const summary = {
    sourceId,
    wooStatus: String(order?.status || ""),
    expectedStatus: STATUS_MAP[order?.status] || "Paying",
    createdAtGmt: order?.date_created_gmt ? `${String(order.date_created_gmt).replace(/Z$/, "")}Z` : null,
    lineCount: lines.length,
    orphanLineCount,
    totalToman: null,
    shippingToman: null,
    moneyIssue: null,
  };
  try {
    summary.totalToman = T.wooMoneyToToman(order?.total ?? "0");
  } catch (error) {
    summary.moneyIssue = `ORDER_TOTAL_UNPARSEABLE:${safeErrorCode(error)}`;
  }
  try {
    summary.shippingToman = T.wooMoneyToToman(order?.shipping_total ?? "0");
  } catch (error) {
    summary.moneyIssue = summary.moneyIssue || `ORDER_SHIPPING_UNPARSEABLE:${safeErrorCode(error)}`;
  }
  // The importer's terminal-exclusion rule, evaluated on the source only.
  summary.isEmpty = lines.length === 0;
  summary.isEmptyZeroTotal = summary.isEmpty && summary.totalToman === "0";
  summary.isEmptyNonzeroTotal = summary.isEmpty && summary.totalToman !== null && summary.totalToman !== "0";
  return summary;
}

async function* iterateWooOrders(source, options) {
  const { after, before, status, pageSize, limit } = options;
  const window = resolveWindow(options);
  const params = {
    orderby: "id",
    order: "asc",
    status: status || "any",
    per_page: pageSize,
    _fields: SOURCE_FIELDS,
  };
  if (window) {
    // Woo compares `after`/`before` exclusively and against site-local time
    // unless `dates_are_gmt` is set. The bounds are widened by one second and
    // the exact half-open window is enforced below on `date_created_gmt`, so
    // the population does not depend on Woo's boundary semantics.
    params.dates_are_gmt = true;
    params.after = new Date(window.startInclusive.getTime() - 1000).toISOString();
    params.before = new Date(window.endExclusive.getTime() + 1000).toISOString();
  } else {
    if (after) params.after = after;
    if (before) params.before = before;
  }

  let page = 1;
  let totalPages = null;
  let yielded = 0;
  do {
    const response = await source.woo.get("/orders", { ...params, page });
    const rows = Array.isArray(response.data) ? response.data : [];
    const headerPages = Number(response.headers.get("x-wp-totalpages"));
    if (Number.isSafeInteger(headerPages) && headerPages > 0) totalPages = headerPages;
    for (const order of rows) {
      if (window) {
        const created = Date.parse(`${String(order.date_created_gmt || "").replace(/Z$/, "")}Z`);
        if (!Number.isFinite(created)) continue;
        if (created < window.startInclusive.getTime() || created >= window.endExclusive.getTime()) continue;
      }
      yield order;
      yielded += 1;
      if (limit && yielded >= limit) return;
    }
    if ((totalPages && page >= totalPages) || (!totalPages && rows.length < pageSize)) break;
    page += 1;
  } while (true);
}

/* ------------------------------------------------------------------ *
 * Destination reads
 * ------------------------------------------------------------------ */

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

/** Orders the importer has already decided are terminally out of scope. */
async function loadExcludedIds(pool) {
  const result = await pool.query(
    `SELECT source_id, last_error_code
       FROM woocommerce_sync_items
      WHERE source_type = 'order' AND status = 'excluded'`,
  );
  const map = new Map();
  for (const row of result.rows) map.set(String(row.source_id), row.last_error_code || null);
  return map;
}

async function loadFailureClassTargets(pool, errorCodes) {
  const result = await pool.query(
    `SELECT source_id, last_error_code
       FROM woocommerce_sync_items
      WHERE source_type = 'order'
        AND status = ANY('{failed,quarantined}'::text[])
        AND last_error_code = ANY($1::text[])
      ORDER BY source_id`,
    [errorCodes],
  );
  return result.rows.map((row) => String(row.source_id));
}

/** `timestamptz` vs `timestamp`: send the right literal instead of guessing. */
async function timestampBinder(pool, table, column) {
  const result = await pool.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  const dataType = String(result.rows[0]?.data_type || "timestamp with time zone");
  const withTimeZone = dataType.includes("with time zone");
  return {
    dataType,
    // A `timestamp without time zone` column holds UTC wall-clock time in this
    // schema, so the offset is stripped rather than shifted by the session zone.
    bind: (date) => (withTimeZone ? date : date.toISOString().slice(0, 19).replace("T", " ")),
  };
}

/**
 * Money the destination holds for the enumerated orders, plus (optionally) the
 * settlement-side liquidity figure for the same window. Contract amounts are
 * Toman; `contract_transactions.amount` is Rial. Both are reported as exact
 * integer strings under names that say which is which.
 */
async function loadDestinationMoney(pool, { sourceIds, window, withLiquidity }) {
  const ids = Array.from(sourceIds);
  const money = {
    currencyNote: "contracts.amount is Toman; contract_transactions.amount is Rial (Toman x 10)",
    importedContractToman: "0",
    importedOrdersWithContract: 0,
    importedOrdersWithoutContract: 0,
    importedOrdersWithoutSettlementTransaction: 0,
  };
  if (ids.length > 0) {
    const result = await pool.query(
      `SELECT COALESCE(SUM(c.amount), 0)::text AS contract_toman,
              COUNT(*) FILTER (WHERE ocl.contract_id IS NOT NULL)::int AS with_contract,
              COUNT(*) FILTER (WHERE ocl.contract_id IS NULL)::int AS without_contract,
              COUNT(*) FILTER (
                WHERE ocl.contract_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                      FROM contract_transactions_contract_links ctl
                      JOIN contract_transactions ct ON ct.id = ctl.contract_transaction_id
                     WHERE ctl.contract_id = ocl.contract_id
                       AND ct.status = 'Success'
                       AND ct.type <> 'Return'
                  )
              )::int AS without_settlement
         FROM orders o
         LEFT JOIN orders_contract_links ocl ON ocl.order_id = o.id
         LEFT JOIN contracts c ON c.id = ocl.contract_id
        WHERE o.external_source = 'woocommerce'
          AND o.external_id = ANY($1::text[])`,
      [ids],
    );
    const row = result.rows[0] || {};
    money.importedContractToman = exactIntegerString(row.contract_toman || "0", "CONTRACT_AMOUNT_NOT_INTEGER");
    money.importedOrdersWithContract = Number(row.with_contract || 0);
    money.importedOrdersWithoutContract = Number(row.without_contract || 0);
    money.importedOrdersWithoutSettlementTransaction = Number(row.without_settlement || 0);
  }

  if (!withLiquidity) return money;
  if (!window) throw new Error("--with-liquidity requires --from/--to");

  const binder = await timestampBinder(pool, "contract_transactions", "date");
  const bounds = [binder.bind(window.startInclusive), binder.bind(window.endExclusive)];
  const [netResult, cancelledResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS success_count,
              COALESCE(SUM(CASE WHEN ct.type = 'Return' THEN -ct.amount ELSE ct.amount END), 0)::text AS net_rial
         FROM contract_transactions ct
        WHERE ct.status = 'Success' AND ct.date >= $1 AND ct.date < $2`,
      bounds,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cancelled_count
         FROM contract_transactions ct
         JOIN contract_transactions_contract_links ctl ON ctl.contract_transaction_id = ct.id
         JOIN orders_contract_links ocl ON ocl.contract_id = ctl.contract_id
         JOIN orders o ON o.id = ocl.order_id
        WHERE ct.status = 'Success' AND ct.date >= $1 AND ct.date < $2
          AND o.status = 'Cancelled'`,
      bounds,
    ),
  ]);
  const netRial = exactIntegerString(netResult.rows[0]?.net_rial || "0", "TRANSACTION_AMOUNT_NOT_INTEGER");
  const converted = rialToToman(netRial);
  money.liquidity = {
    definition: "Sum of Success contract_transactions (Return negated) by contract_transactions.date — settlement cash, not gross order value",
    dateColumnType: binder.dataType,
    successfulTransactionCount: Number(netResult.rows[0]?.success_count || 0),
    liquidityNetRial: netRial,
    liquidityNetToman: converted.toman,
    liquidityNetTomanExact: converted.exact,
    liquidityRemainderRial: converted.remainderRial,
    successfulTransactionsOnCurrentlyCancelledOrders: Number(cancelledResult.rows[0]?.cancelled_count || 0),
  };
  return money;
}

/* ------------------------------------------------------------------ *
 * Comparison
 * ------------------------------------------------------------------ */

/**
 * Pure comparison used by tests and the CLI.
 * @param {Iterable<string>} sourceIds
 * @param {Map<string, { status?: string, count?: number }>} destinationByExternalId
 * @param {Map<string, string>} [sourceStatusById]
 * @param {Set<string>|Map<string, any>} [excludedIds] Orders terminally excluded
 *   by the importer — present in Woo, deliberately not imported, and therefore
 *   neither "imported" nor "missing".
 */
function compareOrderIds(sourceIds, destinationByExternalId, sourceStatusById = new Map(), excludedIds = new Set()) {
  const missing = [];
  const present = [];
  const excluded = [];
  const statusMismatches = [];
  const duplicates = [];
  const seen = new Set();
  const isExcluded = (id) => (typeof excludedIds?.has === "function" ? excludedIds.has(id) : false);

  for (const rawId of sourceIds) {
    const sourceId = String(rawId);
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const dest = destinationByExternalId.get(sourceId);
    if (!dest) {
      if (isExcluded(sourceId)) excluded.push(sourceId);
      else missing.push(sourceId);
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
    excludedCount: excluded.length,
    excluded,
    duplicates,
    statusMismatches,
  };
}

/* ------------------------------------------------------------------ *
 * Dry run
 * ------------------------------------------------------------------ */

async function resolveTargetIds(pool, options) {
  const ids = [];
  if (options.ids) ids.push(...options.ids);
  if (options.idsFile) ids.push(...loadIdsFile(options.idsFile));
  if (options.failureClasses) ids.push(...await loadFailureClassTargets(pool, options.failureClasses));
  return Array.from(new Set(ids.map(String)));
}

function selectionOf(options, explicitIds) {
  if (explicitIds.length > 0) {
    const kinds = [];
    if (options.ids) kinds.push("ids");
    if (options.idsFile) kinds.push("ids-file");
    if (options.failureClasses) kinds.push("failure-class");
    return { kind: kinds.join("+"), idCount: explicitIds.length, failureClasses: options.failureClasses || null };
  }
  if (options.from) return { kind: "window" };
  if (options.after || options.before || options.status) {
    return { kind: "filtered", after: options.after, before: options.before, status: options.status };
  }
  return { kind: "all" };
}

async function runDryRun({ source, pool, options }) {
  const startedAt = new Date();
  const destination = await loadDestinationIndex(pool);
  const excludedByState = await loadExcludedIds(pool);
  const window = resolveWindow(options);
  const explicitIds = await resolveTargetIds(pool, options);

  const sourceIds = [];
  const sourceStatusById = new Map();
  const summaries = [];
  const notFoundInSource = [];
  let scanned = 0;

  const absorb = (order) => {
    const summary = summarizeSourceOrder(order);
    sourceIds.push(summary.sourceId);
    sourceStatusById.set(summary.sourceId, summary.expectedStatus);
    summaries.push(summary);
  };

  if (explicitIds.length > 0) {
    for (const id of explicitIds) {
      try {
        absorb(await source.getOrder(id));
      } catch (error) {
        notFoundInSource.push({ sourceId: String(id), errorCode: safeErrorCode(error) });
      }
    }
  } else {
    for await (const order of iterateWooOrders(source, options)) {
      absorb(order);
      scanned += 1;
      if (scanned % 1000 === 0) {
        const line = `[reconcile-orders] scanned ${scanned} source orders…\n`;
        process.stderr.write(line);
        try { fs.appendFileSync("/var/lib/infinity-sync/woocommerce/order-reconcile-apply.progress", line); } catch { /* optional */ }
      }
    }
  }

  // An emptied zero-total order is excluded by the importer's rule whether or
  // not a sync row already records the decision, so the source evidence and the
  // recorded state are unioned before "missing" is computed.
  const excludedIds = new Set(excludedByState.keys());
  for (const summary of summaries) {
    if (summary.isEmptyZeroTotal) excludedIds.add(summary.sourceId);
  }

  const report = compareOrderIds(sourceIds, destination, sourceStatusById, excludedIds);
  const importedIds = new Set(sourceIds.filter((id) => destination.has(id)));
  const money = await loadDestinationMoney(pool, {
    sourceIds: importedIds,
    window,
    withLiquidity: options.withLiquidity,
  });

  const ordersWithOrphanLines = summaries.filter((entry) => entry.orphanLineCount > 0);
  const emptyNonzero = summaries.filter((entry) => entry.isEmptyNonzeroTotal);
  const moneyIssues = summaries.filter((entry) => entry.moneyIssue);
  const totals = summaries.filter((entry) => entry.totalToman !== null).map((entry) => entry.totalToman);
  const shipping = summaries.filter((entry) => entry.shippingToman !== null).map((entry) => entry.shippingToman);

  report.mode = "dry-run";
  report.generatedAt = startedAt.toISOString();
  report.sourceRetrievedAt = new Date().toISOString();
  report.timezone = options.timezone;
  report.window = window
    ? {
      timezone: window.timezone,
      fromDayInclusive: window.fromDay,
      toDayExclusive: window.toDayExclusive,
      startInclusive: window.startInclusive.toISOString(),
      endExclusive: window.endExclusive.toISOString(),
      description: window.description,
    }
    : null;
  report.selection = selectionOf(options, explicitIds);
  report.destinationWooOrderRows = destination.size;
  report.populations = {
    sourceOrders: report.expectedSourceCount,
    importedOrders: report.importedCount,
    missingOrders: report.missingCount,
    excludedEmptyOrders: report.excludedCount,
    duplicateDestinationOrders: report.duplicates.length,
    statusMismatches: report.statusMismatches.length,
    ordersWithOrphanLines: ordersWithOrphanLines.length,
    orphanLineCount: ordersWithOrphanLines.reduce((sum, entry) => sum + entry.orphanLineCount, 0),
    emptyNonzeroTotalOrders: emptyNonzero.length,
    sourceOrdersNotFound: notFoundInSource.length,
    sourceMoneyUnparseable: moneyIssues.length,
    destinationWooOrderRows: destination.size,
  };
  report.money = {
    ...money,
    sourceGrossToman: sumIntegerStrings(totals),
    sourceShippingToman: sumIntegerStrings(shipping),
  };
  report.samples = {
    missing: report.missing.slice(0, 50),
    excludedEmpty: report.excluded.slice(0, 50),
    duplicates: report.duplicates.slice(0, 20),
    statusMismatches: report.statusMismatches.slice(0, 20),
    ordersWithOrphanLines: ordersWithOrphanLines.slice(0, 50).map((entry) => ({
      sourceId: entry.sourceId,
      orphanLineCount: entry.orphanLineCount,
      lineCount: entry.lineCount,
      totalToman: entry.totalToman,
    })),
    emptyNonzeroTotal: emptyNonzero.slice(0, 20).map((entry) => ({
      sourceId: entry.sourceId,
      totalToman: entry.totalToman,
    })),
    sourceMoneyUnparseable: moneyIssues.slice(0, 20).map((entry) => ({
      sourceId: entry.sourceId,
      issue: entry.moneyIssue,
    })),
    sourceOrdersNotFound: notFoundInSource.slice(0, 20),
  };
  console.error(
    `[reconcile-orders] dry-run complete source=${report.populations.sourceOrders} ` +
    `imported=${report.populations.importedOrders} missing=${report.populations.missingOrders} ` +
    `excluded=${report.populations.excludedEmptyOrders} orphanLines=${report.populations.orphanLineCount}`,
  );
  return report;
}

/* ------------------------------------------------------------------ *
 * Apply
 * ------------------------------------------------------------------ */

async function runApply({ service, source, pool, options }) {
  const dry = await runDryRun({ source, pool, options });
  const explicitIds = await resolveTargetIds(pool, options);
  // An explicit id list is the operator's scope: re-import exactly those, even
  // the ones already present, so a repair can be re-run to prove no drift.
  const targets = new Set(explicitIds.length > 0 ? explicitIds : dry.missing);

  if (options.requeueFailed && explicitIds.length === 0) {
    const requeued = await service.state.requeueOrders({
      statuses: ["quarantined", "failed"],
      limit: 50_000,
    });
    for (const row of requeued) targets.add(String(row.source_id));
    console.error(`[reconcile-orders] requeued ${requeued.length} failed/quarantined sync items`);
  }

  const results = {
    mode: "apply",
    generatedAt: new Date().toISOString(),
    dryRun: dry,
    unchangedDefinition: "re-imported with no item created and none removed (an idempotent re-write)",
    examined: 0,
    attempted: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    excluded: 0,
    withOrphanLines: 0,
    withUnresolvedVariations: 0,
    failed: 0,
    failures: [],
    orphanSamples: [],
  };

  const ids = Array.from(targets);
  if (options.limit) ids.splice(options.limit);
  results.examined = ids.length;
  console.error(`[reconcile-orders] applying ${ids.length} orders (concurrency ${options.concurrency})…`);

  await mapPoolOrdered(ids, options.concurrency, async (sourceId) => {
    results.attempted += 1;
    let order = null;
    try {
      order = await source.getOrder(sourceId);
      const result = await service.syncOrderRow({ source_id: sourceId }, { order });
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
      if (result?.mode !== "created"
        && Number(result?.itemsCreated || 0) === 0
        && Number(result?.itemsDeleted || 0) === 0) {
        results.unchanged += 1;
      }
      if (Number(result?.itemsOrphaned || 0) > 0) {
        results.withOrphanLines += 1;
        if (results.orphanSamples.length < 50) {
          results.orphanSamples.push({
            sourceId: String(sourceId),
            itemsOrphaned: Number(result.itemsOrphaned),
            mode: result.mode,
          });
        }
      }
      if (Number(result?.itemsUnresolved || 0) > 0) results.withUnresolvedVariations += 1;
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const isExcluded = error?.outcome === "excluded";
      if (isExcluded) results.excluded += 1;
      else {
        results.failed += 1;
        if (results.failures.length < 200) {
          results.failures.push({ sourceId: String(sourceId), errorCode });
        }
      }
      try {
        const known = order || await source.getOrder(sourceId).catch(() => ({ id: sourceId }));
        await service.state.recordOrderOutcome({
          sourceId,
          revisionSha256: orderRevision(known),
          modifiedAt: sourceModifiedAt(known),
          outcome: isExcluded ? "excluded" : "failed",
          errorCode,
        });
      } catch {
        /* best-effort */
      }
    }
    if (results.attempted % 50 === 0 || results.attempted === ids.length) {
      console.error(
        `[reconcile-orders] progress attempted=${results.attempted}/${ids.length} ` +
        `created=${results.created} updated=${results.updated} unchanged=${results.unchanged} ` +
        `excluded=${results.excluded} failed=${results.failed}`,
      );
    }
  });

  return results;
}

function printReport(report) {
  if (report.mode === "dry-run") {
    console.log(JSON.stringify({
      mode: report.mode,
      generatedAt: report.generatedAt,
      sourceRetrievedAt: report.sourceRetrievedAt,
      timezone: report.timezone,
      window: report.window,
      selection: report.selection,
      populations: report.populations,
      money: report.money,
      samples: report.samples,
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    mode: report.mode,
    generatedAt: report.generatedAt,
    unchangedDefinition: report.unchangedDefinition,
    before: {
      populations: report.dryRun.populations,
      money: report.dryRun.money,
      window: report.dryRun.window,
      selection: report.dryRun.selection,
    },
    examined: report.examined,
    attempted: report.attempted,
    created: report.created,
    updated: report.updated,
    unchanged: report.unchanged,
    excluded: report.excluded,
    withOrphanLines: report.withOrphanLines,
    withUnresolvedVariations: report.withUnresolvedVariations,
    failed: report.failed,
    orphanSample: report.orphanSamples.slice(0, 20),
    failureSample: report.failures.slice(0, 50),
  }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage:
  node reconcile-orders.js --dry-run [selection] [--with-liquidity] [--json-out path]
  node reconcile-orders.js --apply   [selection] [--concurrency N] [--no-requeue] [--json-out path]

Selection (pick one):
  --ids 123,456                 explicit WooCommerce order ids
  --ids-file path               ids from a JSON array/object or a whitespace/comma list
  --failure-class CODE[,CODE]   ids of failed/quarantined sync rows with those error codes
  --from YYYY-MM-DD --to YYYY-MM-DD [--timezone Asia/Tehran]
                                half-open local-day window: --from is inclusive, --to is EXCLUSIVE
  --after ISO --before ISO      raw Woo date filters (site-local semantics)
  --status STATUS               Woo order status filter
  (none)                        every WooCommerce order

Other: --limit N  --page-size N (<=100)  --concurrency N (1-16)
`);
    return;
  }

  const config = getSyncConfig();
  const pool = new Pool({ ...config.postgres, max: 4, idleTimeoutMillis: 30_000 });
  const source = new WordPressSource(config.source);
  const service = new WooSyncService(config, { pool, source });

  try {
    const window = resolveWindow(options);
    if (window) console.error(`[reconcile-orders] window ${window.description}`);
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
  localDayToUtcInstant,
  resolveWindow,
  summarizeSourceOrder,
  sumIntegerStrings,
  exactIntegerString,
  rialToToman,
  zoneOffsetMs,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`reconcile-orders failed: ${error.message}`);
    process.exitCode = 1;
  });
}
