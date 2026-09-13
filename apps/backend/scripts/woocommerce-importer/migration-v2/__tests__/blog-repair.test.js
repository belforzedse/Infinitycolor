"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, run } = require("../blog-repair");

const FIXTURE = fs.readFileSync(
  path.join(__dirname, "fixtures", "blog-post-rendered.html"),
  "utf8",
);

function harness({ storedContent = "<p>قدیمی</p>" } = {}) {
  const uploads = [];
  const writes = [];
  const source = {
    async getPost(id) {
      return { id: Number(id), slug: "wheat-skin", content: { raw: "[cyn_product_cat_temp]", rendered: "" } };
    },
    async getPostView() {
      return { content: { rendered: FIXTURE } };
    },
    async *posts() {
      yield { page: 1, rows: [{ id: 918313, slug: "wheat-skin", content: { raw: "", rendered: "" } }] };
    },
  };
  const destination = {
    async loadSnapshot(entity) {
      if (entity === "blogPosts") {
        return [{ id: 55, attributes: { Slug: "wheat-skin", Content: storedContent } }];
      }
      if (entity === "productCategories") {
        return [{ id: 3, attributes: { Slug: "coat-and-mantle" } }];
      }
      return [];
    },
    async uploadBlogMedia(url) {
      uploads.push(url);
      return { id: 77, url: "/uploads/blog-temp-pic1.png", bytes: 10 };
    },
    async contentUpsert(endpoint, id, data) {
      writes.push({ endpoint, id, data });
      return { id, mode: "updated" };
    },
  };
  return { source, destination, uploads, writes };
}

test("parseArgs demands exactly one mode and exactly one selection", () => {
  assert.throws(() => parseArgs(["--all"]), /exactly one of --dry-run or --apply/);
  assert.throws(() => parseArgs(["--dry-run", "--apply", "--all"]), /exactly one of --dry-run or --apply/);
  assert.throws(() => parseArgs(["--dry-run"]), /--all, --ids or --slugs/);
  assert.throws(() => parseArgs(["--dry-run", "--all", "--slugs", "a"]), /--all, --ids or --slugs/);
  assert.throws(() => parseArgs(["--dry-run", "--ids", "abc"]), /numeric WordPress post ids/);
  assert.throws(() => parseArgs(["--apply", "--all", "--concurrency", "9"]), /between 1 and 8/);
  assert.deepEqual(parseArgs(["--dry-run", "--slugs", "a, b"]).slugs, ["a", "b"]);
});

test("a dry run writes nothing, uploads nothing, and reports what it would change", async () => {
  const { source, destination, uploads, writes } = harness();
  const report = await run({
    source,
    destination,
    options: parseArgs(["--dry-run", "--ids", "918313"]),
  });
  assert.equal(report.mode, "dry-run");
  assert.equal(report.examined, 1);
  assert.equal(report.changed, 1);
  assert.equal(report.withCarousels, 1);
  assert.equal(report.withPromos, 1);
  assert.deepEqual(writes, [], "a dry run never writes");
  assert.deepEqual(uploads, [], "a dry run never uploads media");
  // The promo is recognised but has no destination image yet, so the post is
  // reported unresolved instead of being given a WordPress hotlink.
  assert.equal(report.diagnostics.PROMO_IMAGE_PENDING, 1);
  assert.equal(report.imagesPending, 1);
  assert.equal(report.unresolved, 1);
  assert.equal(report.samples[0].products, 3);
});

test("an apply uploads the illustration once and rewrites only the body", async () => {
  const { source, destination, uploads, writes } = harness();
  const report = await run({
    source,
    destination,
    options: parseArgs(["--apply", "--ids", "918313"]),
  });
  assert.equal(report.changed, 1);
  assert.equal(report.unresolved, 0);
  assert.equal(uploads.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].endpoint, "/blog-posts");
  assert.equal(writes[0].id, 55);
  assert.deepEqual(Object.keys(writes[0].data), ["Content"], "only the body is written");
  assert.match(writes[0].data.Content, /\[products:"bokato-n0016-jeans"/);
  assert.match(writes[0].data.Content, /"href":"\/plp\/category\/coat-and-mantle"/);
  assert.match(writes[0].data.Content, /"url":"\/uploads\/blog-temp-pic1\.png"/);
  assert.ok(!writes[0].data.Content.includes("infinitycolor.co/wp-content"));
});

test("a post already carrying the repaired body is left alone", async () => {
  const first = harness();
  await run({ source: first.source, destination: first.destination, options: parseArgs(["--apply", "--ids", "918313"]) });
  const repaired = first.writes[0].data.Content;

  const second = harness({ storedContent: repaired });
  const report = await run({
    source: second.source,
    destination: second.destination,
    options: parseArgs(["--apply", "--ids", "918313"]),
  });
  assert.equal(report.unchanged, 1);
  assert.equal(report.changed, 0);
  assert.deepEqual(second.writes, [], "an idempotent rerun writes nothing");
});

test("a post WordPress has but Infinity does not is reported, not created", async () => {
  const { source, destination, writes } = harness();
  destination.loadSnapshot = async (entity) => (entity === "productCategories"
    ? [{ id: 3, attributes: { Slug: "coat-and-mantle" } }]
    : []);
  const report = await run({
    source,
    destination,
    options: parseArgs(["--apply", "--ids", "918313"]),
  });
  assert.equal(report.notInDestination, 1);
  assert.equal(report.changed, 0);
  assert.deepEqual(writes, []);
});
