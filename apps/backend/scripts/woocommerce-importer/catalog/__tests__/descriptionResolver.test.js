"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  visibleText,
  comparableText,
  isEffectivelyEmpty,
  isTrivial,
  resolveProductDescription,
} = require("../lib/descriptionResolver");

/**
 * The live catalog: 3,374 of 3,400 products keep their body only in
 * `short_description`, 2 only in `description`, and two more have a real short
 * description plus an editing leftover (`<p><del>my</del></p>`) in the main
 * field. `description || short_description` picked the leftover, which is what
 * two production PDPs display today.
 */

const REAL_BODY = "<p>شال نخی با طرح گلدار، مناسب فصل بهار و تابستان.</p><ul><li>جنس: نخ</li><li>ابعاد: ۲۰۰×۷۰</li></ul>";
const LEFTOVER = "<p><del>my</del></p>";

test("visibleText strips markup and decodes the entities Woo actually emits", () => {
  assert.equal(visibleText("<p>سلام&nbsp;دنیا</p>"), "سلام دنیا");
  assert.equal(visibleText("<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>"), 'a & b <c> "d"');
  assert.equal(visibleText("<p>می&zwnj;شود</p>"), "می‌شود");
  assert.equal(visibleText("<div><script>var x = '<p>hi</p>';</script>متن</div>"), "متن");
  assert.equal(visibleText("<!-- comment -->متن"), "متن");
  assert.equal(visibleText("<p>&#1587;&#x644;&#1575;&#1605;</p>"), "سلام");
});

test("isEffectivelyEmpty covers every shape of empty WooCommerce markup", () => {
  for (const html of ["", "   ", "<p></p>", "<p>&nbsp;</p>", "<br>", "<br/>", "<div><span> </span></div>", "<p>\n\n</p>"]) {
    assert.equal(isEffectivelyEmpty(html), true, JSON.stringify(html));
  }
  assert.equal(isEffectivelyEmpty("<p>.</p>"), false, "a visible character is not empty");
  assert.equal(isEffectivelyEmpty(REAL_BODY), false);
});

test("isTrivial separates an editing leftover from short but real copy", () => {
  assert.equal(isTrivial(LEFTOVER), true);
  assert.equal(isTrivial("<p>test</p>"), true);
  assert.equal(isTrivial("<p>xx</p>"), true);
  assert.equal(isTrivial(REAL_BODY), false);
  // Structure means content even when the visible text is short.
  assert.equal(isTrivial("<ul><li>نخ</li></ul>"), false);
  assert.equal(isTrivial("<p>یک توضیح کوتاه ولی واقعی درباره محصول</p>"), false);
});

test("comparableText normalizes Persian so shape differences are not new content", () => {
  assert.equal(
    comparableText("<p>شال کتان می‌شود</p>"),
    comparableText("<p>شال كتان مي شود!</p>"),
    "Arabic yeh/kaf and ZWNJ are the same copy",
  );
  assert.equal(comparableText("<p>۱۲۳</p>"), comparableText("<p>123</p>"));
});

test("a leftover in description never outranks the real short description", () => {
  const resolved = resolveProductDescription({ description: LEFTOVER, short_description: REAL_BODY });
  assert.equal(resolved.html, REAL_BODY);
  assert.equal(resolved.source, "short_description");
  assert.equal(resolved.reason, "MAIN_TRIVIAL");
});

test("whichever single field carries the copy is the one imported", () => {
  assert.deepEqual(
    resolveProductDescription({ description: "", short_description: REAL_BODY }),
    { html: REAL_BODY, source: "short_description", reason: "MAIN_EMPTY" },
  );
  assert.deepEqual(
    resolveProductDescription({ description: REAL_BODY, short_description: "<p>&nbsp;</p>" }),
    { html: REAL_BODY, source: "description", reason: "SHORT_EMPTY" },
  );
  assert.deepEqual(
    resolveProductDescription({ description: "<p></p>", short_description: "" }),
    { html: "", source: "none", reason: "BOTH_EMPTY" },
  );
  assert.deepEqual(
    resolveProductDescription({}),
    { html: "", source: "none", reason: "BOTH_EMPTY" },
  );
});

test("a substantial main body is kept when the short field is only a tagline", () => {
  const resolved = resolveProductDescription({ description: REAL_BODY, short_description: "<p>شال نخی</p>" });
  assert.equal(resolved.source, "description");
  assert.equal(resolved.reason, "SHORT_TRIVIAL");
});

test("the same copy written twice is imported once, keeping the richer markup", () => {
  const plain = "<p>شال نخی با طرح گلدار مناسب فصل بهار و تابستان است</p>";
  const shaped = "<p>شال كتان</p>";
  const identical = resolveProductDescription({
    description: plain,
    short_description: "<p>شال نخي با طرح گلدار مناسب فصل بهار و تابستان است</p>",
  });
  assert.equal(identical.reason, "IDENTICAL");
  assert.equal(identical.html, plain, "ties go to description");

  const contained = resolveProductDescription({
    description: REAL_BODY,
    short_description: "<p>شال نخی با طرح گلدار، مناسب فصل بهار و تابستان.</p>",
  });
  assert.equal(contained.reason, "CONTAINED");
  assert.equal(contained.html, REAL_BODY, "the richer of two redundant texts wins");
  assert.notEqual(shaped, null);
});

test("a reworded near-duplicate is not imported twice", () => {
  const resolved = resolveProductDescription({
    description: "<p>پیراهن نخی مردانه با یقه کلاسیک و دوخت تمیز برای استفاده روزمره</p>",
    short_description: "<p>پیراهن نخی مردانه، یقه کلاسیک، دوخت تمیز، روزمره</p>",
  });
  assert.equal(resolved.reason, "REDUNDANT");
  assert.equal(resolved.source, "description");
});

test("two genuinely different texts are both kept, main body first", () => {
  const main = "<p>این پیراهن از پارچه نخ پنبه با بافت ساده تولید شده است</p>";
  const short = "<ul><li>شست‌وشو با آب سرد</li><li>اتو با دمای ملایم</li></ul>";
  const resolved = resolveProductDescription({ description: main, short_description: short });
  assert.equal(resolved.source, "both");
  assert.equal(resolved.reason, "COMPLEMENTARY");
  assert.ok(resolved.html.indexOf(main) < resolved.html.indexOf(short), "WooCommerce renders the main body first");
  assert.match(resolved.html, /شست/);
});

test("both fields trivial still yields a deterministic answer", () => {
  const resolved = resolveProductDescription({ description: "<p>ab</p>", short_description: "<p>abcd</p>" });
  assert.equal(resolved.reason, "BOTH_TRIVIAL");
  assert.equal(resolved.html, "<p>abcd</p>", "the longer of two leftovers");
  const tie = resolveProductDescription({ description: "<p>ab</p>", short_description: "<p>cd</p>" });
  assert.equal(tie.source, "description");
});

test("resolution is a pure function of the two fields", () => {
  const input = { description: LEFTOVER, short_description: REAL_BODY, name: "ignored" };
  const first = resolveProductDescription(input);
  const second = resolveProductDescription(input);
  assert.deepEqual(first, second);
  assert.equal(input.description, LEFTOVER, "the source object is never mutated");
});
