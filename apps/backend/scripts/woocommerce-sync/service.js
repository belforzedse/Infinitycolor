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
const { buildConfig } = require("../woocommerce-importer/catalog/config");
const { reconcileMissingProductMedia } = require("../woocommerce-importer/catalog/lib/mediaRecovery");
const Logger = require("../woocommerce-importer/utils/Logger");

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
  };
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

class WooSyncService {
  constructor(config, { pool = null, source = null, destination = null } = {}) {
    this.config = config;
    this.pool = pool || new Pool({ ...config.postgres, max: 4, idleTimeoutMillis: 30_000 });
    this.state = new SyncStateStore(this.pool, { owner: config.instanceId, leaseSeconds: config.leaseSeconds });
    this.source = source || new WordPressSource(config.source);
    this.destination = destination || new Destination({ ...config.source, ...config.destination });
    this.stopping = false;
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

  async syncOrderRow(row) {
    await ensureActive(this.state);
    const order = await this.source.getOrder(row.source_id);
    const payload = T.orderPayload(order);
    if (payload.customerSourceId) {
      const customer = await this.source.getCustomer(payload.customerSourceId);
      await ensureActive(this.state);
      await this.destination.upsertUser(T.customerPayload(customer));
      try {
        const balance = await this.source.getWalletBalance(payload.customerSourceId);
        await ensureActive(this.state);
        await this.destination.upsertWallet(T.walletPayload({
          id: payload.customerSourceId,
          balance: T.walletBalanceValue(balance),
        }));
      } catch (error) {
        if (!/NOT_FOUND|404/.test(String(error?.payload?.error || error?.message || ""))) throw error;
      }
    }
    await ensureActive(this.state);
    return this.destination.upsertOrder(payload);
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

  async fullUsersAndWallets({ concurrency } = {}) {
    let users = 0;
    let wallets = 0;
    let failed = 0;
    const poolSize = concurrency ?? this.config.concurrency.entities;
    for await (const page of this.source.customers()) {
      await mapPool(page.rows, poolSize, async (customer) => {
        try {
          await ensureActive(this.state);
          await this.destination.upsertUser(T.customerPayload(customer));
          users += 1;
          try {
            const balance = await this.source.getWalletBalance(customer.id);
            await ensureActive(this.state);
            await this.destination.upsertWallet(T.walletPayload({
              id: customer.id,
              balance: T.walletBalanceValue(balance),
            }));
            wallets += 1;
          } catch (error) {
            if (/NOT_FOUND|404/.test(String(error?.payload?.error || error?.message || ""))) return;
            throw error;
          }
        } catch (error) {
          failed += 1;
          console.warn("[WooSync] campaign user failed", {
            sourceIdHash: logId("customer", customer.id),
            errorCode: safeErrorCode(error),
          });
        }
      });
    }
    return { users, wallets, failed };
  }

  async fullOrders({ concurrency } = {}) {
    let completed = 0;
    let failed = 0;
    const poolSize = concurrency ?? this.config.concurrency.entities;
    for await (const page of this.source.orders()) {
      await mapPool(page.rows, poolSize, async (order) => {
        try {
          await this.syncOrderRow({ source_id: order.id });
          completed += 1;
        } catch (error) {
          failed += 1;
          console.warn("[WooSync] campaign order failed", {
            sourceIdHash: logId("order", order.id), errorCode: safeErrorCode(error),
          });
        }
      });
    }
    return { completed, failed };
  }

  async friday(scheduledTimestamp = Date.now()) {
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
      try {
        await this.state.campaignStep(campaignKey, token, "new-products");
        const immediate = await this.drain("immediate", null, ["product"]);
        if (immediate.skipped || immediate.failed > 0) {
          const error = new Error("Friday new-product drain did not complete cleanly");
          error.code = immediate.skipped ? "FRIDAY_NEW_PRODUCTS_LEASE_HELD" : "FRIDAY_NEW_PRODUCTS_HAS_FAILURES";
          throw error;
        }
        // Nightly cutover runs off-peak with a large catalog — push concurrency hard.
        // Product parents stay serial (CatalogEngine safety); media/variations/entities scale up.
        const campaignConcurrency = {
          ...this.config.concurrency,
          variations: this.config.concurrency.fridayInventory,
          images: this.config.concurrency.fridayImages,
          entities: this.config.concurrency.fridayEntities,
        };
        const campaignConfig = {
          ...this.config,
          concurrency: campaignConcurrency,
          sourcePageConcurrency: Math.max(this.config.sourcePageConcurrency, 8),
        };
        const engineFactory = this.createCatalogEngine || createCatalogEngine;
        // full-sync: every product + backfill missing media; preserve existing covers.
        // Soft-fail — media flake must not abort wallets/orders for the night.
        await this.state.campaignStep(campaignKey, token, "catalog-full", { immediate });
        const catalog = catalogReportSummary(
          "full-sync",
          await engineFactory(campaignConfig).runSync({ dryRun: false, scope: "full-sync" }),
        );
        await this.state.campaignStep(campaignKey, token, "inventory", { catalog });
        const stock = catalogReportSummary(
          "stock",
          await engineFactory(campaignConfig).runSync({ dryRun: false, scope: "stock" }),
        );
        assertCatalogReportSucceeded(stock);
        const price = catalogReportSummary(
          "price",
          await engineFactory(campaignConfig).runSync({ dryRun: false, scope: "price" }),
        );
        assertCatalogReportSucceeded(price);
        await this.state.campaignStep(campaignKey, token, "inventory-complete", { stock, price });
        await this.state.campaignStep(campaignKey, token, "users-wallets");
        const identities = await this.fullUsersAndWallets({ concurrency: campaignConcurrency.entities });
        await this.state.campaignStep(campaignKey, token, "orders", { identities });
        const orders = await this.fullOrders({ concurrency: campaignConcurrency.entities });
        const status = (
          Number(catalog.failed || 0) > 0
          || Number(identities.failed || 0) > 0
          || Number(orders.failed || 0) > 0
        )
          ? "completed-with-exceptions"
          : "completed";
        await this.state.finishCampaign(campaignKey, token, status);
        return { campaignKey, status, catalog, identities, orders };
      } catch (error) {
        await this.state.finishCampaign(campaignKey, token, "failed", safeErrorCode(error)).catch(() => undefined);
        throw error;
      }
    });
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
    if (job.name === JOBS.friday) return service.friday(fridayScheduledTimestamp(job));
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
