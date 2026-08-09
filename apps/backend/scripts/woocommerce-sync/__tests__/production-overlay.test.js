"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const dockerfile = readFileSync(resolve(__dirname, "../production-overlay.Dockerfile"), "utf8");

test("production overlay ships the canonical slug resolver used by transforms", () => {
  assert.match(
    dockerfile,
    /COPY apps\/backend\/scripts\/woocommerce-importer\/catalog\/lib\/slug\.js\s+\\\s*\/app\/scripts\/woocommerce-importer\/catalog\/lib\/slug\.js/,
  );
});

test("production overlay ships the slug regression tests", () => {
  assert.match(
    dockerfile,
    /COPY apps\/backend\/scripts\/woocommerce-importer\/catalog\/__tests__\/slug\.test\.js\s+\\\s*\/app\/scripts\/woocommerce-importer\/catalog\/__tests__\/slug\.test\.js/,
  );
});
