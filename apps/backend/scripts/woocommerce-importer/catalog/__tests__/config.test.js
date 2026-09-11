"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildConfig } = require("../config");

const TOUCHED_ENV_KEYS = [
  "STRAPI_API_TOKEN_PRODUCTION",
  "WOOCOMMERCE_IMPORT_PROFILE",
  "IMPORT_CONCURRENCY_PRODUCTS",
  "IMPORT_CONCURRENCY_VARIATIONS",
  "IMPORT_CONCURRENCY_IMAGES",
  "IMPORT_CONCURRENCY_ENTITIES",
];

function withEnv(overrides, fn) {
  const saved = new Map(TOUCHED_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of TOUCHED_ENV_KEYS) delete process.env[key];
    process.env.STRAPI_API_TOKEN_PRODUCTION = "test-token";
    Object.assign(process.env, overrides);
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("catalog config: normal defaults are unchanged (IMPORT_CONCURRENCY_PRODUCTS defaults to 1)", () => {
  withEnv({}, () => {
    const { config } = buildConfig("production");
    assert.deepEqual(config.catalog.concurrency, {
      products: 1,
      variations: 8,
      images: 4,
      videos: 1,
      entities: 8,
    });
  });
});

test("catalog config: WOOCOMMERCE_IMPORT_PROFILE=fast raises defaults; unrelated caps (videos) stay put", () => {
  withEnv({ WOOCOMMERCE_IMPORT_PROFILE: "fast" }, () => {
    const { config } = buildConfig("production");
    assert.deepEqual(config.catalog.concurrency, {
      products: 4,
      variations: 16,
      images: 8,
      videos: 1,
      entities: 24,
    });
  });
});

test("catalog config: an explicit IMPORT_CONCURRENCY_PRODUCTS always wins over the profile default", () => {
  withEnv({ WOOCOMMERCE_IMPORT_PROFILE: "fast", IMPORT_CONCURRENCY_PRODUCTS: "2" }, () => {
    const { config } = buildConfig("production");
    assert.equal(config.catalog.concurrency.products, 2);
  });
  withEnv({ IMPORT_CONCURRENCY_PRODUCTS: "5" }, () => {
    const { config } = buildConfig("production");
    assert.equal(config.catalog.concurrency.products, 5);
  });
});

test("catalog config: IMPORT_CONCURRENCY_PRODUCTS is bounded to 6", () => {
  withEnv({ IMPORT_CONCURRENCY_PRODUCTS: "7" }, () => {
    assert.throws(() => buildConfig("production"), /IMPORT_CONCURRENCY_PRODUCTS must be an integer between 1 and 6/);
  });
});

test("catalog config: an unknown WOOCOMMERCE_IMPORT_PROFILE value is rejected", () => {
  withEnv({ WOOCOMMERCE_IMPORT_PROFILE: "turbo" }, () => {
    assert.throws(() => buildConfig("production"), /must be one of default, fast/);
  });
});
