"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");

const dockerfile = readFileSync(resolve(__dirname, "../production-overlay.Dockerfile"), "utf8");
const slugHotfixDockerfile = readFileSync(
  resolve(__dirname, "../slug-hotfix-overlay.Dockerfile"),
  "utf8",
);

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

test("slug hotfix overlay replaces no sync-service files", () => {
  assert.match(slugHotfixDockerfile, /ARG BASE_IMAGE/);
  assert.match(
    slugHotfixDockerfile,
    /COPY apps\/backend\/scripts\/woocommerce-importer\/catalog\/lib\/slug\.js/,
  );
  assert.doesNotMatch(
    slugHotfixDockerfile,
    /COPY apps\/backend\/scripts\/woocommerce-sync(?:\s|\/)/,
  );
});

test("production overlay installs sanitize-html for category editorial", () => {
  assert.match(dockerfile, /sanitize-html@2\.17\.0/);
  assert.match(dockerfile, /COPY apps\/backend\/scripts\/woocommerce-importer\/catalog\s/);
});
