"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CatalogRunStore } = require("../lib/runStore");
const { MediaMappingStore } = require("../lib/mediaMappingStore");
const { auditLegacyMedia } = require("../lib/mediaRecovery");
const { mapPoolOrdered, boundedInteger } = require("../lib/concurrency");

test("legacy media recovery seeds only ordered, prefix-matched attachments and quarantines misses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-recovery-"));
  const runId = "legacy-media";
  const run = {
    version: 1,
    id: runId,
    command: "sync:full",
    environment: "production",
    status: "resumable",
    options: { scope: "full" },
    totals: { totalItems: 2, processedItems: 2, skippedItems: 0, failedItems: 0 },
    failures: [],
    checkpoints: {},
    items: {
      "product:1": { key: "product:1", entity: "products", wcId: 1, status: "completed" },
      "product:2": { key: "product:2", entity: "products", wcId: 2, status: "completed" },
    },
  };
  const runStore = new CatalogRunStore(dir);
  runStore.ensure();
  fs.writeFileSync(runStore.runPath(runId), JSON.stringify(run));
  let sourceScans = 0;
  const woo = {
    async *iterateProducts(options) {
      sourceScans += 1;
      assert.deepEqual(options, { perPage: 100, params: { _fields: "id,images" } });
      for (const id of [1, 2, 999]) {
        yield { id, images: [{ src: `https://cdn.example.com/${id}-cover.jpg` }, { src: `https://cdn.example.com/${id}-gallery.jpg` }] };
      }
    },
  };
  const repo = {
    async buildExternalIndex() {
      return new Map([
        ["1", { id: 101, attributes: {
          CoverImage: { data: { id: 11, attributes: { name: "product-1-cover-123-a.jpg", mime: "image/jpeg" } } },
          Media: { data: [{ id: 12, attributes: { name: "product-1-gallery-1-123-b.jpg", mime: "image/jpeg" } }] },
        } }],
        ["2", { id: 102, attributes: {
          CoverImage: { data: { id: 21, attributes: { name: "unrelated.jpg", mime: "image/jpeg" } } },
          Media: { data: [] },
        } }],
      ]);
    },
  };
  const mediaStore = new MediaMappingStore(dir);
  const preview = await auditLegacyMedia({ runStore, runId, woo, repo, mediaStore, dryRun: true });
  assert.equal(preview.unambiguousMappings, 2);
  assert.equal(preview.quarantined, 2);
  assert.equal(preview.sourceProductsScanned, 3);
  assert.equal(mediaStore.size("media"), 0);

  const confirmed = await auditLegacyMedia({
    runStore, runId, woo, repo, mediaStore, dryRun: false, confirm: "CatalogMediaRecovery",
  });
  assert.equal(confirmed.unambiguousMappings, 2);
  assert.equal(sourceScans, 2);
  assert.equal(new MediaMappingStore(dir).size("media"), 2);
  const quarantine = fs.readFileSync(path.join(mediaStore.dir, "recovery-quarantine.ndjson"), "utf8");
  assert.doesNotMatch(quarantine, /cdn\.example\.com/);
});

test("bounded concurrency validates caps and stops starting work after backpressure failure", async () => {
  assert.equal(boundedInteger(undefined, { name: "images", defaultValue: 4, max: 16 }), 4);
  assert.throws(() => boundedInteger(17, { name: "images", defaultValue: 4, max: 16 }), /between 1 and 16/);
  let checks = 0;
  let starts = 0;
  await assert.rejects(() => mapPoolOrdered([1, 2, 3, 4], 1, async () => {
    starts += 1;
  }, {
    canStart: async () => {
      checks += 1;
      if (checks === 3) throw new Error("paused");
    },
  }), /paused/);
  assert.equal(starts, 2);
});
