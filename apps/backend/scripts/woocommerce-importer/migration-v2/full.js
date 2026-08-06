"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CatalogEngine } = require("../catalog/engine");
const { buildConfig } = require("../catalog/config");
const { CatalogRunStore } = require("../catalog/lib/runStore");
const Logger = require("../utils/Logger");
const T = require("./lib/transforms");
const { loadBlogDestinationIndexes } = require("./dry-run");
const { loadApprovedGuestPhones, upsertPilotBlog } = require("./pilot");

async function mapPool(items, concurrency, action) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await action(items[index]);
    }
  });
  await Promise.all(workers);
}

function catalogTracking(config) {
  const trackingDir = path.join(config.stateDir, "catalog");
  return { trackingDir, runStore: new CatalogRunStore(trackingDir) };
}

function acceptedCatalogState(run) {
  if (run?.status === "completed") return { accepted: false, manifest: null };
  if (
    run?.status === "completed-with-exceptions" &&
    run.acceptedExceptions?.manifestSha256 &&
    Array.isArray(run.acceptedExceptions.entries) &&
    run.acceptedExceptions.entries.length > 0
  ) {
    return { accepted: true, manifest: run.acceptedExceptions };
  }
  return null;
}

function catalogCheckpoint(run) {
  const accepted = acceptedCatalogState(run);
  if (!accepted) return { runId: run.id, completed: false, status: run.status };
  return {
    runId: run.id,
    completed: true,
    status: run.status,
    exceptionManifestSha256: accepted.manifest?.manifestSha256 || null,
    exceptionCount: Number(accepted.manifest?.entries?.length || 0),
    dependentOrderCount: Number(accepted.manifest?.dependentOrderIds?.length || 0),
  };
}

async function runCatalogFull(config, ledger, resume) {
  const { trackingDir, runStore } = catalogTracking(config);
  fs.mkdirSync(trackingDir, { recursive: true, mode: 0o700 });
  const { config: catalogConfig } = buildConfig("production");
  catalogConfig.duplicateTracking.storageDir = trackingDir;
  catalogConfig.catalog.trackingDirAbs = trackingDir;
  const logger = new Logger({ ...catalogConfig.logging, level: "info" });
  const engine = new CatalogEngine(catalogConfig, logger, { environment: "production" });
  const catalogRunId = `${ledger.runId}-catalog`;
  const canResumeCatalog = resume && runStore.hasRun(catalogRunId);
  if (canResumeCatalog) {
    const current = runStore.getRun(catalogRunId);
    if (acceptedCatalogState(current)) {
      ledger.summary.catalogExceptions = current.acceptedExceptions || null;
      ledger.checkpoint("catalog", catalogCheckpoint(current));
      return current;
    }
  }
  const report = await engine.runSync({
    runStore,
    runId: catalogRunId,
    ...(canResumeCatalog ? { resume: true, retryFailed: true } : {}),
    dryRun: false,
    scope: "full",
  });
  ledger.summary.catalogFull = report.toJSON();
  const current = runStore.getRun(catalogRunId);
  ledger.checkpoint("catalog", catalogCheckpoint(current));
  if (report.hasFailures()) throw new Error("CATALOG_FULL_HAS_FAILURES");
  return current;
}

async function runUsers(source, destination, ledger, resumePage, concurrency = 8) {
  const invalid = new Map();
  const phones = new Map();
  const emails = new Map();
  for await (const page of source.customers()) {
    for (const customer of page.rows) {
      const sourceId = String(customer.id || "");
      let payload;
      try {
        payload = T.customerPayload(customer);
      } catch (error) {
        invalid.set(sourceId, error.message);
        continue;
      }
      const phoneOwner = phones.get(payload.phone);
      if (phoneOwner && phoneOwner !== sourceId) {
        invalid.set(phoneOwner, "USER_DUPLICATE_PHONE");
        invalid.set(sourceId, "USER_DUPLICATE_PHONE");
      } else {
        phones.set(payload.phone, sourceId);
      }
      const email = String(payload.email || "").trim().toLowerCase();
      if (email) {
        const emailOwner = emails.get(email);
        if (emailOwner && emailOwner !== sourceId) {
          invalid.set(emailOwner, "USER_DUPLICATE_EMAIL");
          invalid.set(sourceId, "USER_DUPLICATE_EMAIL");
        } else {
          emails.set(email, sourceId);
        }
      }
    }
  }
  ledger.summary.preflight ||= {};
  ledger.summary.preflight.userQuarantineCount = invalid.size;
  ledger.persist();

  for await (const page of source.customers()) {
    if (page.page <= resumePage) continue;
    await mapPool(page.rows, concurrency, async (customer) => {
      const sourceId = String(customer.id || "");
      ledger.count("users", "source");
      if (invalid.has(sourceId)) {
        ledger.failure("users", sourceId, invalid.get(sourceId));
        return;
      }
      try {
        const payload = T.customerPayload(customer);
        ledger.count("users", "eligible");
        const result = await destination.upsertUser(payload);
        ledger.count("users", result.mode === "created" ? "inserted" : "updated");
      } catch (error) {
        ledger.failure("users", sourceId, error?.payload?.error || error.message);
      }
    });
    ledger.checkpoint("users", { page: page.page });
  }
}

async function runWallets(source, destination, ledger, resumePage, concurrency = 8) {
  for await (const page of source.walletUsers()) {
    if (page.page <= resumePage) continue;
    await mapPool(page.rows, concurrency, async (walletUser) => {
      const sourceId = String(walletUser.id || "");
      ledger.count("wallets", "source");
      try {
        const payload = T.walletPayload(walletUser);
        ledger.count("wallets", "eligible");
        const result = await destination.upsertWallet(payload);
        ledger.count("wallets", result.mode === "created" ? "inserted" : "updated");
      } catch (error) {
        const code = error?.payload?.error || error.message;
        if (code === "WALLET_USER_NOT_FOUND") ledger.count("wallets", "skipped");
        else ledger.failure("wallets", sourceId, code);
      }
    });
    ledger.checkpoint("wallets", { page: page.page });
  }
}

async function runBlogs(source, destination, ledger, resumePage) {
  const indexes = await loadBlogDestinationIndexes(destination);
  for await (const page of source.posts()) {
    if (page.page <= resumePage) continue;
    for (const post of page.rows) {
      await upsertPilotBlog(source, destination, indexes, ledger, post.id);
    }
    ledger.checkpoint("blogPosts", { page: page.page });
  }
}

async function runOrders(
  source,
  destination,
  ledger,
  resumePage,
  approvedGuestPhones,
  concurrency = 8,
  quarantinedOrderIds = new Set(),
) {
  for await (const page of source.orders()) {
    if (page.page <= resumePage) continue;
    await mapPool(page.rows, concurrency, async (order) => {
      const sourceId = String(order.id || "");
      ledger.count("orders", "source");
      if (quarantinedOrderIds.has(sourceId)) {
        ledger.count("orders", "skipped");
        ledger.issue("orders", sourceId, "CATALOG_DEPENDENCY_QUARANTINED");
        return;
      }
      try {
        const payload = T.orderPayload(order);
        if (payload.guestPhone && !approvedGuestPhones.has(payload.guestPhone)) {
          payload.guestPhone = null;
        }
        ledger.count("orders", "eligible");
        const result = await destination.upsertOrder(payload);
        ledger.count("orders", result.mode === "created" ? "inserted" : "updated");
        ledger.count("orderItems", "inserted", Number(result.itemsCreated || 0));
        ledger.count("orderItems", "updated", Number(result.itemsUpdated || 0));
        ledger.count("orderItems", "skipped", Number(result.itemsDeleted || 0));
      } catch (error) {
        ledger.failure("orders", sourceId, error?.payload?.error || error.message);
      }
    });
    ledger.checkpoint("orders", { page: page.page });
  }
}

function checkpointPage(ledger, entity) {
  return Number(ledger.summary.checkpoints?.[entity]?.page || 0);
}

async function runFull({ config, source, destination, ledger, resume = false }) {
  const entityConcurrency = Number(process.env.IMPORT_CONCURRENCY_ENTITIES || 8);
  if (!Number.isInteger(entityConcurrency) || entityConcurrency < 1 || entityConcurrency > 32) {
    throw new Error("IMPORT_CONCURRENCY_ENTITIES must be an integer between 1 and 32");
  }
  let catalogRun;
  if (!ledger.summary.checkpoints?.catalog?.completed) {
    catalogRun = await runCatalogFull(config, ledger, resume);
  } else {
    const { runStore } = catalogTracking(config);
    const catalogRunId = ledger.summary.checkpoints.catalog.runId || `${ledger.runId}-catalog`;
    catalogRun = runStore.getRun(catalogRunId);
    if (!acceptedCatalogState(catalogRun)) {
      throw new Error(`CATALOG_CHECKPOINT_STATE_INVALID:${catalogRun.status}`);
    }
  }
  const acceptedManifest = catalogRun?.acceptedExceptions || null;
  if (acceptedManifest) {
    ledger.summary.catalogExceptions = acceptedManifest;
    ledger.persist();
  }
  await runUsers(source, destination, ledger, checkpointPage(ledger, "users"), entityConcurrency);
  await runWallets(source, destination, ledger, checkpointPage(ledger, "wallets"), entityConcurrency);
  await runBlogs(source, destination, ledger, checkpointPage(ledger, "blogPosts"));
  const approvedGuestPhones = await loadApprovedGuestPhones(destination);
  await runOrders(
    source,
    destination,
    ledger,
    checkpointPage(ledger, "orders"),
    approvedGuestPhones,
    entityConcurrency,
    new Set((acceptedManifest?.dependentOrderIds || []).map(String)),
  );
  ledger.summary.metrics.source = source.metrics();
  ledger.summary.metrics.destination = destination.metrics();
  ledger.persist();
  return ledger.summary;
}

module.exports = {
  runFull,
  runCatalogFull,
  runOrders,
  mapPool,
  acceptedCatalogState,
  catalogCheckpoint,
};
