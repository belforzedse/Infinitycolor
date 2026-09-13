"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildProductMap,
  collectProductMappings,
  distributeProducts,
  getHomepageConfig,
  parseArgs,
  selectPublishedProducts,
  tehranDayWindow,
} = require("../../friday-homepage");

test("accepts multiple distinct date windows", () => {
  assert.deepEqual(
    parseArgs(["--date", "2026-09-11", "--date", "2026-09-12", "--date", "2026-09-11"]),
    { apply: false, dates: ["2026-09-11", "2026-09-12"], reportDir: "" },
  );
});

test("uses only the standalone homepage job's required configuration", () => {
  const config = getHomepageConfig({
    WORDPRESS_SOURCE_URL: "https://wordpress.example",
    WP_USERNAME: "reader",
    WP_APPLICATION_PASSWORD: "application-password",
    WOOCOMMERCE_CONSUMER_KEY: "key",
    WOOCOMMERCE_CONSUMER_SECRET: "secret",
    STRAPI_API_TOKEN_PRODUCTION: "token",
    FRIDAY_HOMEPAGE_STRAPI_URL: "https://api.example/api/",
  });
  assert.equal(config.source.sourceBaseUrl, "https://wordpress.example");
  assert.equal(config.destination.baseUrl, "https://api.example/api");
});

test("resolves only selected Woo products through the capability-protected mapping API", async () => {
  const calls = [];
  const destination = {
    async post(pathname, body) {
      calls.push({ pathname, body });
      return { data: { data: [{ id: 101, external_source: "woocommerce", external_id: "1" }] } };
    },
  };
  assert.deepEqual(await collectProductMappings(destination, [{ id: 1 }, { id: 2 }]), [
    { id: 101, external_source: "woocommerce", external_id: "1" },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, "/settings/homepage-product-mappings");
  assert.deepEqual(calls[0].body, { data: { sourceIds: ["1", "2"] } });
});

test("builds the exact half-open Friday window in Tehran", () => {
  const window = tehranDayWindow("2026-09-11");
  assert.equal(window.startUtc, "2026-09-10T20:30:00.000Z");
  assert.equal(window.endUtc, "2026-09-11T20:30:00.000Z");
});

test("strictly keeps published products in the requested day and sorts newest first", () => {
  const window = tehranDayWindow("2026-09-11");
  const result = selectPublishedProducts(
    [
      { id: 1, status: "publish", date_created_gmt: "2026-09-10T20:29:59" },
      { id: 2, status: "draft", date_created_gmt: "2026-09-11T10:00:00" },
      { id: 3, status: "publish", date_created_gmt: "2026-09-10T20:30:00" },
      { id: 4, status: "publish", date_created_gmt: "2026-09-11T20:29:59" },
      { id: 5, status: "publish", date_created_gmt: "2026-09-11T20:30:00" },
    ],
    window,
  );
  assert.deepEqual(
    result.map((product) => product.id),
    [4, 3],
  );
});

test("copies every mapped product into every standard row and only sale products into discount", () => {
  const source = Array.from({ length: 13 }, (_, index) => ({
    id: index + 1,
    on_sale: index % 4 === 0,
  }));
  const map = buildProductMap(
    source.map((product) => ({
      id: product.id + 100,
      external_source: "woocommerce",
      external_id: String(product.id),
    })),
  );
  const result = distributeProducts(source, map);
  const expected = source.map((product) => product.id + 100);
  assert.deepEqual(
    Object.values(result.assignments).map((ids) => ids.length),
    [13, 13, 13, 13, 13],
  );
  for (const ids of Object.values(result.assignments)) assert.deepEqual(ids, expected);
  assert.deepEqual(result.discounted, [101, 105, 109, 113]);
});

test("fails closed when any selected product has not been imported", () => {
  const map = buildProductMap([{ id: 10, external_source: "woocommerce", external_id: "1" }]);
  assert.throws(
    () => distributeProducts([{ id: 1 }, { id: 2 }], map),
    /Selected products missing from Strapi: 2/,
  );
});

test("fails closed on ambiguous product mappings", () => {
  assert.throws(
    () =>
      buildProductMap([
        { id: 10, external_source: "woocommerce", external_id: "1" },
        { id: 11, external_source: "woocommerce", external_id: "1" },
      ]),
    /Ambiguous WooCommerce product mappings: 1/,
  );
});
