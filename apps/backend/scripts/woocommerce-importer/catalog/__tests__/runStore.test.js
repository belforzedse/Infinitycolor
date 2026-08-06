"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CatalogRunStore, projectionDigest, conversionProjectionDigest } = require("../lib/runStore");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "catalog-run-store-v2-"));
}

function create(store, id = "run-1") {
  return store.createRun({
    runId: id,
    command: "sync:full",
    environment: "test",
    strapiBaseUrl: "https://destination.example/api",
    options: { scope: "full", dryRun: false, limit: "all" },
  });
}

function legacyRun(id) {
  return {
    version: 1,
    id,
    command: "sync:full",
    environment: "production",
    status: "resumable",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    currentStep: "products",
    options: { scope: "full", dryRun: false, limit: "all" },
    checkpoints: {},
    totals: { totalItems: 3, processedItems: 1, skippedItems: 0, failedItems: 1 },
    failures: [{ key: "variation:2", entity: "variations", wcId: 2, stage: "stock", error: "boom", at: "2026-01-02T00:00:00.000Z" }],
    items: {
      "product:1": { key: "product:1", entity: "products", wcId: 1, status: "completed", attempts: 1 },
      "variation:2": { key: "variation:2", entity: "variations", wcId: 2, parentWcId: 1, status: "failed", attempts: 1 },
      "stock:2": { key: "stock:2", entity: "stocks", wcId: 2, parentWcId: 1, status: "running", attempts: 1 },
    },
    lock: null,
    cancelRequested: false,
    pauseRequested: false,
  };
}

test("legacy conversion is dry-run by default and confirmed conversion replays equivalently", () => {
  const dir = tempDir();
  const store = new CatalogRunStore(dir);
  store.ensure();
  const legacy = legacyRun("legacy-equivalent");
  fs.writeFileSync(store.runPath(legacy.id), JSON.stringify(legacy, null, 2));

  const preview = store.convertLegacy(legacy.id, { dryRun: true });
  assert.equal(preview.itemCount, 3);
  assert.equal(fs.existsSync(store.snapshotPath(legacy.id)), false);

  const converted = store.convertLegacy(legacy.id, { dryRun: false, confirm: "CatalogStateV2" });
  assert.equal(converted.equivalent, true);
  assert.equal(fs.existsSync(store.runPath(legacy.id)), true, "legacy file remains untouched");
  const replayed = new CatalogRunStore(dir).getRun(legacy.id);
  assert.equal(projectionDigest(replayed), projectionDigest(legacy));
  assert.deepEqual(replayed.totals, legacy.totals);
  assert.deepEqual(replayed.failures, legacy.failures);
  const runsOwner = fs.statSync(store.runsDir);
  const snapshotOwner = fs.statSync(store.snapshotPath(legacy.id));
  assert.deepEqual([snapshotOwner.uid, snapshotOwner.gid], [runsOwner.uid, runsOwner.gid]);

  const existingPreview = new CatalogRunStore(dir).convertLegacy(legacy.id, { dryRun: true });
  assert.equal(existingPreview.existingV2, true);
  assert.equal(existingPreview.conversionEquivalent, true);
  assert.equal(existingPreview.replayValid, true);
  assert.equal(existingPreview.advancedSinceConversion, false);
  assert.throws(
    () => new CatalogRunStore(dir).convertLegacy(legacy.id, { dryRun: false, confirm: "CatalogStateV2" }),
    /refusing to overwrite/,
  );

  const legacyFormatSnapshot = JSON.parse(fs.readFileSync(store.snapshotPath(legacy.id), "utf8"));
  delete legacyFormatSnapshot.conversion.projectionDigestVersion;
  legacyFormatSnapshot.conversion.projectionSha256 = conversionProjectionDigest(legacy, 1);
  fs.writeFileSync(store.snapshotPath(legacy.id), JSON.stringify(legacyFormatSnapshot));
  const legacyFormatPreview = new CatalogRunStore(dir).convertLegacy(legacy.id, { dryRun: true });
  assert.equal(legacyFormatPreview.conversionEquivalent, true);
  assert.equal(legacyFormatPreview.replayValid, true);
});

test("dual-format state fails closed when the immutable legacy hash changes", () => {
  const dir = tempDir();
  const store = new CatalogRunStore(dir);
  store.ensure();
  const legacy = legacyRun("legacy-hash");
  fs.writeFileSync(store.runPath(legacy.id), JSON.stringify(legacy));
  store.convertLegacy(legacy.id, { dryRun: false, confirm: "CatalogStateV2" });
  fs.appendFileSync(store.runPath(legacy.id), " ");
  assert.throws(() => new CatalogRunStore(dir).getRun(legacy.id), /hash changed/);
});

test("replay ignores only an invalid truncated final record", () => {
  const dir = tempDir();
  const store = new CatalogRunStore(dir);
  create(store, "truncated-final");
  const token = store.acquireLock("truncated-final");
  store.beginItem("truncated-final", "product:1", { entity: "products", wcId: 1 }, token);
  store.syncNow("truncated-final", token);
  fs.appendFileSync(store.eventsPath("truncated-final"), '{"version":2,"sequence":');
  const replayed = new CatalogRunStore(dir).getRun("truncated-final");
  assert.equal(replayed.items["product:1"].status, "running");
});

test("corruption before the final line and journal sequence gaps are fatal", () => {
  const dir = tempDir();
  const store = new CatalogRunStore(dir);
  create(store, "sequence-gap");
  const token = store.acquireLock("sequence-gap");
  store.beginItem("sequence-gap", "product:1", { entity: "products", wcId: 1 }, token);
  store.completeItem("sequence-gap", "product:1", {}, token);
  store.syncNow("sequence-gap", token);
  const lines = fs.readFileSync(store.eventsPath("sequence-gap"), "utf8").trim().split("\n");
  const last = JSON.parse(lines.at(-1));
  last.sequence += 1;
  lines[lines.length - 1] = JSON.stringify(last);
  fs.writeFileSync(store.eventsPath("sequence-gap"), `${lines.join("\n")}\n`);
  assert.throws(() => new CatalogRunStore(dir).getRun("sequence-gap"), /sequence gap/);

  lines[0] = "not-json";
  fs.writeFileSync(store.eventsPath("sequence-gap"), `${lines.join("\n")}\n`);
  assert.throws(() => new CatalogRunStore(dir).getRun("sequence-gap"), /Corrupt catalog journal/);
});

test("replay tolerates compaction interruption with pre-snapshot journal records", () => {
  const dir = tempDir();
  const store = new CatalogRunStore(dir);
  create(store, "compact-interrupt");
  const token = store.acquireLock("compact-interrupt");
  store.beginItem("compact-interrupt", "product:1", { entity: "products", wcId: 1 }, token);
  store.compact("compact-interrupt", token);
  const snapshot = JSON.parse(fs.readFileSync(store.snapshotPath("compact-interrupt"), "utf8"));
  const duplicate = {
    version: 2, sequence: snapshot.sequence, runId: "compact-interrupt", operation: "run-update",
    itemKey: null, status: "running", detail: { patch: {} }, timestamp: new Date().toISOString(), fencingToken: token,
  };
  const next = {
    version: 2, sequence: snapshot.sequence + 1, runId: "compact-interrupt", operation: "item-transition",
    itemKey: "product:1", status: "completed", detail: { item: { ...snapshot.run.items["product:1"], status: "completed" } },
    timestamp: new Date().toISOString(), fencingToken: token,
  };
  fs.writeFileSync(store.eventsPath("compact-interrupt"), `${JSON.stringify(duplicate)}\n${JSON.stringify(next)}\n`);
  const replayed = new CatalogRunStore(dir).getRun("compact-interrupt");
  assert.equal(replayed.items["product:1"].status, "completed");
});

test("fencing rejects missing, wrong, and superseded lease tokens", () => {
  const dir = tempDir();
  const store = new CatalogRunStore(dir, { lockStaleMs: 1 });
  create(store, "fencing");
  const first = store.acquireLock("fencing");
  assert.throws(() => store.beginItem("fencing", "product:1", {}), /lease is not owned/);
  assert.throws(() => store.beginItem("fencing", "product:1", {}, "wrong"), /lease is not owned/);
  const control = store.readControl("fencing");
  control.lock.heartbeatAt = "2000-01-01T00:00:00.000Z";
  store.writeControl("fencing", control);
  const second = store.acquireLock("fencing");
  assert.notEqual(first, second);
  assert.throws(() => store.completeItem("fencing", "product:1", {}, first), /lease is not owned/);
  store.beginItem("fencing", "product:1", {}, second);
  store.releaseLock("fencing", second);
  assert.throws(() => store.completeItem("fencing", "product:1", {}, second), /lease is not owned/);
});

test("pause and cancel controls are durable and do not rewrite the snapshot", () => {
  const dir = tempDir();
  const store = new CatalogRunStore(dir);
  create(store, "controls");
  const snapshotBefore = fs.readFileSync(store.snapshotPath("controls"));
  store.requestPause("controls");
  assert.equal(new CatalogRunStore(dir).getRun("controls").pauseRequested, true);
  store.requestCancel("controls");
  assert.equal(new CatalogRunStore(dir).getRun("controls").cancelRequested, true);
  assert.deepEqual(fs.readFileSync(store.snapshotPath("controls")), snapshotBefore);
});

test("failure history survives retries and terminal compaction", () => {
  const dir = tempDir();
  const store = new CatalogRunStore(dir);
  create(store, "failures");
  const token = store.acquireLock("failures");
  store.beginItem("failures", "variation:4", { entity: "variations", wcId: 4 }, token);
  store.failItem("failures", "variation:4", { entity: "variations", wcId: 4, stage: "variation", error: "consumer_secret=hide-me https://source.example/private.jpg" }, token);
  store.beginItem("failures", "variation:4", { entity: "variations", wcId: 4 }, token);
  store.failItem("failures", "variation:4", { entity: "variations", wcId: 4, stage: "stock", error: "Bearer abc.def" }, token);
  store.setStatus("failures", "failed", {}, token);
  const replayed = new CatalogRunStore(dir).getRun("failures");
  assert.equal(replayed.failures.length, 2);
  assert.ok(replayed.failures.every((failure) => !/hide-me|abc\.def|source\.example|private\.jpg/.test(failure.error)));
  assert.match(replayed.failures[0].error, /url-sha256:/);
  assert.equal(fs.statSync(store.eventsPath("failures")).size, 0, "terminal completion compacts the journal");
});

test("product boundary syncs media mappings before fdatasyncing catalog events", () => {
  const dir = tempDir();
  const store = new CatalogRunStore(dir);
  create(store, "boundary");
  const token = store.acquireLock("boundary");
  store.beginItem("boundary", "product:1", { entity: "products", wcId: 1 }, token);
  store.completeItem("boundary", "product:1", {}, token);
  const order = [];
  const original = fs.fdatasyncSync;
  fs.fdatasyncSync = (fd) => { order.push("catalog"); return original(fd); };
  try {
    store.syncBoundary("boundary", token, { mediaStore: { syncBoundary() { order.push("media"); } } });
  } finally {
    fs.fdatasyncSync = original;
  }
  assert.deepEqual(order.slice(0, 2), ["media", "catalog"]);
  const replayed = new CatalogRunStore(dir).getRun("boundary");
  assert.equal(replayed.items["product:1"].status, "completed");
});

test("accepted exception manifests are projection-bound, fail closed, and retain failures", () => {
  const dir = tempDir();
  const store = new CatalogRunStore(dir);
  create(store, "accepted-exceptions");
  const token = store.acquireLock("accepted-exceptions");
  store.beginItem("accepted-exceptions", "variation:9", {
    entity: "variations",
    wcId: 9,
    parentWcId: 4,
  }, token);
  store.failItem("accepted-exceptions", "variation:9", {
    entity: "variations",
    wcId: 9,
    parentWcId: 4,
    stage: "variation",
    error: "VARIATION_PRICE_MISSING",
  }, token);
  store.setStatus("accepted-exceptions", "resumable", {}, token);
  store.releaseLock("accepted-exceptions", token);

  const audit = store.exceptionAudit("accepted-exceptions");
  const baseEntry = {
    ...audit.entries[0],
    sourceRevisionSha256: "a".repeat(64),
    reasonCode: "MISSING_PRICE",
    containment: "variation excluded; parent remains available through valid children",
    impact: "one invalid variation is unavailable",
    retryCondition: "source receives a positive price",
    acceptEligible: true,
  };
  const manifest = {
    runId: audit.runId,
    projectionSha256: audit.projectionSha256,
    approvedBy: "operator",
    approvalReference: "incident-accepted-policy",
    dependencyAuditSha256: "b".repeat(64),
    dependentOrderIds: ["22"],
    entries: [baseEntry],
  };
  assert.throws(
    () => store.acceptExceptions("accepted-exceptions", { ...manifest, projectionSha256: "0".repeat(64) }, {
      confirm: "CatalogExceptionsAccepted",
    }),
    /projection digest mismatch/,
  );
  assert.throws(
    () => store.acceptExceptions("accepted-exceptions", {
      ...manifest,
      entries: [{ ...baseEntry, reasonCode: "UNCLASSIFIED_DESTINATION_400" }],
    }, { confirm: "CatalogExceptionsAccepted" }),
    /fail-closed reason code/,
  );

  const accepted = store.acceptExceptions("accepted-exceptions", manifest, {
    confirm: "CatalogExceptionsAccepted",
  });
  assert.equal(accepted.status, "completed-with-exceptions");
  const replayed = new CatalogRunStore(dir).getRun("accepted-exceptions");
  assert.equal(replayed.status, "completed-with-exceptions");
  assert.equal(replayed.items["variation:9"].status, "failed");
  assert.equal(replayed.failures.length, 1);
  assert.equal(replayed.acceptedExceptions.entries[0].acceptEligible, true);
  assert.deepEqual(replayed.acceptedExceptions.dependentOrderIds, ["22"]);
  assert.equal(fs.statSync(store.eventsPath("accepted-exceptions")).size, 0);
});
