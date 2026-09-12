"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { Queue, Worker, UnrecoverableError } = require("bullmq");
const { Pool } = require("pg");
const { getSyncConfig } = require("./config");
const { SyncStateStore } = require("./stateStore");
const { WordPressSource } = require("../woocommerce-importer/migration-v2/lib/source");
const { Destination } = require("../woocommerce-importer/migration-v2/lib/destination");
const T = require("../woocommerce-importer/migration-v2/lib/transforms");
const { CatalogEngine } = require("../woocommerce-importer/catalog/engine");
const { mapPoolAsync } = require("../woocommerce-importer/catalog/lib/concurrency");
const { buildConfig } = require("../woocommerce-importer/catalog/config");
const { reconcileMissingProductMedia } = require("../woocommerce-importer/catalog/lib/mediaRecovery");
const Logger = require("../woocommerce-importer/utils/Logger");
const { ensureOrderReferencedVariations } = require("./ensureOrderVariations");

const QUEUE_NAME = "woocommerce-sync";
const JOBS = {
  discovery: "woocommerce.discovery",
  hourly: "woocommerce.hourly",
  friday: "woocommerce.friday-cutover",
  reconcile: "woocommerce.reconcile",
};
const SCHEDULERS = {
  discovery: "sched:woocommerce.discovery",
  hourly: "sched:woocommerce.hourly",
  friday: "sched:woocommerce.friday-cutover",
  reconcile: "sched:woocommerce.reconcile",
};
/**
 * Candidate target-orphan classification (a Strapi product carrying an
 * external_id we couldn't find in this reconciliation's WooCommerce
 * enumeration). Never auto-mutated — only reported. See reconcile().
 */
const ORPHAN_STATUS = {
  CONFIRMED_MISSING: "source_confirmed_missing", // clean 404 refetch — Woo genuinely doesn't have it
  UNKNOWN: "source_unknown", // timeout/5xx/auth/network — cannot safely infer deletion
};

function redisConnection(config) {
  const parsed = new URL(config.redisUrl);
  const db = parsed.pathname?.slice(1) ? Number(parsed.pathname.slice(1)) : undefined;
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(Number.isInteger(db) ? { db } : {}),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(config.redisPassword || parsed.password
      ? { password: config.redisPassword || decodeURIComponent(parsed.password) }
      : {}),
    ...(parsed.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function sourceModifiedAt(row) {
  const raw = row?.date_modified_gmt || row?.date_modified || row?.date_created_gmt || row?.date_created;
  if (!raw) return null;
  const parsed = new Date(row.date_modified_gmt || row.date_created_gmt ? `${raw}Z` : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function productRevision(row) {
  return sha256({
    id: row.id,
    modified: sourceModifiedAt(row),
    status: row.status,
    type: row.type,
    price: row.price,
    regularPrice: row.regular_price,
    salePrice: row.sale_price,
    stockStatus: row.stock_status,
    manageStock: row.manage_stock,
    stockQuantity: row.stock_quantity,
    variations: Array.isArray(row.variations) ? row.variations.map(String) : [],
  });
}

function orderRevision(row) {
  return sha256({
    id: row.id,
    modified: sourceModifiedAt(row),
    status: row.status,
    total: row.total,
    shippingTotal: row.shipping_total,
    customerId: row.customer_id,
    billing: {
      phone: T.canonicalPhone(row?.billing?.phone),
      email: String(row?.billing?.email || "").trim().toLowerCase(),
      firstName: row?.billing?.first_name || "",
      lastName: row?.billing?.last_name || "",
    },
    deliveryAddress: T.orderDeliveryAddress(row),
    paymentMethod: row.payment_method,
    lines: (row.line_items || []).map((line) => ({
      id: line.id,
      productId: line.product_id,
      variationId: line.variation_id,
      quantity: line.quantity,
      price: line.price,
      total: line.total,
      name: line.name,
      sku: line.sku,
    })),
    shippingLines: (row.shipping_lines || []).map((line) => ({
      id: line.id,
      methodId: line.method_id,
      methodTitle: line.method_title,
      total: line.total,
    })),
  });
}

function customerRevision(row) {
  return sha256({
    id: row.id,
    modified: sourceModifiedAt(row),
    email: String(row.email || "").trim().toLowerCase(),
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    billingPhone: T.canonicalPhone(row?.billing?.phone),
    shippingPhone: T.canonicalPhone(row?.shipping?.phone),
    // customerPayload also accepts the login username as a phone source; leaving
    // it out here made the delta path disagree about which customers changed.
    usernamePhone: T.canonicalPhone(row?.username),
  });
}

function walletRevision(row) {
  return sha256({
    id: row.id,
    balance: T.walletBalanceValue(row),
  });
}

function safeErrorCode(error) {
  const message = String(error?.message || "");
  const screamingMessage = /^[A-Z][A-Z0-9_.:-]*$/.test(message) ? message : null;
  const raw = String(
    error?.code || error?.payload?.error || screamingMessage || error?.name || "UNKNOWN",
  ).toUpperCase();
  return raw.replace(/[^A-Z0-9_.:-]/g, "_").slice(0, 128);
}

/**
 * Resolve the wall-clock instant a Friday/nightly cutover was scheduled for.
 * BullMQ's `job.timestamp` is creation time (often mid-day on redeploy); the
 * repeatable job id suffix is the intended fire time.
 */
function fridayScheduledTimestamp(job) {
  const id = String(job?.id || "");
  const suffix = Number(id.split(":").pop());
  if (Number.isFinite(suffix) && suffix > 1e12) return suffix;
  const prevMillis = Number(job?.opts?.prevMillis);
  if (Number.isFinite(prevMillis) && prevMillis > 1e12) return prevMillis;
  return Number(job?.timestamp) || Date.now();
}

function catalogReportSummary(scope, report) {
  const serialized = report.toJSON();
  const failures = Array.isArray(serialized.failures) ? serialized.failures : [];
  return {
    scope,
    failed: failures.length,
    totals: serialized.totals || {},
    processed: Number(serialized.processed || 0),
    durationMs: Number(serialized.durationMs || 0),
    // Present only for the inventory scope; `staleNonZero` is the signal that
    // WooCommerce's out-of-stock flag disagreed with Strapi's counts.
    ...(serialized.stockGate ? { stockGate: serialized.stockGate } : {}),
  };
}

/** entities/sec, or null when there's nothing to divide (avoids Infinity/NaN in reported metrics). */
function throughputPerSec(count, durationMs) {
  if (!Number.isFinite(count) || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return Number((count / (durationMs / 1000)).toFixed(2));
}

function assertCatalogReportSucceeded(summary) {
  if (summary.failed === 0) return;
  const error = new Error(`Friday ${summary.scope} catalog stage has ${summary.failed} failures`);
  error.code = `FRIDAY_${String(summary.scope).toUpperCase()}_HAS_FAILURES`;
  throw error;
}

function logId(type, id) {
  return sha256(`${type}:${id}`).slice(0, 16);
}

/** Flatten a page generator into a row stream so a worker pool never idles between pages. */
async function* pageRows(pages) {
  for await (const page of pages) {
    yield* page.rows;
  }
}

async function mapPool(items, concurrency, action) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await action(items[index]);
    }
  });
  await Promise.all(workers);
}

function createCatalogEngine(config) {
  fs.mkdirSync(config.trackingDir, { recursive: true, mode: 0o700 });
  const built = buildConfig("production").config;
  built.duplicateTracking.storageDir = config.trackingDir;
  built.catalog.trackingDirAbs = config.trackingDir;
  built.catalog.concurrency = { ...config.concurrency };
  const logger = new Logger({ ...built.logging, level: process.env.IMPORT_LOG_LEVEL || "info" });
  return new CatalogEngine(built, logger, { environment: "production-sync" });
}

async function ensureActive(state) {
  const control = await state.control();
  if (control.mode !== "active" || !control.reconciliation_run_id || !control.reconciliation_sha256) {
    const error = new Error("Woo sync destination writes are gated until historical reconciliation is accepted");
    error.code = "WOOCOMMERCE_SYNC_NOT_ACTIVE";
    throw error;
  }
  return control;
}

/**
 * Describe a thrown value completely, including the `cause` chain.
 *
 * Node's `fetch` reports transport failures as a bare `TypeError: fetch failed`
 * whose actual reason (EAI_AGAIN, UND_ERR_CONNECT_TIMEOUT, ...) lives on
 * `error.cause.code`. Logging only `error.message` on a multi-hour unattended
 * run throws away the one detail that separates a network blip from a real bug
 * — which is exactly what made the 2026-09-12 crash take so long to read.
 */
function describeError(error) {
  const parts = [];
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    // A `cause` is not always an Error — undici sometimes hands back a plain
    // object carrying only `code`. Naively interpolating that prints
    // "Error: [object Object]", burying the one useful field.
    const name = current.name || (current instanceof Error ? "Error" : "");
    const text = [name && `${name}:`, current.message, current.code && `(${current.code})`]
      .filter(Boolean)
      .join(" ");
    if (text) parts.push(text);
  }
  return parts.join(" <- ") || "unknown error";
}

class WooSyncService {
  constructor(config, { pool = null, source = null, destination = null } = {}) {
    this.config = config;
    this.pool = pool || new Pool({ ...config.postgres, max: 4, idleTimeoutMillis: 30_000 });
    this.state = new SyncStateStore(this.pool, { owner: config.instanceId, leaseSeconds: config.leaseSeconds });
    this.source = source || new WordPressSource(config.source);
    this.destination = destination || new Destination({ ...config.source, ...config.destination });
    this.stopping = false;
    this._catalogEngine = null;
    // Set while a campaign owns the lease, so a fatal out-of-band error (an
    // unhandled rejection, an uncaught exception, a SIGTERM) can still mark the
    // row failed instead of leaving it `running` forever. See
    // `finalizeActiveCampaign` and run-campaign.js's process handlers.
    this.activeCampaign = null;
  }

  catalogRepo() {
    if (!this._catalogEngine) {
      this._catalogEngine = (this.createCatalogEngine || createCatalogEngine)(this.config);
    }
    return this._catalogEngine.repo;
  }

  async withLease(name, action) {
    const lease = await this.state.acquireLease(name);
    if (!lease) return { skipped: true, reason: "lease-held" };
    let renewalError = null;
    const renewalTimer = setInterval(() => {
      this.state.assertLease(name, lease.token).catch((error) => {
        renewalError = error;
        this.stopping = true;
      });
    }, Math.max(15_000, Math.floor(this.config.leaseSeconds * 1000 / 3)));
    renewalTimer.unref?.();
    try {
      const result = await action(lease.token);
      if (renewalError) throw renewalError;
      return result;
    } finally {
      clearInterval(renewalTimer);
      await this.state.releaseLease(name, lease.token).catch(() => undefined);
    }
  }

  async pollEntity({ sourceType, pages, revision }, leaseName, token) {
    const cursor = await this.state.cursor(sourceType);
    const from = cursor.cursor_time
      ? new Date(new Date(cursor.cursor_time).getTime() - this.config.overlapMs).toISOString()
      : "1970-01-01T00:00:00.000Z";
    const control = await this.state.control();
    let newestTime = cursor.cursor_time ? new Date(cursor.cursor_time).toISOString() : null;
    let newestId = Number(cursor.cursor_id || 0);
    let observed = 0;
    for await (const page of pages(from)) {
      for (const row of page.rows) {
        if (this.stopping) return { observed, stopped: true };
        const modifiedAt = sourceModifiedAt(row);
        await this.state.observe({
          sourceType,
          sourceId: row.id,
          revisionSha256: revision(row),
          modifiedAt,
        }, control.mode);
        observed += 1;
        if (modifiedAt && (!newestTime || modifiedAt > newestTime || (modifiedAt === newestTime && Number(row.id) > newestId))) {
          newestTime = modifiedAt;
          newestId = Number(row.id);
        }
      }
      await this.state.assertLease(leaseName, token);
    }
    await this.state.saveCursor(sourceType, {
      cursorTime: newestTime,
      cursorId: newestId,
      sweepPage: Number(cursor.sweep_page || 1),
    }, leaseName, token);
    return { observed };
  }

  async pollWooEntity({ sourceType, pathname, params, revision, bootstrapLatest = false }, leaseName, token) {
    const cursor = await this.state.cursor(sourceType);
    const from = cursor.cursor_time
      ? new Date(new Date(cursor.cursor_time).getTime() - this.config.overlapMs).toISOString()
      : "1970-01-01T00:00:00.000Z";
    const control = await this.state.control();
    let newestTime = cursor.cursor_time ? new Date(cursor.cursor_time).toISOString() : null;
    let newestId = Number(cursor.cursor_id || 0);
    let observed = 0;
    const requestPage = (page, overrides = {}) => this.source.woo.get(pathname, {
      ...params(from), per_page: 100, page, ...overrides,
    });
    const processPage = async (response) => {
      const rows = Array.isArray(response.data) ? response.data : [];
      for (const row of rows) {
        if (this.stopping) return;
        const modifiedAt = sourceModifiedAt(row);
        await this.state.observe({
          sourceType,
          sourceId: row.id,
          revisionSha256: revision(row),
          modifiedAt,
        }, control.mode);
        observed += 1;
        if (modifiedAt && (!newestTime || modifiedAt > newestTime || (modifiedAt === newestTime && Number(row.id) > newestId))) {
          newestTime = modifiedAt;
          newestId = Number(row.id);
        }
      }
      await this.state.assertLease(leaseName, token);
    };

    if (bootstrapLatest && !cursor.cursor_time && control.mode === "shadow") {
      const latest = await requestPage(1, { per_page: 1, order: "desc" });
      await processPage(latest);
      if (this.stopping) return { observed, stopped: true, bootstrapped: true };
      await this.state.saveCursor(sourceType, {
        cursorTime: newestTime || new Date().toISOString(),
        cursorId: newestId,
        sweepPage: Number(cursor.sweep_page || 1),
      }, leaseName, token);
      return { observed, bootstrapped: true };
    }

    const first = await requestPage(1);
    const totalPages = Math.max(1, Number(first.headers.get("x-wp-totalpages")) || 1);
    await processPage(first);
    if (!this.stopping && totalPages > 1) {
      const remainingPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);
      await mapPool(remainingPages, this.config.sourcePageConcurrency, async (page) => {
        if (this.stopping) return;
        await processPage(await requestPage(page));
      });
    }
    if (this.stopping) return { observed, stopped: true };
    await this.state.saveCursor(sourceType, {
      cursorTime: newestTime,
      cursorId: newestId,
      sweepPage: Number(cursor.sweep_page || 1),
    }, leaseName, token);
    return { observed };
  }

  async pollChanges(leaseName, token) {
    const [products, orders] = await Promise.all([
      this.pollWooEntity({
        sourceType: "product",
        pathname: "/products",
        params: (modifiedAfter) => ({
          modified_after: modifiedAfter, dates_are_gmt: true, orderby: "modified", order: "asc",
        }),
        revision: productRevision,
      }, leaseName, token),
      this.pollWooEntity({
        sourceType: "order",
        pathname: "/orders",
        params: (modifiedAfter) => ({
          modified_after: modifiedAfter, dates_are_gmt: true, orderby: "modified", order: "asc",
        }),
        revision: orderRevision,
        bootstrapLatest: true,
      }, leaseName, token),
    ]);
    return { products, orders };
  }

  async discovery() {
    return this.withLease("discovery", async (token) => {
      const started = Date.now();
      try {
        const { products, orders } = await this.pollChanges("discovery", token);
        const control = await this.state.control();
        if (control.mode === "active" && !this.stopping) await this.drain("immediate", token);
        await this.state.metric({
          stage: "discovery",
          outcome: "completed",
          durationMs: Date.now() - started,
          itemCount: products.observed + orders.observed,
          detail: { source: this.source.metrics() },
        });
        return { products, orders, mode: control.mode };
      } catch (error) {
        await this.state.metric({ stage: "discovery", outcome: "failed", durationMs: Date.now() - started, errorCode: safeErrorCode(error) });
        throw error;
      }
    });
  }

  /**
   * @param {{ source_id: any }} row
   * @param {object} [options]
   * @param {object} [options.order] Order already fetched by the caller — the
   *   campaign path reads it off the list page it is already paginating, which
   *   removes one Woo GET per order.
   * @param {Set<string>} [options.mappedCustomers] Woo customer ids already
   *   provisioned in Strapi; skips re-provisioning a user this campaign wrote
   *   minutes earlier.
   * @param {Map<string, any>} [options.walletBalances] Bulk balance snapshot.
   * @param {Map<string, { id:number }>} [options.variationIndex] Variation
   *   external_id snapshot for the line-item repair path.
   */
  async syncOrderRow(row, options = {}) {
    await ensureActive(this.state);
    const order = options.order || await this.source.getOrder(row.source_id);
    let variationRepair = { ensured: [], present: [], failed: [] };
    try {
      const ensureFn = this.ensureOrderVariations || ensureOrderReferencedVariations;
      variationRepair = await ensureFn({
        source: this.source,
        repo: this.catalogRepo(),
        order,
        logger: console,
        variationIndex: options.variationIndex || null,
      });
    } catch (error) {
      variationRepair = {
        ensured: [],
        present: [],
        failed: [{ variationSourceId: "*", error: safeErrorCode(error) }],
      };
      console.warn("[WooSync] order variation ensure isolated", {
        sourceIdHash: logId("order", row.source_id),
        errorCode: safeErrorCode(error),
      });
    }
    const payload = T.orderPayload(order);
    const sideIssues = [];
    for (const failure of variationRepair.failed || []) {
      sideIssues.push(String(failure.error || "ORDER_VARIATION_ENSURE_FAILED").slice(0, 128));
    }
    // Provisioning the buyer here exists so an order whose customer the
    // identity stage never reached still gets an owner. When this campaign has
    // already provisioned them, both writes are re-writes of data fetched
    // minutes ago from the same snapshot — pure cost, so skip them. An unmapped
    // id keeps the full path: upsertOrder's resolveOrderUser soft-fails an
    // unknown customer into the billing-phone guest reconcile, so behaviour for
    // genuinely new customers is unchanged.
    const customerSourceKey = payload.customerSourceId ? String(payload.customerSourceId) : null;
    const alreadyProvisioned = Boolean(customerSourceKey && options.mappedCustomers?.has(customerSourceKey));
    if (customerSourceKey && !alreadyProvisioned) {
      try {
        const customer = await this.source.getCustomer(payload.customerSourceId);
        await ensureActive(this.state);
        await this.destination.upsertUser(T.customerPayload(customer));
      } catch (error) {
        sideIssues.push(safeErrorCode(error));
        console.warn("[WooSync] order customer upsert isolated", {
          sourceIdHash: logId("order", row.source_id),
          errorCode: safeErrorCode(error),
        });
      }
      try {
        const balance = options.walletBalances?.has(customerSourceKey)
          ? options.walletBalances.get(customerSourceKey)
          : T.walletBalanceValue(await this.source.getWalletBalance(payload.customerSourceId));
        await ensureActive(this.state);
        await this.destination.upsertWallet(T.walletPayload({
          id: payload.customerSourceId,
          balance,
        }));
      } catch (error) {
        if (!/NOT_FOUND|404/.test(String(error?.payload?.error || error?.message || ""))) {
          sideIssues.push(safeErrorCode(error));
          console.warn("[WooSync] order wallet upsert isolated", {
            sourceIdHash: logId("order", row.source_id),
            errorCode: safeErrorCode(error),
          });
        }
      }
    }
    await ensureActive(this.state);
    const result = await this.destination.upsertOrder(payload);
    return {
      ...result,
      sideIssues,
      variationsEnsured: variationRepair.ensured,
      hasSoftIssues: sideIssues.length > 0
        || Number(result?.itemsUnresolved || 0) > 0
        || (Array.isArray(result?.identityIssues) && result.identityIssues.length > 0)
        || (Array.isArray(result?.itemIssues) && result.itemIssues.length > 0),
    };
  }

  async processProductRows(rows, scope) {
    if (rows.length === 0) return new Map();
    await ensureActive(this.state);
    const products = [];
    for (const row of rows) products.push(await this.source.getProduct(row.source_id));
    const engine = createCatalogEngine(this.config);
    const report = await engine.runSync({
      dryRun: false,
      scope,
      skipMedia: false,
      sourceProducts: products,
    });
    const metrics = engine.collectMetrics(null, report);
    await this.state.metric({
      stage: `catalog:${scope}`,
      outcome: report.hasFailures() ? "completed-with-exceptions" : "completed",
      durationMs: report.durationMs(),
      itemCount: rows.length,
      byteCount: Number(metrics.media?.downloadBytes || 0) + Number(metrics.media?.uploadBytes || 0),
      detail: metrics,
    });
    const failures = new Map();
    for (const failure of report.toJSON().failures || []) {
      failures.set(String(failure.wcId), safeErrorCode(failure.error || failure.stage));
    }
    return failures;
  }

  async syncCustomerRow(row) {
    await ensureActive(this.state);
    const customer = await this.source.getCustomer(row.source_id);
    await ensureActive(this.state);
    return this.destination.upsertUser(T.customerPayload(customer));
  }

  async syncWalletRow(row) {
    await ensureActive(this.state);
    const customer = await this.source.getCustomer(row.source_id);
    await ensureActive(this.state);
    await this.destination.upsertUser(T.customerPayload(customer));
    const balance = await this.source.getWalletBalance(row.source_id);
    await ensureActive(this.state);
    return this.destination.upsertWallet(T.walletPayload({
      id: row.source_id,
      balance: T.walletBalanceValue(balance),
    }));
  }

  async drain(lane, parentToken = null, sourceTypes = ["product", "product-sweep", "customer", "wallet", "order"]) {
    await ensureActive(this.state);
    const leaseName = lane === "immediate" ? "discovery" : `drain:${lane}`;
    const execute = async (token) => {
      let completed = 0;
      let failed = 0;
      while (!this.stopping) {
        await this.state.assertLease(leaseName, token);
        const rows = await this.state.claimItems({ lane, sourceTypes, limit: 50, token });
        if (rows.length === 0) break;
        const productRows = rows.filter((row) => row.source_type === "product" || row.source_type === "product-sweep");
        const customerRows = rows.filter((row) => row.source_type === "customer");
        const walletRows = rows.filter((row) => row.source_type === "wallet");
        const orderRows = rows.filter((row) => row.source_type === "order");
        if (productRows.length > 0) {
          let failures;
          try {
            failures = await this.processProductRows(productRows, lane === "immediate" ? "full" : "full-sync");
          } catch (error) {
            failures = new Map(productRows.map((row) => [String(row.source_id), safeErrorCode(error)]));
          }
          for (const row of productRows) {
            const errorCode = failures.get(String(row.source_id));
            if (errorCode) {
              await this.state.failItem(row.id, token, errorCode);
              failed += 1;
              console.warn("[WooSync] product failed", { sourceIdHash: logId("product", row.source_id), errorCode });
            } else {
              await this.state.completeItem(row.id, token);
              completed += 1;
            }
          }
        }
        for (const [identityRows, sync, entity] of [
          [customerRows, (row) => this.syncCustomerRow(row), "customer"],
          [walletRows, (row) => this.syncWalletRow(row), "wallet"],
        ]) {
          await mapPool(identityRows, this.config.concurrency.entities, async (row) => {
            try {
              await sync(row);
              await this.state.completeItem(row.id, token);
              completed += 1;
            } catch (error) {
              const errorCode = safeErrorCode(error);
              await this.state.failItem(row.id, token, errorCode);
              failed += 1;
              console.warn(`[WooSync] ${entity} failed`, {
                sourceIdHash: logId(entity, row.source_id), errorCode,
              });
            }
          });
        }
        if (orderRows.length > 0) {
          await mapPool(orderRows, this.config.concurrency.entities, async (row) => {
            try {
              await this.syncOrderRow(row);
              await this.state.completeItem(row.id, token);
              completed += 1;
            } catch (error) {
              const errorCode = safeErrorCode(error);
              await this.state.failItem(row.id, token, errorCode);
              failed += 1;
              console.warn("[WooSync] order failed", { sourceIdHash: logId("order", row.source_id), errorCode });
            }
          });
        }
      }
      return { completed, failed };
    };
    return parentToken ? execute(parentToken) : this.withLease(leaseName, execute);
  }

  async variationSweep(token) {
    const cursor = await this.state.cursor("variation-sweep");
    let pageNumber = Number(cursor.sweep_page || 1);
    const response = await this.source.woo.get("/products", {
      per_page: this.config.variationSweepProducts,
      page: pageNumber,
      orderby: "id",
      order: "asc",
    });
    const products = Array.isArray(response.data) ? response.data : [];
    const totalPages = Number(response.headers.get("x-wp-totalpages") || 1);
    const control = await this.state.control();
    for (const product of products) {
      const variations = product.type === "simple" || !product.variations?.length
        ? []
        : await this.source.getProductVariations(product.id);
      await this.state.observe({
        sourceType: "product-sweep",
        sourceId: product.id,
        revisionSha256: sha256({ product: productRevision(product), variations: variations.map(productRevision) }),
        modifiedAt: sourceModifiedAt(product),
      }, control.mode, { insertLane: "hourly" });
    }
    pageNumber = pageNumber >= totalPages ? 1 : pageNumber + 1;
    await this.state.saveCursor("variation-sweep", { sweepPage: pageNumber }, "drain:hourly", token);
    return products.length;
  }

  async identitySweep(token) {
    if (this.config.identitySweepPages === 0) return { customers: 0, wallets: 0 };
    const control = await this.state.control();
    const sweep = async ({ sourceType, client, pathname, rowsFrom, revision, query = {} }) => {
      const cursor = await this.state.cursor(`${sourceType}-sweep`);
      let pageNumber = Number(cursor.sweep_page || 1);
      let observed = 0;
      for (let count = 0; count < this.config.identitySweepPages; count += 1) {
        const response = await client.get(pathname, {
          per_page: 100,
          page: pageNumber,
          ...query,
        });
        const rows = rowsFrom(response.data);
        const totalPages = Math.max(1, Number(response.headers.get("x-wp-totalpages")) || 1);
        for (const row of rows) {
          await this.state.observe({
            sourceType,
            sourceId: row.id,
            revisionSha256: revision(row),
            modifiedAt: sourceModifiedAt(row),
          }, control.mode, { insertLane: "hourly" });
          observed += 1;
        }
        pageNumber = pageNumber >= totalPages || rows.length < 100 ? 1 : pageNumber + 1;
        await this.state.assertLease("drain:hourly", token);
        if (pageNumber === 1) break;
      }
      await this.state.saveCursor(`${sourceType}-sweep`, { sweepPage: pageNumber }, "drain:hourly", token);
      return observed;
    };
    const [customers, wallets] = await Promise.all([
      sweep({
        sourceType: "customer",
        client: this.source.woo,
        pathname: "/customers",
        // WooCommerce customers support orderby=id.
        query: { orderby: "id", order: "asc" },
        rowsFrom: (data) => Array.isArray(data) ? data : [],
        revision: customerRevision,
      }),
      sweep({
        sourceType: "wallet",
        client: this.source.wallet,
        pathname: "/admin/users",
        // TeraWallet only allows login|email|display_name|registered|balance.
        query: { orderby: "registered", order: "asc" },
        rowsFrom: (data) => Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.users) ? data.users : [],
        revision: walletRevision,
      }),
    ]);
    return { customers, wallets };
  }

  async hourly() {
    return this.withLease("drain:hourly", async (token) => {
      const started = Date.now();
      const control = await this.state.control();
      const changes = await this.pollChanges("drain:hourly", token);
      const swept = await this.variationSweep(token);
      const identitiesSwept = await this.identitySweep(token);
      const immediate = control.mode === "active"
        ? await this.drain("immediate")
        : { completed: 0, failed: 0 };
      const hourly = control.mode === "active"
        ? await this.drain("hourly", token)
        : { completed: 0, failed: 0 };
      const completed = Number(immediate.completed || 0) + Number(hourly.completed || 0);
      const failed = Number(immediate.failed || 0) + Number(hourly.failed || 0);
      await this.state.metric({
        stage: "hourly",
        outcome: "completed",
        durationMs: Date.now() - started,
        itemCount: completed + failed,
        detail: { changes, swept, identitiesSwept, immediate, hourly, source: this.source.metrics(), destination: this.destination.metrics() },
      });
      return { completed, failed, changes, swept, identitiesSwept, immediate, hourly, mode: control.mode };
    });
  }

  /**
   * Read every wallet balance in one bulk pass.
   *
   * TeraWallet's /admin/users list carries `balance` inline, so ~161,700
   * per-customer balance GETs (2.6 h against a source that saturates at ~17
   * req/s) collapse into ~1,884 page fetches. The list was verified against
   * the per-id endpoint on production before this was adopted: 100% id
   * coverage, stable pagination, and 48/48 exact matches on non-zero balances.
   *
   * A row this cannot parse is simply left out of the map — the caller falls
   * back to the per-id endpoint for a miss, so completeness of the bulk list
   * is never load-bearing for correctness.
   */
  async loadWalletBalances({ pageConcurrency } = {}) {
    const balances = new Map();
    const concurrency = pageConcurrency ?? this.config.sourcePageConcurrency;
    let listed = 0;
    let duplicates = 0;
    let invalid = 0;
    for await (const page of this.source.walletUsers({ concurrency })) {
      for (const row of page.rows) {
        const sourceId = String(row?.id ?? "");
        if (!/^\d+$/.test(sourceId) || sourceId === "0") {
          invalid += 1;
          continue;
        }
        listed += 1;
        if (balances.has(sourceId)) {
          duplicates += 1;
          continue;
        }
        try {
          balances.set(sourceId, T.walletBalanceValue(row));
        } catch {
          invalid += 1;
        }
      }
    }
    console.info("[WooSync] wallet balances preloaded", { listed, unique: balances.size, duplicates, invalid });
    return { balances, listed, duplicates, invalid };
  }

  /**
   * Rehearsal-only cross-check of the bulk list against the per-id endpoint.
   *
   * Compares the *written* value (`wooWalletBalanceToRial`) rather than the raw
   * field, so "1000" vs 1000 is not a false positive while a genuinely
   * different Balance is caught. Every non-zero balance is checked (they are
   * ~0.6% of rows, and they are the only ones that can lose money) plus a
   * sample of zeroes to catch a systematically empty list.
   */
  async verifyWalletBalances(balances, { concurrency, zeroSampleEvery = 100 } = {}) {
    const normalize = (value) => {
      try {
        return T.wooWalletBalanceToRial(value ?? 0);
      } catch (error) {
        return `INVALID:${safeErrorCode(error)}`;
      }
    };
    const targets = [];
    let seen = 0;
    for (const [sourceId, bulk] of balances) {
      const isZero = normalize(bulk) === "0";
      if (!isZero || seen % zeroSampleEvery === 0) targets.push([sourceId, bulk]);
      seen += 1;
    }
    let checked = 0;
    let divergent = 0;
    let errors = 0;
    const examples = [];
    await mapPoolAsync(targets, concurrency ?? this.config.concurrency.entities, async ([sourceId, bulk]) => {
      let perId;
      try {
        perId = T.walletBalanceValue(await this.source.getWalletBalance(sourceId));
      } catch (error) {
        if (/NOT_FOUND|404/.test(String(error?.payload?.error || error?.message || ""))) return;
        errors += 1;
        return;
      }
      checked += 1;
      if (normalize(perId) !== normalize(bulk)) {
        divergent += 1;
        if (examples.length < 20) examples.push({ sourceIdHash: logId("customer", sourceId) });
      }
    });
    const result = { sampled: targets.length, checked, divergent, errors, examples };
    console.info("[WooSync] wallet bulk/per-id equivalence", { ...result, examples: examples.length });
    return result;
  }

  /**
   * Woo customer ids this destination has already provisioned a user for.
   *
   * `resolveRegisteredCustomerForOrder` writes exactly this row on every
   * successful order-customer resolution, so after the identity stage the set
   * is the authoritative "already has a Strapi user" answer — letting the order
   * stage skip a getCustomer + upsertUser + upsertWallet round-trip per order.
   */
  async loadMappedCustomerIds() {
    const result = await this.pool.query(
      `SELECT source_key FROM customer_identity_mappings
        WHERE source_system = 'woocommerce' AND source_kind = 'customer'`,
    );
    const mapped = new Set(result.rows.map((row) => String(row.source_key)));
    console.info("[WooSync] provisioned customer mappings loaded", { count: mapped.size });
    return mapped;
  }

  /**
   * @param {object} [opts]
   * @param {{ balances?: Map<string, any> }} [opts.handoff] Filled with the bulk
   *   balance snapshot so the order stage can reuse it. Out-of-band because the
   *   returned summary is JSON-serialized into campaign metrics.
   */
  async fullUsersAndWallets({ concurrency, balances = null, verify = false, handoff = null } = {}) {
    let users = 0;
    let wallets = 0;
    let failed = 0;
    let fallbacks = 0;
    let missing = 0;
    const poolSize = concurrency ?? this.config.concurrency.entities;
    const pageConcurrency = this.config.sourcePageConcurrency;
    const preload = balances || await this.loadWalletBalances({ pageConcurrency });
    const walletBalances = preload.balances;
    if (handoff) handoff.balances = walletBalances;

    const verification = verify
      ? await this.verifyWalletBalances(walletBalances, { concurrency: poolSize })
      : null;

    await mapPoolAsync(
      pageRows(this.source.customers({}, { concurrency: pageConcurrency })),
      poolSize,
      async (customer) => {
        try {
          await ensureActive(this.state);
          await this.destination.upsertUser(T.customerPayload(customer));
          users += 1;
          try {
            const sourceId = String(customer.id);
            let balance;
            if (walletBalances.has(sourceId)) {
              balance = walletBalances.get(sourceId);
            } else {
              // Bulk list miss: fall back to exactly today's per-id path, so a
              // gap in the list degrades to the old cost, never to a wrong
              // balance or a dropped wallet.
              fallbacks += 1;
              balance = T.walletBalanceValue(await this.source.getWalletBalance(customer.id));
            }
            await ensureActive(this.state);
            await this.destination.upsertWallet(T.walletPayload({ id: customer.id, balance }));
            wallets += 1;
          } catch (error) {
            if (/NOT_FOUND|404/.test(String(error?.payload?.error || error?.message || ""))) {
              missing += 1;
              return;
            }
            throw error;
          }
        } catch (error) {
          failed += 1;
          console.warn("[WooSync] campaign user failed", {
            sourceIdHash: logId("customer", customer.id),
            errorCode: safeErrorCode(error),
          });
        }
      },
    );
    return {
      users,
      wallets,
      failed,
      wallet: {
        listed: preload.listed,
        unique: walletBalances.size,
        duplicates: preload.duplicates,
        invalid: preload.invalid,
        fallbacks,
        missing,
        ...(verification ? { divergence: verification.divergent, verified: verification.checked } : {}),
      },
    };
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.preload] Campaign path: enumerate the provisioned
   *   customer mappings and the variation index once up front. Off by default so
   *   a plain fullOrders() call behaves exactly as it always has.
   */
  async fullOrders({
    concurrency,
    preload = false,
    mappedCustomers = null,
    walletBalances = null,
    variationIndex = null,
  } = {}) {
    let completed = 0;
    let failed = 0;
    let softIssues = 0;
    const poolSize = concurrency ?? this.config.concurrency.entities;
    const pageConcurrency = this.config.sourcePageConcurrency;
    // Loaded here rather than by the caller so that stubbing fullOrders in a
    // test never triggers a source or destination read.
    const mapped = mappedCustomers || (preload ? await this.loadMappedCustomerIds() : null);
    // One enumeration replaces a per-line-item Strapi lookup (~150k GETs across
    // a full order run). It is a snapshot; ensureOrderReferencedVariations
    // writes anything it creates back into it.
    const variations = variationIndex
      || (preload ? await this.catalogRepo().buildExternalIndex("/product-variations") : null);
    await mapPoolAsync(
      pageRows(this.source.orders({}, { concurrency: pageConcurrency })),
      poolSize,
      async (order) => {
        const sourceId = order.id;
        const revisionSha256 = orderRevision(order);
        const modifiedAt = sourceModifiedAt(order);
        try {
          // The list page already carries the full order payload.
          const result = await this.syncOrderRow({ source_id: sourceId }, {
            order,
            mappedCustomers: mapped,
            walletBalances,
            variationIndex: variations,
          });
          await this.state.recordOrderOutcome({
            sourceId,
            revisionSha256,
            modifiedAt,
            outcome: "completed",
            errorCode: result?.hasSoftIssues
              ? String(
                [...(result.sideIssues || []), ...(result.identityIssues || []), ...(result.itemIssues || [])][0]
                || "ORDER_SOFT_ISSUES",
              ).slice(0, 128)
              : null,
          });
          completed += 1;
          if (result?.hasSoftIssues) softIssues += 1;
        } catch (error) {
          failed += 1;
          const errorCode = safeErrorCode(error);
          await this.state.recordOrderOutcome({
            sourceId,
            revisionSha256,
            modifiedAt,
            outcome: "failed",
            errorCode,
          }).catch(() => undefined);
          console.warn("[WooSync] campaign order failed", {
            sourceIdHash: logId("order", order.id), errorCode,
          });
        }
      },
    );
    return { completed, failed, softIssues, fetched: completed + failed };
  }

  /**
   * @param {number} scheduledTimestamp
   * @param {{ variant?: "full"|"cutover" }} [opts] Defaults to config.campaignVariant.
   *   "full" keeps the historical stage sequence exactly; "cutover" overlaps
   *   catalog-full with users/wallets and replaces the separate stock+price
   *   stages with one inventory pass, to fit a fixed maintenance window.
   */
  async friday(scheduledTimestamp = Date.now(), { variant: variantOption } = {}) {
    const variant = variantOption || this.config.campaignVariant || "full";
    return this.withLease("campaign:friday", async (token) => {
      await ensureActive(this.state);
      const scheduledFor = new Date(scheduledTimestamp);
      const dateKey = new Intl.DateTimeFormat("en-CA", {
        timeZone: this.config.timezone, year: "numeric", month: "2-digit", day: "2-digit",
      }).format(scheduledFor);
      const campaignKey = `friday:${dateKey}`;
      if (Date.now() - scheduledFor.getTime() > this.config.lateCampaignHours * 3600_000) {
        await this.state.markMissedCampaign(campaignKey, scheduledFor, "FRIDAY_CAMPAIGN_LATE_START");
        throw new UnrecoverableError("Friday campaign wake-up exceeded the configured late-start window");
      }
      const campaign = await this.state.startCampaign(campaignKey, scheduledFor, token);
      if (["completed", "completed-with-exceptions", "missed"].includes(campaign.status)) {
        return { skipped: true, reason: `already-${campaign.status}` };
      }
      this.activeCampaign = { campaignKey, token };
      const campaignStartedAt = Date.now();
      const durationsMs = {};
      let stageStartedAt = campaignStartedAt;
      const markStage = () => {
        const now = Date.now();
        const elapsed = now - stageStartedAt;
        stageStartedAt = now;
        return elapsed;
      };
      try {
        await this.state.campaignStep(campaignKey, token, "new-products");
        const immediate = await this.drain("immediate", null, ["product"]);
        durationsMs.newProducts = markStage();
        if (immediate.skipped || immediate.failed > 0) {
          const error = new Error("Friday new-product drain did not complete cleanly");
          error.code = immediate.skipped ? "FRIDAY_NEW_PRODUCTS_LEASE_HELD" : "FRIDAY_NEW_PRODUCTS_HAS_FAILURES";
          throw error;
        }
        // Nightly cutover runs off-peak with a large catalog — push concurrency hard.
        // Product parents stay serial for catalog-full (CatalogEngine safety: shared
        // tag/attribute find-or-create caches). "stock" and "price" write neither, so
        // fridayProducts (opt into WOOCOMMERCE_IMPORT_PROFILE=fast to raise it) actually
        // parallelizes those two stages — CatalogEngine#resolveProductConcurrency forces
        // it back to 1 for catalog-full regardless of this value.
        const campaignConcurrency = {
          ...this.config.concurrency,
          variations: this.config.concurrency.fridayInventory,
          images: this.config.concurrency.fridayImages,
          entities: this.config.concurrency.fridayEntities,
          products: this.config.concurrency.fridayProducts,
        };
        const campaignConfig = {
          ...this.config,
          concurrency: campaignConcurrency,
          sourcePageConcurrency: Math.max(this.config.sourcePageConcurrency, 8),
        };
        const engineFactory = this.createCatalogEngine || createCatalogEngine;
        const runCatalogScope = async (scope, label = scope) => catalogReportSummary(
          label,
          await engineFactory(campaignConfig).runSync({ dryRun: false, scope }),
        );
        // Shared between the identity and order stages: the order stage takes a
        // buyer's balance from this snapshot instead of re-reading it.
        const identityHandoff = {};
        const runIdentities = async () => this.fullUsersAndWallets({
          concurrency: campaignConcurrency.entities,
          verify: Boolean(this.config.walletVerify),
          handoff: identityHandoff,
        });
        // preload:true resolves the provisioned-customer set inside fullOrders,
        // which runs after the identity stage — so it includes the users this
        // campaign just created.
        const runOrders = async () => this.fullOrders({
          concurrency: campaignConcurrency.entities,
          preload: true,
          walletBalances: identityHandoff.balances || null,
        });

        let catalog;
        let identities;
        let orders;
        let stock = null;
        let price = null;
        let inventory = null;

        if (variant === "cutover") {
          // catalog-full is Woo-bound and forced serial (shared tag/attribute
          // caches); users/wallets is destination-bound. Overlapping them makes
          // catalog-full's floor the critical path instead of the sum.
          await this.state.campaignStep(campaignKey, token, "catalog-full+users-wallets", {
            immediate, variant, durationsMs: { newProducts: durationsMs.newProducts },
          });
          // Each branch times itself: the combined wall clock alone cannot say
          // which of the two is the critical path, which is precisely what the
          // rehearsal run has to answer.
          const timed = async (key, run) => {
            const startedAt = Date.now();
            try {
              return await run();
            } finally {
              durationsMs[key] = Date.now() - startedAt;
            }
          };
          // allSettled, not all: a rejected branch must not finish the campaign
          // and drop the lease while the other branch is still writing.
          const [catalogSettled, identitySettled] = await Promise.allSettled([
            timed("catalogFull", () => runCatalogScope("full-sync")),
            timed("usersWallets", runIdentities),
          ]);
          if (catalogSettled.status === "rejected") throw catalogSettled.reason;
          if (identitySettled.status === "rejected") throw identitySettled.reason;
          catalog = catalogSettled.value;
          identities = identitySettled.value;
          durationsMs.catalogFullUsersWallets = markStage();

          await this.state.campaignStep(campaignKey, token, "orders", {
            catalog, identities,
            durationsMs: { catalogFullUsersWallets: durationsMs.catalogFullUsersWallets },
          });
          orders = await runOrders();
          durationsMs.orders = markStage();

          // Inventory last: stock is the value that oversells when stale, and
          // by here users and orders are already durable.
          await this.state.campaignStep(campaignKey, token, "inventory", {
            orders, durationsMs: { orders: durationsMs.orders },
          });
          // Labelled "stock" so FRIDAY_STOCK_HAS_FAILURES and the metric keys
          // stay where the runbook and dashboards expect them.
          inventory = await runCatalogScope("inventory-instock", "stock");
          assertCatalogReportSucceeded(inventory);
          durationsMs.inventory = markStage();
          await this.state.campaignStep(campaignKey, token, "inventory-complete", {
            inventory, durationsMs: { inventory: durationsMs.inventory },
          });
        } else {
          // full-sync: every product + backfill missing media; preserve existing covers.
          // Soft-fail — media flake must not abort wallets/orders for the night.
          await this.state.campaignStep(campaignKey, token, "catalog-full", { immediate, variant, durationsMs: { newProducts: durationsMs.newProducts } });
          catalog = await runCatalogScope("full-sync");
          durationsMs.catalogFull = markStage();
          await this.state.campaignStep(campaignKey, token, "inventory", { catalog, durationsMs: { catalogFull: durationsMs.catalogFull } });
          stock = await runCatalogScope("stock");
          assertCatalogReportSucceeded(stock);
          durationsMs.stock = markStage();
          price = await runCatalogScope("price");
          assertCatalogReportSucceeded(price);
          durationsMs.price = markStage();
          await this.state.campaignStep(campaignKey, token, "inventory-complete", {
            stock, price, durationsMs: { stock: durationsMs.stock, price: durationsMs.price },
          });
          await this.state.campaignStep(campaignKey, token, "users-wallets");
          identities = await runIdentities();
          durationsMs.usersWallets = markStage();
          await this.state.campaignStep(campaignKey, token, "orders", { identities, durationsMs: { usersWallets: durationsMs.usersWallets } });
          orders = await runOrders();
          durationsMs.orders = markStage();
        }
        durationsMs.totalMs = Date.now() - campaignStartedAt;
        // Denominators are the same wall-clock stage timers reported in durationsMs
        // (not report.durationMs(), which is measured at toJSON() time inside
        // catalogReportSummary) so a reader can cross-check duration vs throughput.
        // In the cutover variant catalog-full and users/wallets share one
        // wall-clock window, so both rates are measured against it.
        const identityWindowMs = durationsMs.usersWallets ?? durationsMs.catalogFullUsersWallets;
        const catalogWindowMs = durationsMs.catalogFull ?? durationsMs.catalogFullUsersWallets;
        const throughput = {
          catalogFullProductsPerSec: throughputPerSec(catalog.processed, catalogWindowMs),
          ...(stock ? { stockProductsPerSec: throughputPerSec(stock.processed, durationsMs.stock) } : {}),
          ...(price ? { priceProductsPerSec: throughputPerSec(price.processed, durationsMs.price) } : {}),
          ...(inventory ? { inventoryProductsPerSec: throughputPerSec(inventory.processed, durationsMs.inventory) } : {}),
          usersWalletsPerSec: throughputPerSec((identities.users || 0) + (identities.wallets || 0), identityWindowMs),
          ordersPerSec: throughputPerSec(orders.completed, durationsMs.orders),
        };
        const status = (
          Number(catalog.failed || 0) > 0
          || Number(identities.failed || 0) > 0
          || Number(orders.failed || 0) > 0
        )
          ? "completed-with-exceptions"
          : "completed";
        await this.state.campaignStep(campaignKey, token, "finalizing", {
          orders,
          durationsMs,
          throughput,
          variant,
          wallet: identities.wallet || null,
          ...(inventory?.stockGate ? { stockGate: inventory.stockGate } : {}),
        });
        await this.state.finishCampaign(campaignKey, token, status);
        console.info("[WooSync] friday campaign finished", {
          campaignKey, variant, status, durationsMs, throughput,
          wallet: identities.wallet || null,
          stockGate: inventory?.stockGate || null,
        });
        return {
          campaignKey, variant, status, catalog, identities, orders,
          ...(stock ? { stock } : {}),
          ...(price ? { price } : {}),
          ...(inventory ? { inventory } : {}),
          durationsMs, throughput,
        };
      } catch (error) {
        await this.state.finishCampaign(campaignKey, token, "failed", safeErrorCode(error)).catch(() => undefined);
        throw error;
      } finally {
        this.activeCampaign = null;
      }
    });
  }

  /**
   * Best-effort "this process is dying" finalizer, for callers wiring up
   * `unhandledRejection` / `uncaughtException` / signal handlers.
   *
   * A campaign that dies out-of-band leaves its row `running`, which is not a
   * terminal status: `startCampaign`'s ON CONFLICT resets it, so the next
   * scheduled campaign silently re-runs the whole thing instead of skipping.
   * That is exactly what happened on 2026-09-12 — the process was killed by an
   * unhandled rejection, so the catch above never ran.
   *
   * Never throws: it is called from a path that is already failing.
   */
  async finalizeActiveCampaign(errorCode = "PROCESS_FATAL") {
    const active = this.activeCampaign;
    if (!active) return false;
    this.activeCampaign = null;
    try {
      await this.state.finishCampaign(active.campaignKey, active.token, "failed", errorCode);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Periodic full-catalog reconciliation — the safety net behind the delta poll.
   * `hourly()`'s pollWooEntity only sees products WooCommerce reports modified
   * since the last cursor; a cursor gap, a skipped page, or (once webhooks exist)
   * a dropped delivery can leave a product permanently unobserved. This composes
   * CatalogEngine's own read-only compare (`runVerify`, already paginates the
   * complete WooCommerce and Strapi catalogs) with the exact same repair
   * primitives every other method in this file uses — it is not a second
   * importer and it does not write to Strapi directly.
   *
   *  - wcOnly (Woo has it, Strapi doesn't): observed into the same "hourly"
   *    queue lane pollWooEntity uses, then drained through the normal,
   *    authoritative sync pipeline (processProductRows / CatalogEngine).
   *  - strapiOnly (Strapi has it, this run's Woo enumeration didn't): NEVER
   *    inferred as deleted from the compare alone. Each id is re-fetched
   *    individually; only a clean 404 counts as confirmed-missing. Every other
   *    outcome (timeout, 5xx, auth failure, network error) is recorded as
   *    "unknown". This job never unpublishes or deletes anything — orphans are
   *    reported for human review only.
   */
  /** Seam kept separate from reconcile() so tests can stub the CatalogEngine-touching
   * parts without a real Woo/Strapi connection — mirrors how hourly() stubs
   * pollChanges/variationSweep/drain rather than reaching into CatalogEngine inline. */
  async runCatalogVerify() {
    const engine = createCatalogEngine(this.config);
    const { wcOnly, strapiOnly } = await engine.runVerify({ status: "any" });
    return { engine, wcOnly, strapiOnly };
  }

  async repairMissingProductMedia(engine) {
    return reconcileMissingProductMedia({
      woo: engine.woo,
      repo: engine.repo,
      media: engine.media,
      logger: console,
      dryRun: false,
      confirm: "CatalogMediaRepair",
    });
  }

  async reconcile() {
    return this.withLease("reconcile", async (token) => {
      const started = Date.now();
      try {
        await ensureActive(this.state);
        const { engine, wcOnly, strapiOnly } = await this.runCatalogVerify();

        let missedObserved = 0;
        let missedFailed = 0;
        await mapPool(wcOnly, this.config.concurrency.entities, async (wcIdRaw) => {
          if (this.stopping) return;
          const wcId = Number(wcIdRaw);
          try {
            const row = await this.source.getProduct(wcId);
            await this.state.observe({
              sourceType: "product",
              sourceId: wcId,
              revisionSha256: productRevision(row),
              modifiedAt: sourceModifiedAt(row),
            }, "active", { insertLane: "hourly" });
            missedObserved += 1;
          } catch (error) {
            missedFailed += 1;
            console.warn("[WooSync] reconcile: failed to observe missing product", {
              sourceIdHash: logId("product", wcId), errorCode: safeErrorCode(error),
            });
          }
        });

        const orphansByStatus = { [ORPHAN_STATUS.CONFIRMED_MISSING]: 0, [ORPHAN_STATUS.UNKNOWN]: 0 };
        const orphanExamples = [];
        await mapPool(strapiOnly, this.config.concurrency.entities, async (idRaw) => {
          if (this.stopping) return;
          const id = Number(idRaw);
          let status;
          try {
            await this.source.getProduct(id);
            // Woo actually has it — this run's enumeration missed it (e.g. a
            // status this reconciliation pass didn't request); not an orphan.
            return;
          } catch (error) {
            status = error?.status === 404 ? ORPHAN_STATUS.CONFIRMED_MISSING : ORPHAN_STATUS.UNKNOWN;
          }
          orphansByStatus[status] += 1;
          if (orphanExamples.length < 20) orphanExamples.push({ sourceIdHash: logId("product", id), status });
        });

        // Give missed products a real chance to reach Strapi in this same run
        // rather than waiting for the next scheduled hourly tick.
        const drained = missedObserved > 0 ? await this.drain("hourly") : { completed: 0, failed: 0 };

        const mediaSummary = await this.repairMissingProductMedia(engine);

        await this.state.metric({
          stage: "reconcile",
          outcome: "completed",
          durationMs: Date.now() - started,
          itemCount: wcOnly.length + strapiOnly.length,
          detail: {
            missed: { found: wcOnly.length, observed: missedObserved, failed: missedFailed },
            orphans: { candidates: strapiOnly.length, byStatus: orphansByStatus, examples: orphanExamples },
            drained,
            media: mediaSummary,
          },
        });

        return {
          missed: { found: wcOnly.length, observed: missedObserved, failed: missedFailed },
          orphans: { candidates: strapiOnly.length, byStatus: orphansByStatus },
          drained,
          media: mediaSummary,
        };
      } catch (error) {
        await this.state.metric({
          stage: "reconcile", outcome: "failed", durationMs: Date.now() - started, errorCode: safeErrorCode(error),
        });
        throw error;
      }
    });
  }

  async close() {
    this.stopping = true;
    await this.pool.end();
  }
}

async function registerSchedulers(queue, config) {
  const opts = {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
  };
  const definitions = [
    ["discovery", { every: config.pollMs }, JOBS.discovery],
    ["hourly", { pattern: "0 * * * *", tz: config.timezone }, JOBS.hourly],
    ["friday", { pattern: config.fridayCron, tz: config.timezone }, JOBS.friday],
    ["reconcile", { pattern: config.reconcileCron, tz: config.timezone }, JOBS.reconcile],
  ];
  for (const [schedule, repeat, jobName] of definitions) {
    if (config.schedules[schedule]) {
      await queue.upsertJobScheduler(SCHEDULERS[schedule], repeat, {
        name: jobName, data: {}, opts,
      });
    } else {
      await queue.removeJobScheduler(SCHEDULERS[schedule]);
    }
  }
}

async function start() {
  const config = getSyncConfig();
  const connection = redisConnection(config);
  const queue = new Queue(QUEUE_NAME, { connection, prefix: config.queuePrefix });
  const service = new WooSyncService(config);
  await registerSchedulers(queue, config);
  if (config.schedules.discovery) {
    await queue.add(JOBS.discovery, {}, { jobId: `startup-${Math.floor(Date.now() / config.pollMs)}` });
  } else if (config.schedules.hourly) {
    await queue.add(JOBS.hourly, {}, { jobId: `startup-hourly-${Math.floor(Date.now() / 3_600_000)}` });
  }
  const worker = new Worker(QUEUE_NAME, async (job) => {
    if (job.name === JOBS.discovery) return service.discovery();
    if (job.name === JOBS.hourly) return service.hourly();
    if (job.name === JOBS.friday) {
      return service.friday(fridayScheduledTimestamp(job), { variant: job.data?.variant });
    }
    if (job.name === JOBS.reconcile) return service.reconcile();
    throw new UnrecoverableError(`Unknown Woo sync job: ${job.name}`);
  }, { connection, prefix: config.queuePrefix, concurrency: 1, lockDuration: config.leaseSeconds * 1000 });

  worker.on("completed", (job) => console.info("[WooSync] job completed", { name: job.name, jobId: job.id }));
  worker.on("failed", (job, error) => console.error("[WooSync] job failed", { name: job?.name, jobId: job?.id, errorCode: safeErrorCode(error) }));
  worker.on("stalled", (jobId) => console.warn("[WooSync] job stalled", { jobId }));
  worker.on("error", (error) => console.error("[WooSync] worker error", { errorCode: safeErrorCode(error) }));

  const shutdown = async () => {
    service.stopping = true;
    await worker.close();
    await queue.close();
    await service.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  // Without these, an unhandled rejection anywhere — including a speculative
  // prefetch nobody is awaiting — terminates this worker outright, taking the
  // hourly poll, discovery and the campaign scheduler down with it, and leaving
  // any in-flight campaign row stuck at `running` (a NON-terminal status, so the
  // next scheduled campaign silently re-runs everything). That is how the
  // 2026-09-12 run died.
  //
  // Exiting non-zero is deliberate: the container runs `unless-stopped`, so
  // Docker restarts it and the worker self-heals. Swallowing the rejection and
  // limping on would hide a real bug and risk acting on corrupt state.
  let dying = false;
  const dieFatal = (label) => (reason) => {
    if (dying) return;
    dying = true;
    console.error("[WooSync] fatal", {
      label,
      errorCode: safeErrorCode(reason),
      message: reason?.message,
      causeCode: reason?.cause?.code,
    });
    if (reason?.stack) console.error(reason.stack);
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref?.();
    service.finalizeActiveCampaign(`PROCESS_${label}`)
      .then((marked) => console.error("[WooSync] campaign row marked failed", { marked }))
      .catch(() => undefined)
      .finally(() => process.exit(1));
  };
  process.on("unhandledRejection", dieFatal("UNHANDLED_REJECTION"));
  process.on("uncaughtException", dieFatal("UNCAUGHT_EXCEPTION"));
  console.info("[WooSync] ready", {
    mode: (await service.state.control()).mode,
    pollMs: config.pollMs,
    timezone: config.timezone,
    schedules: config.schedules,
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error("[WooSync] startup failed", { errorCode: safeErrorCode(error) });
    process.exit(1);
  });
}

module.exports = {
  WooSyncService,
  describeError,
  registerSchedulers,
  redisConnection,
  productRevision,
  orderRevision,
  customerRevision,
  walletRevision,
  sourceModifiedAt,
  safeErrorCode,
  fridayScheduledTimestamp,
  catalogReportSummary,
  assertCatalogReportSucceeded,
  JOBS,
  SCHEDULERS,
};
