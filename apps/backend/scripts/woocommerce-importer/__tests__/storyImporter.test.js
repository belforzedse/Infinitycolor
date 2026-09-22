"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const StoryImporter = require("../importers/StoryImporter");

function importerHarness() {
  const messages = [];
  const importer = Object.create(StoryImporter.prototype);
  importer.logger = {
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    success: (message) => messages.push(message),
  };
  importer.stats = { created: 0, updated: 0, skipped: 0, failed: 0, deactivated: 0 };
  return { importer, messages };
}

const group = {
  wpStoryId: 77,
  slug: "wp-group-77",
  title: "circle",
  thumbnailUrl: "https://source/cover.webp",
  sortOrder: 1,
  items: [
    { key: "wp:77:0", itemIndex: 0, mediaType: "image", mediaUrl: "https://source/one.webp", durationMs: 3000 },
    { key: "wp:77:1", itemIndex: 1, mediaType: "video", mediaUrl: "https://source/two.mov", durationMs: 4000, ctaUrl: "/pdp/two" },
  ],
};

test("grouped import reports and skips active flattened rows without explicit deactivation", async () => {
  const { importer, messages } = importerHarness();
  importer.findStoryBySlug = async () => null;
  importer.findActiveLegacyStories = async () => [{ id: 1, Slug: "wp-77-0" }, { id: 2, Slug: "wp-77-1" }];
  const result = await importer.importGroup(group, { dryRun: false, deactivateExisting: false });
  assert.equal(result, false);
  assert.equal(importer.stats.skipped, 1);
  assert.match(messages.join("\n"), /wp-77-0/);
  assert.match(messages.join("\n"), /--deactivate-existing/);
});

test("grouped import verifies ordered keys before deactivating legacy rows", async () => {
  const { importer } = importerHarness();
  const legacy = [{ id: 1, Slug: "wp-77-0" }, { id: 2, Slug: "wp-77-1" }];
  importer.findActiveLegacyStories = async () => legacy;
  let reads = 0;
  importer.findStoryBySlug = async (_slug, populate) => {
    reads += 1;
    return populate ? { id: 10, Items: group.items.map((item) => ({ Key: item.key })) } : null;
  };
  let uploadId = 100;
  importer.imageUploader = { downloadAndUploadMedia: async () => ({ id: uploadId++ }) };
  const writes = [];
  importer.strapiClient = {
    create: async (_endpoint, data) => { writes.push(["create", data]); return { id: 10 }; },
    update: async (_endpoint, id, data) => { writes.push(["update", id, data]); return { id }; },
  };

  const result = await importer.importGroup(group, { dryRun: false, deactivateExisting: true });
  assert.equal(result, true);
  assert.equal(reads, 2);
  assert.deepEqual(writes[0][1].Items.map((item) => item.Key), ["wp:77:0", "wp:77:1"]);
  assert.deepEqual(writes.slice(1), [
    ["update", 1, { IsActive: false }],
    ["update", 2, { IsActive: false }],
  ]);
  assert.equal(importer.stats.created, 1);
  assert.equal(importer.stats.deactivated, 2);
});
