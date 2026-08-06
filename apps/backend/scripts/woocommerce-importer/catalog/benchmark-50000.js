#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { CatalogRunStore, projectionDigest } = require("./lib/runStore");

function ioWriteBytes() {
  try {
    const row = fs.readFileSync("/proc/self/io", "utf8").split("\n").find((line) => line.startsWith("write_bytes:"));
    return Number(row?.split(":")[1].trim() || 0);
  } catch {
    return null;
  }
}

function parseItems(argv) {
  const position = argv.indexOf("--items");
  const value = position >= 0 ? Number(argv[position + 1]) : 50_000;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--items must be a positive integer");
  return value;
}

function expireLease(store, runId) {
  const control = store.readControl(runId);
  control.lock.heartbeatAt = "2000-01-01T00:00:00.000Z";
  store.writeControl(runId, control);
}

const itemCount = parseItems(process.argv.slice(2));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-benchmark-"));
const runId = `benchmark-${itemCount}`;
const startedAt = Date.now();
const writeBefore = ioWriteBytes();
let logicalStateWriteBytes = 0;
const trackedFds = new Set();
const originalOpenSync = fs.openSync;
const originalCloseSync = fs.closeSync;
const originalWriteSync = fs.writeSync;
const originalWriteFileSync = fs.writeFileSync;
fs.openSync = (target, ...args) => {
  const fd = originalOpenSync(target, ...args);
  if (typeof target !== "number" && path.resolve(String(target)).startsWith(`${stateDir}${path.sep}`)) trackedFds.add(fd);
  return fd;
};
fs.closeSync = (fd) => {
  trackedFds.delete(fd);
  return originalCloseSync(fd);
};
fs.writeSync = (fd, data, ...args) => {
  const written = originalWriteSync(fd, data, ...args);
  if (trackedFds.has(fd)) logicalStateWriteBytes += written;
  return written;
};
fs.writeFileSync = (target, data, ...args) => {
  const tracked = typeof target === "number"
    ? trackedFds.has(target)
    : path.resolve(String(target)).startsWith(`${stateDir}${path.sep}`);
  const result = originalWriteFileSync(target, data, ...args);
  if (tracked) logicalStateWriteBytes += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
  return result;
};
const destinationExternalIds = new Set();
let duplicateDestinationWrites = 0;
const productCount = Math.ceil(itemCount / 2);

function itemKeysForProduct(index) {
  const productKey = `product:${index}`;
  const variationOrdinal = productCount + index;
  return variationOrdinal <= itemCount
    ? [productKey, `variation:${index}`]
    : [productKey];
}

function recordDestinationWrite(key) {
  if (destinationExternalIds.has(key)) duplicateDestinationWrites += 1;
  destinationExternalIds.add(key);
}

function processProductBoundary(activeStore, activeToken, index) {
  const [productKey, variationKey] = itemKeysForProduct(index);
  activeStore.beginItem(runId, productKey, { entity: "products", wcId: index, stage: "upsert-product" }, activeToken);
  recordDestinationWrite(productKey);
  if (variationKey) {
    activeStore.beginItem(runId, variationKey, { entity: "variations", wcId: index, stage: "upsert-variation" }, activeToken);
    recordDestinationWrite(variationKey);
    activeStore.completeItem(runId, variationKey, { strapiId: index, externalId: String(index) }, activeToken);
  }
  activeStore.completeItem(runId, productKey, { strapiId: index, externalId: String(index) }, activeToken);
  activeStore.syncBoundary(runId, activeToken);
}

let store = new CatalogRunStore(stateDir, { lockStaleMs: 1 });
store.createRun({
  runId,
  command: "benchmark",
  environment: "test",
  strapiBaseUrl: "https://destination.invalid/api",
  options: { scope: "full", dryRun: false, limit: itemCount },
});
let token = store.acquireLock(runId);
const crashAtProduct = Math.floor(productCount / 2);
const crashAtItems = Array.from({ length: crashAtProduct }, (_, index) => itemKeysForProduct(index + 1).length)
  .reduce((sum, count) => sum + count, 0);

for (let index = 1; index <= crashAtProduct; index += 1) processProductBoundary(store, token, index);

store.close(runId);
expireLease(store, runId);
store = new CatalogRunStore(stateDir, { lockStaleMs: 1 });
const recoveredAtCrash = store.getRun(runId);
assert.equal(recoveredAtCrash.totals.processedItems, crashAtItems);
token = store.acquireLock(runId);
let replaySkipped = 0;

for (let index = 1; index <= productCount; index += 1) {
  const keys = itemKeysForProduct(index);
  if (keys.every((key) => store.shouldSkipItem(runId, key, { retryFailed: true }))) {
    replaySkipped += keys.length;
    continue;
  }
  processProductBoundary(store, token, index);
}
store.setStatus(runId, "completed", { currentStep: "completed" }, token);
store.releaseLock(runId, token);
store.close(runId);

async function runRepresentativeMediaFixture() {
  sharp.cache({ memory: 64, files: 0, items: 100 });
  sharp.concurrency(2);
  const outputs = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const input = await sharp({
      create: {
        width: 3072,
        height: 3072,
        channels: 4,
        background: { r: 30 + index, g: 80 + index, b: 130 + index, alpha: 1 },
      },
    }).png().toBuffer();
    const output = await sharp(input).webp({ quality: 85 }).toBuffer();
    return { inputBytes: input.length, outputBytes: output.length };
  }));
  return {
    concurrency: 4,
    inputBytes: outputs.reduce((sum, row) => sum + row.inputBytes, 0),
    outputBytes: outputs.reduce((sum, row) => sum + row.outputBytes, 0),
    sharpCounters: sharp.counters(),
  };
}

async function finish() {
  const mediaFixture = await runRepresentativeMediaFixture();
  const finalProjection = new CatalogRunStore(stateDir).getRun(runId);
  const finalDigest = projectionDigest(finalProjection);
  const recoveredDigest = projectionDigest(new CatalogRunStore(stateDir).getRun(runId));
  const writeAfter = ioWriteBytes();
  const writtenBytes = writeBefore === null || writeAfter === null ? null : writeAfter - writeBefore;
  const peakRssBytes = process.resourceUsage().maxRSS * 1024;
  const result = {
    fixtureItems: itemCount,
    fixtureProducts: productCount,
    elapsedMs: Date.now() - startedAt,
    stateStoreWriteBytes: writtenBytes,
    logicalStateStoreWriteBytes: logicalStateWriteBytes,
    stateDirectoryBytes: fs.readdirSync(stateDir, { recursive: true })
      .map((entry) => path.join(stateDir, entry))
      .filter((entry) => fs.statSync(entry).isFile())
      .reduce((sum, entry) => sum + fs.statSync(entry).size, 0),
    peakRssBytes,
    mediaFixture,
    replaySkipped,
    completedItems: finalProjection.totals.processedItems,
    failures: finalProjection.failures.length,
    duplicateDestinationExternalIds: duplicateDestinationWrites,
    projectionSha256: finalDigest,
    recoveryProjectionSha256: recoveredDigest,
  };

  console.log(JSON.stringify(result, null, 2));
  assert.equal(finalProjection.totals.processedItems, itemCount, "no records missed");
  assert.equal(destinationExternalIds.size, itemCount, "every destination external id exists exactly once");
  assert.equal(duplicateDestinationWrites, 0, "completed items were not written again after restart");
  assert.equal(finalDigest, recoveredDigest, "recovered projection is identical");
  assert.ok(peakRssBytes < 4 * 1024 * 1024 * 1024, "peak RSS must remain below 4 GiB");
  assert.ok(logicalStateWriteBytes < 500 * 1024 * 1024, "logical state-store writes must remain below 500 MB");
  if (writtenBytes !== null && writtenBytes > 0) assert.ok(writtenBytes < 500 * 1024 * 1024, "state-store block writes must remain below 500 MB");
}

finish().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
