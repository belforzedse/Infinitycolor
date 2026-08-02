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

async function runCatalogFull(config, ledger, resume) {
  const trackingDir = path.join(config.stateDir, "catalog");
  fs.mkdirSync(trackingDir, { recursive: true, mode: 0o700 });
  const { config: catalogConfig } = buildConfig("production");
  catalogConfig.duplicateTracking.storageDir = trackingDir;
  catalogConfig.catalog.trackingDirAbs = trackingDir;
  const logger = new Logger({ ...catalogConfig.logging, level: "info" });
  const engine = new CatalogEngine(catalogConfig, logger, { environment: "production" });
  const runStore = new CatalogRunStore(trackingDir);
  const catalogRunId = `${ledger.runId}-catalog`;
  const canResumeCatalog = resume && fs.existsSync(runStore.runPath(catalogRunId));
  if (canResumeCatalog && runStore.getRun(catalogRunId).status === "completed") {
    ledger.checkpoint("catalog", { runId: catalogRunId, completed: true });
    return;
  }
  const report = await engine.runSync({
    runStore,
    runId: catalogRunId,
    ...(canResumeCatalog ? { resume: true, retryFailed: true } : {}),
    dryRun: false,
    scope: "full",
  });
  ledger.summary.catalogFull = report.toJSON();
  ledger.checkpoint("catalog", { runId: catalogRunId, completed: !report.hasFailures() });
  if (report.hasFailures()) throw new Error("CATALOG_FULL_HAS_FAILURES");
}

async function runUsers(source, destination, ledger, resumePage) {
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
    await mapPool(page.rows, 2, async (customer) => {
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

async function runWallets(source, destination, ledger, resumePage) {
  for await (const page of source.walletUsers()) {
    if (page.page <= resumePage) continue;
    await mapPool(page.rows, 2, async (walletUser) => {
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

async function runOrders(source, destination, ledger, resumePage, approvedGuestPhones) {
  for await (const page of source.orders()) {
    if (page.page <= resumePage) continue;
    await mapPool(page.rows, 2, async (order) => {
      const sourceId = String(order.id || "");
      ledger.count("orders", "source");
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
  if (!ledger.summary.checkpoints?.catalog?.completed) await runCatalogFull(config, ledger, resume);
  await runUsers(source, destination, ledger, checkpointPage(ledger, "users"));
  await runWallets(source, destination, ledger, checkpointPage(ledger, "wallets"));
  await runBlogs(source, destination, ledger, checkpointPage(ledger, "blogPosts"));
  const approvedGuestPhones = await loadApprovedGuestPhones(destination);
  await runOrders(
    source,
    destination,
    ledger,
    checkpointPage(ledger, "orders"),
    approvedGuestPhones,
  );
  ledger.summary.metrics.source = source.metrics();
  ledger.summary.metrics.destination = destination.metrics();
  ledger.persist();
  return ledger.summary;
}

module.exports = { runFull, mapPool };
