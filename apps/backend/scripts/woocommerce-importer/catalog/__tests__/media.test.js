"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const MappingStore = require("../lib/mapping");
const MediaSync = require("../lib/media");
const ImageUploader = require("../../utils/ImageUploader");

const noopLogger = {
  info() {}, debug() {}, warn() {}, error() {}, success() {},
};

function makeMedia(allowHttp = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-media-"));
  const store = new MappingStore(dir, { fileName: "media.json" });
  const config = { import: { images: { enableUpload: true }, videos: {} } };
  const media = new MediaSync(config, noopLogger, store, { allowHttp });
  // Replace the real uploader (network/sharp) with a counting fake.
  let uploadCount = 0;
  const timestampRestores = [];
  media.uploader = {
    async downloadAndUploadMedia() {
      uploadCount += 1;
      return { id: 42, name: "a.webp", mime: "image/webp" };
    },
    async restoreMediaSourceTimestamps(id, timestamps) {
      timestampRestores.push({ id, timestamps });
    },
  };
  return { media, store, uploads: () => uploadCount, timestampRestores };
}

test("MediaSync.syncUrl: uploads once, then reuses from persistent store", async () => {
  const { media, uploads } = makeMedia();
  const url = "https://cdn.example.com/a.jpg";

  const first = await media.syncUrl(url, "alt", "p-1", true);
  assert.equal(first.status, "uploaded");
  assert.equal(first.id, 42);
  assert.equal(uploads(), 1);

  const second = await media.syncUrl(url, "alt", "p-1", true);
  assert.equal(second.status, "reused");
  assert.equal(second.id, 42);
  assert.equal(uploads(), 1); // NOT re-uploaded on the second run
});

test("MediaSync.syncUrl restores source timestamps when reusing persistent media", async () => {
  const { media, timestampRestores } = makeMedia();
  const url = "https://cdn.example.com/timestamped.jpg";
  const timestamps = {
    createdAt: "2020-01-02T03:04:05.000Z",
    updatedAt: "2024-05-06T07:08:09.000Z",
  };

  await media.syncUrl(url, "alt", "p-1", true, timestamps);
  await media.syncUrl(url, "alt", "p-1", true, timestamps);

  assert.deepEqual(timestampRestores, [{ id: 42, timestamps }]);
});

test("MediaSync.syncUrl: a fresh run reuses ids persisted to disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-media-"));
  const config = { import: { images: { enableUpload: true }, videos: {} } };

  const store1 = new MappingStore(dir, { fileName: "media.json" });
  const m1 = new MediaSync(config, noopLogger, store1);
  m1.uploader = { async downloadAndUploadMedia() { return { id: 7, name: "x", mime: "image/webp" }; } };
  await m1.syncUrl("https://cdn.example.com/x.jpg", "a", "p", false);
  store1.flush();

  const store2 = new MappingStore(dir, { fileName: "media.json" });
  const m2 = new MediaSync(config, noopLogger, store2);
  let called = false;
  m2.uploader = { async downloadAndUploadMedia() { called = true; return { id: 99 }; } };
  const res = await m2.syncUrl("https://cdn.example.com/x.jpg", "a", "p", false);
  assert.equal(res.status, "reused");
  assert.equal(res.id, 7);
  assert.equal(called, false);
});

test("MediaSync.syncUrl: SSRF / unsafe URLs are blocked before download", async () => {
  const { media, uploads } = makeMedia(false);
  const blocked = await media.syncUrl("http://127.0.0.1:6379/x.jpg", "a", "p", false);
  assert.equal(blocked.status, "failed");
  assert.equal(uploads(), 0); // uploader never invoked

  const httpBlocked = await media.syncUrl("http://cdn.example.com/a.jpg", "a", "p", false);
  assert.equal(httpBlocked.status, "failed"); // plain http blocked when allowHttp=false
});

test("concurrent duplicate source URLs coalesce to one in-flight pipeline", async () => {
  const { media, uploads } = makeMedia();
  media.uploader.downloadAndUploadMedia = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Preserve the fixture's upload counter semantics through its wrapper.
    return { id: 42, name: "coalesced.webp", mime: "image/webp" };
  };
  let calls = 0;
  const original = media.uploader.downloadAndUploadMedia;
  media.uploader.downloadAndUploadMedia = async (...args) => { calls += 1; return original(...args); };
  const url = "https://cdn.example.com/coalesced.jpg";
  const results = await Promise.all([
    media.syncUrl(url, "one", "p", false),
    media.syncUrl(url, "two", "p", false),
    media.syncUrl(url, "three", "p", false),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((result) => result.id), [42, 42, 42]);
  assert.equal(uploads(), 0);
});

test("parallel image completion preserves Woo cover and gallery order", async () => {
  const { media } = makeMedia();
  media.imageConcurrency = 4;
  media.syncUrl = async (url) => {
    const id = Number(url.match(/(\d+)\.jpg$/)[1]);
    await new Promise((resolve) => setTimeout(resolve, (5 - id) * 5));
    return { id, mime: "image/webp", status: "uploaded" };
  };
  const result = await media.syncProductMedia({
    id: 90,
    name: "ordered",
    images: [1, 2, 3, 4].map((id) => ({ src: `https://cdn.example.com/${id}.jpg`, alt: String(id) })),
  });
  assert.equal(result.coverId, 1);
  assert.deepEqual(result.galleryIds, [2, 3, 4]);
});

test("deterministic media filenames are stable and an exact destination match is reused", async () => {
  const config = {
    catalog: { allowHttpMedia: false },
    import: { images: { retry: {} }, videos: {} },
    strapi: { baseUrl: "https://destination.example/api", usePublicAccess: true },
  };
  const uploader = new ImageUploader(config, noopLogger);
  const first = uploader.generateFileName("https://CDN.example.com/a.jpg#fragment", "ignored");
  const second = uploader.generateFileName("https://cdn.example.com/a.jpg", "different");
  assert.equal(first, second);
  assert.match(first, /^wc-src-[a-f0-9]{64}\.jpg$/);
  uploader.findExactDestinationFile = async () => ({ id: 77, name: first, mime: "image/jpeg" });
  uploader.uploadToStrapi = async () => { throw new Error("must not upload"); };
  const result = await uploader.uploadToStrapiWithRetry(Buffer.from("x"), first, "alt", 1);
  assert.equal(result.id, 77);
  assert.equal(result._reusedDeterministic, true);
});

test("multiple exact destination filename matches are an explicit ambiguity", async () => {
  const uploader = new ImageUploader({
    catalog: { allowHttpMedia: false },
    import: { images: { retry: {} }, videos: {} },
    strapi: { baseUrl: "https://destination.example/api", usePublicAccess: true },
  }, noopLogger);
  uploader.findExactDestinationFile = async () => {
    const error = new Error("ambiguous");
    error.code = "MEDIA_DESTINATION_AMBIGUOUS";
    throw error;
  };
  await assert.rejects(
    () => uploader.uploadToStrapiWithRetry(Buffer.from("x"), "wc-src-a.webp", "alt", 1),
    /ambiguous/,
  );
});

test("restart after upload before mapping commit reuses the deterministic remote file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-media-crash-"));
  const store = new MappingStore(dir, { fileName: "media.json" });
  const config = { import: { images: { enableUpload: true }, videos: {} } };
  const media = new MediaSync(config, noopLogger, store);
  const remote = { id: 88, name: "wc-src-fixed.webp", mime: "image/webp" };
  media.uploader = { async downloadAndUploadMedia() { return remote; } };
  media.observer = { afterMediaUploadBeforeMappingCommit() { const error = new Error("crash before mapping"); error.code = "CATALOG_SIMULATED_CRASH"; throw error; } };
  const url = "https://cdn.example.com/crash.jpg";
  await assert.rejects(() => media.syncUrl(url, "alt", "p", false), /crash before mapping/);
  assert.equal(store.get("media", url), null);

  media.observer = null;
  media.uploader = { async downloadAndUploadMedia() { return { ...remote, _reusedDeterministic: true }; } };
  const recovered = await media.syncUrl(url, "alt", "p", false);
  assert.equal(recovered.status, "reused");
  assert.equal(recovered.id, 88);
  assert.equal(store.get("media", url).strapiId, 88);
});
