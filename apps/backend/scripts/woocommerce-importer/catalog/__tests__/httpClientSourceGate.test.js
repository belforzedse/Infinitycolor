"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { HttpClient } = require("../lib/httpClient");
const { isTransportError } = require("../lib/backoff");
const { SourceGate } = require("../../migration-v2/lib/sourceGate");

const silent = { info() {}, warn() {}, debug() {} };
const noSleep = async () => {};

function axiosTransportError(code = "ECONNABORTED") {
  return Object.assign(new Error(`timeout of 60000ms exceeded`), { code, request: {} });
}

function axiosStatusError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, headers: {} } });
}

/**
 * The 2026-09-13 shape: `catalog/engine.js#preflight` calls
 * `GET /products?per_page=1`, Woo is unreachable for a few minutes, the four
 * attempts are spent, and the campaign dies. With the gate the same request
 * parks and then succeeds.
 */
test("a Woo outage during preflight holds instead of failing the run", async () => {
  let calls = 0;
  const instance = {
    request: async () => {
      calls += 1;
      if (calls <= 4) throw axiosTransportError();
      return { data: [{ id: 1 }], status: 200 };
    },
  };

  let probes = 0;
  const gate = new SourceGate({
    probe: async () => { probes += 1; },
    logger: silent,
    sleepFn: noSleep,
    now: () => 0,
  });

  const client = new HttpClient(instance, {
    logger: silent, maxRetries: 4, sleepFn: noSleep, sourceGate: gate,
  });

  const response = await client.get("/products");

  assert.equal(response.status, 200);
  assert.equal(gate.metrics.holds, 1, "must have parked on the gate once");
  assert.equal(probes, 1);
  assert.equal(client.metrics.gateHolds, 1);
});

test("a client with no gate still fails fast (unchanged behaviour)", async () => {
  const instance = { request: async () => { throw axiosTransportError(); } };
  const client = new HttpClient(instance, { logger: silent, maxRetries: 4, sleepFn: noSleep });

  await assert.rejects(() => client.get("/products"), (e) => e.code === "ECONNABORTED");
});

test("an exhausted hold budget surfaces SOURCE_UNAVAILABLE", async () => {
  const instance = { request: async () => { throw axiosTransportError(); } };
  let nowMs = 0;
  const gate = new SourceGate({
    probe: async () => { throw axiosTransportError(); },
    logger: silent,
    maxHoldMs: 60_000,
    sleepFn: async (ms) => { nowMs += ms; },
    now: () => nowMs,
  });
  const client = new HttpClient(instance, {
    logger: silent, maxRetries: 2, sleepFn: noSleep, sourceGate: gate,
  });

  await assert.rejects(() => client.get("/products"), (e) => e.code === "SOURCE_UNAVAILABLE");
});

test("HTTP 429/5xx are retried but never held — Woo is answering", async () => {
  let calls = 0;
  const instance = {
    request: async () => {
      calls += 1;
      if (calls <= 2) throw axiosStatusError(503);
      return { data: [], status: 200 };
    },
  };
  const gate = new SourceGate({ probe: async () => {}, logger: silent, sleepFn: noSleep });
  const client = new HttpClient(instance, {
    logger: silent, maxRetries: 4, sleepFn: noSleep, sourceGate: gate,
  });

  const response = await client.get("/products");
  assert.equal(response.status, 200);
  assert.equal(gate.metrics.holds, 0, "a 5xx means the source is up; do not park");
});

test("a request cannot park forever against a flapping source", async () => {
  // Every probe succeeds, every request fails: without the per-request cap this
  // would alternate hold/fail indefinitely.
  const instance = { request: async () => { throw axiosTransportError("ECONNRESET"); } };
  const gate = new SourceGate({ probe: async () => {}, logger: silent, sleepFn: noSleep, now: () => 0 });
  const client = new HttpClient(instance, {
    logger: silent, maxRetries: 1, sleepFn: noSleep, sourceGate: gate, maxGateHolds: 3,
  });

  await assert.rejects(() => client.get("/products"), (e) => e.code === "ECONNRESET");
  assert.equal(client.metrics.gateHolds, 3, "capped at maxGateHolds");
});

test("the engine gates the Woo client and never the Strapi writer", () => {
  const os = require("node:os");
  const { CatalogEngine } = require("../engine");

  const config = {
    woocommerce: {
      baseUrl: "https://src.test/wp-json/wc/v3",
      timeout: 1000,
      auth: { consumerKey: "k", consumerSecret: "s" },
    },
    strapi: { baseUrl: "http://dest.test/api", apiToken: "t", token: "t" },
    catalog: {
      maxRetries: 4, baseRetryDelay: 1, sourceHoldMaxMs: 1234, perPage: 100,
      allowHttpMedia: true, concurrency: { images: 1, videos: 1 },
    },
    duplicateTracking: { storageDir: os.tmpdir() },
    import: { currency: { multiplier: 1 }, statusMappings: { product: {} } },
    media: {},
  };
  const engine = new CatalogEngine(config, silent);

  assert.ok(engine.woo.http.sourceGate, "the Woo client must hold on an outage");
  assert.equal(
    engine.repo.http.sourceGate,
    null,
    "the Strapi writer must fail fast — holding a campaign because *we* are down helps nobody",
  );
  assert.equal(engine.sourceGate.maxHoldMs, 1234, "config knob must reach the gate");
});

test("a campaign-injected gate is shared rather than replaced", () => {
  const os = require("node:os");
  const { CatalogEngine } = require("../engine");
  const shared = new SourceGate({ probe: async () => {}, logger: silent });

  const engine = new CatalogEngine({
    woocommerce: { baseUrl: "https://src.test", timeout: 1000, auth: { consumerKey: "k", consumerSecret: "s" } },
    strapi: { baseUrl: "http://dest.test/api", apiToken: "t", token: "t" },
    catalog: {
      maxRetries: 4, baseRetryDelay: 1, sourceHoldMaxMs: 1, perPage: 100,
      allowHttpMedia: true, concurrency: { images: 1, videos: 1 },
    },
    duplicateTracking: { storageDir: os.tmpdir() },
    import: { currency: { multiplier: 1 }, statusMappings: { product: {} } },
    media: {},
    sourceGate: shared,
  }, silent);

  assert.equal(engine.sourceGate, shared, "cutover runs catalog and identities concurrently on one gate");
  assert.equal(engine.woo.http.sourceGate, shared);
});

test("isTransportError separates unreachable from reachable-but-unhappy", () => {
  assert.equal(isTransportError(axiosTransportError("ECONNABORTED")), true);
  assert.equal(isTransportError(axiosTransportError("EAI_AGAIN")), true);
  assert.equal(isTransportError(axiosStatusError(503)), false);
  assert.equal(isTransportError(axiosStatusError(429)), false);
  assert.equal(isTransportError(new Error("boom")), false);
});

test("SOURCE_UNAVAILABLE aborts the catalog run instead of becoming an item failure", () => {
  const { isRunControlError } = require("../engine");
  assert.equal(
    isRunControlError({ code: "SOURCE_UNAVAILABLE" }),
    true,
    "the per-product catch re-throws only run-control errors; without this a dead "
      + "source would be recorded once per product and the run would grind on",
  );
  assert.equal(isRunControlError({ code: "CATALOG_RUN_PAUSED" }), true);
  assert.equal(isRunControlError({ code: "SOURCE_UPDATED_BEFORE_CREATED" }), false);
});
