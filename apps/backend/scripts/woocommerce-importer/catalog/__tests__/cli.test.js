"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyTrackingDir, parseCliArgs, usage } = require("../cli");

test("dependency-free catalog CLI parses resume safety controls on Node 20", () => {
  const parsed = parseCliArgs([
    "resume", "catalog-run", "--tracking-dir", "/state", "--retry-failed", "--pause-signal-path", "/pause",
  ]);
  assert.equal(parsed.command, "resume");
  assert.equal(parsed.runId, "catalog-run");
  assert.equal(parsed.options.trackingDir, "/state");
  assert.equal(parsed.options.retryFailed, true);
  assert.equal(parsed.options.pauseSignalPath, "/pause");
});

test("dependency-free catalog CLI parses exception acceptance and rejects missing run ids", () => {
  const parsed = parseCliArgs([
    "accept-exceptions", "catalog-run", "--manifest", "/audit.json", "--confirm", "CatalogExceptionsAccepted",
  ]);
  assert.equal(parsed.options.manifest, "/audit.json");
  assert.equal(parsed.options.confirm, "CatalogExceptionsAccepted");
  assert.throws(() => parseCliArgs(["exceptions"]), /requires <runId>/);
  assert.match(usage(), /accept-exceptions/);
});

test("tracking directory applies to first-run and resumable importer state", () => {
  const config = {
    duplicateTracking: { storageDir: "old-duplicates" },
    catalog: { trackingDirAbs: "old-runs" },
  };
  applyTrackingDir(config, "tmp/category-seo-state");
  const expected = require("node:path").resolve(process.cwd(), "tmp/category-seo-state");
  assert.equal(config.duplicateTracking.storageDir, expected);
  assert.equal(config.catalog.trackingDirAbs, expected);
});
