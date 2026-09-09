"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  decodeHtml,
  durationMsFromLength,
  flattenWpStories,
  parseHomepageStories,
  reverseForNewestFirst,
  rewriteCtaUrl,
  resolveMediaType,
  resolveWpStoryId,
} = require("../lib/storyTransform");

const SAMPLE_CIRCLES = [
  {
    box: 1176380,
    id: "story-1176380-1200188",
    photo: "https://infinitycolor.co/wp-content/uploads/cover.jpg",
    name: "فروشگاه حضوری",
    items: [
      {
        box: 1200188,
        index: 0,
        id: "story-1200188-0",
        type: "video",
        length: "39",
        src: "https://infinitycolor.co/wp-content/uploads/store.mov",
        link: "",
        linkText: "",
      },
    ],
  },
  {
    box: 1176380,
    id: "story-1176380-1294460",
    photo: "https://infinitycolor.co/wp-content/uploads/ural.jpg",
    name: "اورال دامنی",
    items: [
      {
        box: 1294460,
        index: 0,
        id: "story-1294460-0",
        type: "video",
        length: "3",
        src: "https://infinitycolor.co/wp-content/uploads/ural.mov",
        link: "https://infinitycolor.co/product/ural-dominyy00780/",
        linkText: "اورال دامنی",
      },
      {
        box: 1294460,
        index: 1,
        id: "story-1294460-1",
        type: "video",
        length: "4",
        src: "https://infinitycolor.co/wp-content/uploads/ural-2.mov",
        link: "https://infinitycolor.co/product/%da%a9%d8%aa-%da%a9%d8%b1%d8%a7%d9%be/",
        linkText: "کت کراپ",
      },
    ],
  },
];

test("parseHomepageStories: extracts the wps rail JSON from surrounding HTML", () => {
  const html = `<html><script>var other=1;</script><script>var wps42a62efc556a64aa8c7f0c61463581b2=${JSON.stringify(SAMPLE_CIRCLES)};Zuck(el,{stories:wps42a62efc556a64aa8c7f0c61463581b2});</script></html>`;
  const parsed = parseHomepageStories(html);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, "فروشگاه حضوری");
  assert.equal(parsed[1].items.length, 2);
});

test("parseHomepageStories: throws when the rail payload is missing", () => {
  assert.throws(() => parseHomepageStories("<html>no stories</html>"), /No WP Story Premium/);
});

test("flattenWpStories: one Strapi slide per WP item with stable slugs", () => {
  const slides = flattenWpStories(SAMPLE_CIRCLES);
  assert.equal(slides.length, 3);
  assert.equal(slides[0].slug, "wp-1200188-0");
  assert.equal(slides[0].title, "فروشگاه حضوری");
  assert.equal(slides[0].mediaType, "video");
  assert.equal(slides[0].sortOrder, 0);
  assert.equal(slides[0].durationMs, 39000);
  assert.equal(slides[0].ctaUrl, undefined);

  assert.equal(slides[1].slug, "wp-1294460-0");
  assert.equal(slides[1].sortOrder, 1);
  assert.equal(slides[1].ctaUrl, "/pdp/ural-dominyy00780");
  assert.equal(slides[1].ctaLabel, "اورال دامنی");

  assert.equal(slides[2].slug, "wp-1294460-1");
  assert.equal(slides[2].title, "اورال دامنی (2)");
  assert.equal(slides[2].sortOrder, 2);
  assert.equal(slides[2].ctaUrl, "/pdp/کت-کراپ");
});

test("reverseForNewestFirst: last homepage slide is imported first", () => {
  const slides = flattenWpStories(SAMPLE_CIRCLES);
  const reversed = reverseForNewestFirst(slides);
  assert.equal(reversed[0].slug, "wp-1294460-1");
  assert.equal(reversed[0].sortOrder, 2);
  assert.equal(reversed[reversed.length - 1].slug, "wp-1200188-0");
});

test("rewriteCtaUrl: maps WP product permalinks to /pdp/{slug}", () => {
  assert.equal(
    rewriteCtaUrl("https://infinitycolor.co/product/ural-dominyy00780/"),
    "/pdp/ural-dominyy00780",
  );
  assert.equal(
    rewriteCtaUrl("https://www.infinitycolor.co/product/%da%a9%d8%aa-%da%a9%d8%b1%d8%a7%d9%be/"),
    "/pdp/کت-کراپ",
  );
  assert.equal(rewriteCtaUrl("/product/two-piece-sleepwear-g01163/"), "/pdp/two-piece-sleepwear-g01163");
  assert.equal(rewriteCtaUrl(""), undefined);
  assert.equal(rewriteCtaUrl("https://example.com/other"), "https://example.com/other");
});

test("durationMsFromLength: converts seconds and enforces the 1000ms floor", () => {
  assert.equal(durationMsFromLength("39"), 39000);
  assert.equal(durationMsFromLength("3"), 3000);
  assert.equal(durationMsFromLength("0.4"), 1000);
  assert.equal(durationMsFromLength(""), 5000);
  assert.equal(durationMsFromLength("nope"), 5000);
});

test("resolveMediaType: uses type then file extension", () => {
  assert.equal(resolveMediaType("video", "https://x/a.mov"), "video");
  assert.equal(resolveMediaType("photo", "https://x/a.jpg"), "image");
  assert.equal(resolveMediaType("", "https://x/clip.mp4"), "video");
  assert.equal(resolveMediaType("", "https://x/cover.webp"), "image");
  assert.equal(resolveMediaType("", "https://x/unknown"), null);
});

test("resolveWpStoryId: prefers item.box then id patterns", () => {
  assert.equal(resolveWpStoryId({}, { box: 1200188 }), 1200188);
  assert.equal(resolveWpStoryId({ id: "story-1-99" }, { id: "story-55-0" }), 55);
  assert.equal(resolveWpStoryId({ id: "story-1176380-1200188" }, {}), 1200188);
});

test("decodeHtml: unescapes numeric entities", () => {
  assert.equal(decodeHtml("600&#215;750"), "600×750");
});
