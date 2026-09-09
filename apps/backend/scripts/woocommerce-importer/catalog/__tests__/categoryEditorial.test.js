"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  sourceHasDescription,
  destinationCategoryIndex,
  categoryRouteMap,
  extractAudio,
  transformCategoryEditorial,
  categoryEditorialSourceHash,
  buildCategoryEditorialManifest,
} = require("../lib/categoryEditorial");

function fixture() {
  const categories = [
    {
      id: 10,
      name: "مانتو",
      slug: "manto",
      description:
        '<h1 onclick="bad()">راهنمای مانتو</h1><p>مقدمه صوتی</p>[audio mp3="https://cdn.example.com/guide.mp3"][/audio]<h2>انتخاب</h2><p style="color:red"><a href="https://infinitycolor.co/shop/scarf/">شال</a></p><script>bad()</script>',
    },
    { id: 11, name: "شال", slug: "scarf", description: "<h2>خرید شال</h2>" },
  ];
  const rows = categories.map((category) => ({
    id: 100 + category.id,
    title: category.name,
    slug: category.slug,
    externalId: String(category.id),
    externalSource: "woocommerce",
    editorial: null,
  }));
  const index = destinationCategoryIndex(rows);
  return { categories, index, routes: categoryRouteMap(categories, index) };
}

test("category editorial transform extracts title/audio and rewrites canonical category links", () => {
  const { categories, index, routes } = fixture();
  const plan = transformCategoryEditorial(categories[0], index.get("10"), routes);
  assert.equal(plan.title, "راهنمای مانتو");
  assert.equal(plan.paragraph, "مقدمه صوتی");
  assert.equal(plan.audioUrl, "https://cdn.example.com/guide.mp3");
  assert.equal(plan.rewrittenLinkCount, 1);
  assert.match(plan.content, /<h3>انتخاب<\/h3>/);
  assert.match(plan.content, /href="\/plp\/category\/scarf"/);
  assert.doesNotMatch(plan.content, /script|onclick|style=/i);
});

test("title-only descriptions are legitimate and remain represented", () => {
  const { categories, index, routes } = fixture();
  assert.equal(sourceHasDescription(categories[1]), true);
  const plan = transformCategoryEditorial(categories[1], index.get("11"), routes);
  assert.equal(plan.title, "خرید شال");
  assert.equal(plan.content, "");
  assert.equal(plan.titleOnly, true);
});

test("a legacy plain-text purchase heading becomes the editorial title", () => {
  const { index, routes } = fixture();
  const plan = transformCategoryEditorial(
    {
      id: 10,
      name: "مانتو",
      slug: "manto",
      description: "خرید مانتو و کت\r\nبه فروشگاه پوشاک اینفینیتی خوش آمدید!\r\n\r\nمتن راهنما",
    },
    index.get("10"),
    routes,
  );
  assert.equal(plan.title, "خرید مانتو و کت");
  assert.doesNotMatch(plan.content, /^خرید مانتو/);
  assert.match(plan.content, /به فروشگاه پوشاک اینفینیتی/);
});

test("a generic plain-text opening remains body copy and uses the category title", () => {
  const { index, routes } = fixture();
  const plan = transformCategoryEditorial(
    {
      id: 10,
      name: "مانتو",
      slug: "manto",
      description: "به فروشگاه پوشاک اینفینیتی خوش آمدید!\nمتن راهنما",
    },
    index.get("10"),
    routes,
  );
  assert.equal(plan.title, "مانتو");
  assert.match(plan.content, /^به فروشگاه پوشاک اینفینیتی/);
});

test("unsupported or ambiguous audio shortcodes fail closed", () => {
  assert.throws(
    () => extractAudio('[audio mp3="https://cdn.example/a.mp3"][audio mp3="https://cdn.example/b.mp3"]'),
    /MULTIPLE_AUDIO/,
  );
  assert.throws(() => extractAudio("[playlist ids=\"1\"]"), /PLAYLIST_UNSUPPORTED/);
  assert.throws(() => extractAudio("[audio]"), /AUDIO_URL_MISSING/);
});

test("unresolved old-site category links and WordPress image hotlinks fail validation", () => {
  const { categories, index, routes } = fixture();
  assert.throws(
    () => transformCategoryEditorial(
      { id: 10, name: "مانتو", slug: "manto", description: '<p><a href="/shop/missing/">ناشناخته</a></p>' },
      index.get("10"),
      routes,
    ),
    /UNRESOLVED_CATEGORY_LINK/,
  );
  assert.throws(
    () => transformCategoryEditorial(
      { id: 10, name: "مانتو", slug: "manto", description: '<p>متن</p><img alt="تصویر" src="https://infinitycolor.co/wp-content/uploads/a.jpg">' },
      index.get("10"),
      routes,
    ),
    /WORDPRESS_IMAGE_HOTLINK/,
  );
});

test("manifest and transformed hashes are deterministic", () => {
  const { categories, index, routes } = fixture();
  const plans = categories.map((category) =>
    transformCategoryEditorial(category, index.get(String(category.id)), routes),
  );
  plans[0].audioInspection = { sha256: "a".repeat(64), bytes: 42 };
  for (const plan of plans) {
    plan.sourceHash = categoryEditorialSourceHash(
      plan,
      plan.audioInspection?.sha256 || null,
    );
  }
  const first = buildCategoryEditorialManifest(categories, plans);
  const second = buildCategoryEditorialManifest(categories, plans);
  assert.equal(first.manifestHash, second.manifestHash);
  assert.equal(first.batchId, second.batchId);
  assert.equal(first.audioCount, 1);
  assert.equal(first.rewrittenLinkCount, 1);
});
