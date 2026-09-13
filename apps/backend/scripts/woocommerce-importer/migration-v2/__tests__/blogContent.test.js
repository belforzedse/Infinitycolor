"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const B = require("../lib/blogContent");

/**
 * The fixture is the real rendered body of the live article
 * `clothing-colors-for-wheat-skin` (WordPress post 918313), trimmed to three
 * carousel slides. Its promotional section and its markup around it are
 * verbatim — the shapes this module has to survive are the theme's, not ours.
 */
const FIXTURE = fs.readFileSync(
  path.join(__dirname, "fixtures", "blog-post-rendered.html"),
  "utf8",
);

const route = (slug) => (slug === "coat-and-mantle" ? "/plp/category/coat-and-mantle" : null);
const upload = async () => ({ url: "/uploads/blog-temp-pic1.png", id: 77 });

test("extractBalancedElements survives nesting and quoted attributes", () => {
  const html = '<div class="a"><div class="a">inner</div></div><div data-x="a>b" class="a">x</div>';
  const found = B.extractBalancedElements(html, (tag) => String(tag.attribs.class || "") === "a");
  assert.equal(found.length, 2, "a nested match is not returned twice");
  assert.equal(found[0].outerHtml, '<div class="a"><div class="a">inner</div></div>');
  assert.equal(found[1].attribs["data-x"], "a>b");
  // An unclosed element is skipped rather than swallowing the rest of the page.
  assert.deepEqual(B.extractBalancedElements('<div class="a">oops', () => true), []);
});

test("a rendered carousel becomes one products marker in source order", () => {
  const [carousel] = B.carouselsFrom(FIXTURE);
  assert.deepEqual(carousel.slugs, [
    "bokato-n0016-jeans",
    "3-piece-set-n0043",
    "oysho-half-zip-set-n0046",
  ]);
  assert.equal(
    B.productsMarker(carousel.slugs),
    '[products:"bokato-n0016-jeans","3-piece-set-n0043","oysho-half-zip-set-n0046"]',
  );
});

test("percent-encoded Persian slugs are decoded and never capped", () => {
  const anchors = Array.from({ length: 16 }, (_, index) =>
    `<a href="https://infinitycolor.co/product/%d8%b4%d9%84%d9%88%d8%a7%d8%b1-${index}/">x</a>`);
  const html = `<div id="the-content-products-swiper">${anchors.join("")}</div>`;
  const [carousel] = B.carouselsFrom(html);
  assert.equal(carousel.slugs.length, 16);
  assert.equal(carousel.slugs[0], "شلوار-0");
});

test("the same product linked twice in one carousel appears once", () => {
  const html = '<div id="the-content-products-swiper">' +
    '<a href="https://infinitycolor.co/product/kif/"><img></a>' +
    '<a href="https://infinitycolor.co/product/kif/">کیف</a>' +
    '<a href="https://infinitycolor.co/product/shal/?ref=blog">شال</a>' +
    "</div>";
  const [carousel] = B.carouselsFrom(html);
  assert.deepEqual(carousel.slugs, ["kif", "shal"]);
});

test("the promotional section yields every field the storefront renders", () => {
  const [promo] = B.promoSectionsFrom(FIXTURE);
  assert.deepEqual(promo.fields, {
    title: "مانتوهای ما، انتخابی دلچسب!",
    body: "زیبایی و انطباق با مد را با ما تجربه کنید",
    cta: { label: "مشاهده محصولات", href: "https://infinitycolor.co/shop/coat-and-mantle/" },
    social: {
      label: "Infinity.color_boutique",
      href: "https://instagram.com/infinity.color_boutique",
    },
    imageUrl: "https://infinitycolor.co/wp-content/themes/infinitycolor%2011/img/blog-temp-pic1.png",
    imageAlt: "",
    variant: "pic1",
  });
});

test("the illustration is chosen over the Instagram glyph that precedes it", () => {
  const html = '<section class="blog-middle-section">' +
    '<p class="text-primary-700 h">عنوان</p><p>متن</p>' +
    '<img id="insta-icon" src="https://example.com/img/insta.png">' +
    '<img src="https://example.com/img/blog-temp-pic3.png">' +
    "</section>";
  const [promo] = B.promoSectionsFrom(html);
  assert.match(promo.fields.imageUrl, /blog-temp-pic3\.png$/);
  assert.equal(promo.fields.variant, "pic3");
});

test("a /shop/ link becomes the destination category route, and says so when it cannot", () => {
  assert.deepEqual(
    B.rewriteShopHref("https://infinitycolor.co/shop/coat-and-mantle/", route),
    { href: "/plp/category/coat-and-mantle", diagnostic: null },
  );
  assert.deepEqual(
    B.rewriteShopHref("https://infinitycolor.co/shop/unknown/", route),
    { href: "https://infinitycolor.co/shop/unknown/", diagnostic: "PROMO_CTA_CATEGORY_UNRESOLVED" },
  );
  assert.deepEqual(
    B.rewriteShopHref("javascript:alert(1)", route),
    { href: null, diagnostic: "PROMO_CTA_HREF_UNSAFE" },
  );
});

test("transforming the real article replaces both blocks and keeps the prose", async () => {
  const result = await B.transformBlogContent(
    { raw: "[cyn_product_cat_temp][cyn_blog_temp pic=1]", renderedView: FIXTURE },
    { resolveCategoryRoute: route, uploadImage: upload },
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.carousels, 1);
  assert.equal(result.promos, 1);
  assert.deepEqual(result.productSlugs, [
    "bokato-n0016-jeans",
    "3-piece-set-n0043",
    "oysho-half-zip-set-n0046",
  ]);

  assert.match(result.content, /\[products:"bokato-n0016-jeans"/);
  assert.match(result.content, /\[promo:\{/);
  assert.ok(!result.content.includes("swiper-slide"), "theme carousel markup is gone");
  assert.ok(!result.content.includes("blog-middle-section"), "theme promo markup is gone");
  assert.ok(!result.content.includes("--bg-frame"), "the theme's frame style block goes with it");
  // The article itself is untouched.
  assert.match(result.content, /<h2>رنگ لباس برای پوست گندمی<\/h2>/);
  assert.match(result.content, /<h2>جمع بندی<\/h2>/);
  assert.match(result.content, /پوست گندمی معمولاً/);
  assert.ok(result.content.length < FIXTURE.length / 4, "the theme markup dominated the body");

  const promo = JSON.parse(/\[promo:(\{.*?\})\]/s.exec(result.content)[1]);
  assert.equal(promo.cta.href, "/plp/category/coat-and-mantle");
  assert.equal(promo.image.url, "/uploads/blog-temp-pic1.png");
  assert.equal(promo.variant, "pic1");
});

test("each marker is placed on its own line, never inside a paragraph", async () => {
  const result = await B.transformBlogContent(
    { raw: "", renderedView: FIXTURE },
    { resolveCategoryRoute: route, uploadImage: upload },
  );
  for (const marker of result.content.match(/\[(?:products|promo):[^\n]*/g)) {
    const index = result.content.indexOf(marker);
    assert.equal(result.content[index - 1], "\n", marker.slice(0, 20));
    assert.equal(result.content[index + marker.length], "\n", marker.slice(0, 20));
  }
});

test("a dry run recognises the promo block without hotlinking WordPress", async () => {
  const result = await B.transformBlogContent(
    { raw: "", renderedView: FIXTURE },
    { resolveCategoryRoute: route },
  );
  assert.deepEqual(result.diagnostics, ["PROMO_IMAGE_PENDING"]);
  assert.equal(result.pendingImages.length, 1);
  const promo = JSON.parse(/\[promo:(\{.*?\})\]/s.exec(result.content)[1]);
  assert.equal(promo.image, null);
  assert.ok(!result.content.includes("infinitycolor.co/wp-content"));
});

test("a source marker with no expanded block is reported, not silently dropped", async () => {
  // `context=edit` expands the promo but never the carousel: the transform has
  // to say so rather than quietly publishing an article without its products.
  const editOnly = FIXTURE.slice(FIXTURE.indexOf("<style"));
  const result = await B.transformBlogContent(
    { raw: "[cyn_product_cat_temp]\n[cyn_blog_temp pic=1]", renderedEdit: editOnly },
    { resolveCategoryRoute: route, uploadImage: upload },
  );
  assert.ok(result.diagnostics.includes("CAROUSEL_SOURCE_NOT_EXPANDED"));
  assert.equal(result.promos, 1, "the promo still converts from edit-context HTML");
});

test("a body with no blocks is returned unchanged", async () => {
  const html = "<h2>عنوان</h2><p>متن ساده</p>";
  const result = await B.transformBlogContent({ raw: "", renderedView: html }, {});
  assert.equal(result.content, html);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.carousels, 0);
  assert.equal(result.promos, 0);
});

test("two carousels in one article both convert", async () => {
  const one = '<div id="the-content-products-swiper"><a href="/product/a/">a</a></div>';
  const two = '<div class="swiper products-swiper"><a href="/product/b/">b</a></div>';
  const result = await B.transformBlogContent(
    { raw: "", renderedView: `<p>x</p>${one}<p>y</p>${two}<p>z</p>` },
    {},
  );
  assert.equal(result.carousels, 2);
  assert.deepEqual(result.productSlugs, ["a", "b"]);
  assert.match(result.content, /\[products:"a"\]/);
  assert.match(result.content, /\[products:"b"\]/);
});
