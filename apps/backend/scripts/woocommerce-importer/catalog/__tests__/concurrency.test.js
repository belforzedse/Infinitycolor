"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boundedInteger, mapPoolAsync, resolveImportProfile, profileDefault } = require("../lib/concurrency");

test("boundedInteger accepts the default, rejects out-of-range and non-integer values", () => {
  assert.equal(boundedInteger(undefined, { name: "X", defaultValue: 3, max: 8 }), 3);
  assert.equal(boundedInteger("5", { name: "X", defaultValue: 3, max: 8 }), 5);
  assert.throws(() => boundedInteger("9", { name: "X", defaultValue: 3, max: 8 }), /between 1 and 8/);
  assert.throws(() => boundedInteger("0", { name: "X", defaultValue: 3, max: 8 }), /between 1 and 8/);
  assert.throws(() => boundedInteger("1.5", { name: "X", defaultValue: 3, max: 8 }), /between 1 and 8/);
});

test("resolveImportProfile defaults to 'default' and validates its value", () => {
  assert.equal(resolveImportProfile({}), "default");
  assert.equal(resolveImportProfile({ WOOCOMMERCE_IMPORT_PROFILE: "" }), "default");
  assert.equal(resolveImportProfile({ WOOCOMMERCE_IMPORT_PROFILE: "fast" }), "fast");
  assert.equal(resolveImportProfile({ WOOCOMMERCE_IMPORT_PROFILE: "FAST" }), "fast");
  assert.throws(() => resolveImportProfile({ WOOCOMMERCE_IMPORT_PROFILE: "turbo" }), /must be one of default, fast/);
});

test("profileDefault only changes the fallback under 'fast'", () => {
  assert.equal(profileDefault("default", { default: 1, fast: 4 }), 1);
  assert.equal(profileDefault("fast", { default: 1, fast: 4 }), 4);
});

test("mapPoolAsync processes every item from a plain array", async () => {
  const seen = [];
  await mapPoolAsync([1, 2, 3, 4, 5], 2, async (item) => {
    seen.push(item);
  });
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("mapPoolAsync pulls from an async generator instead of materializing it (regression: Array.from(asyncGenerator) is [])", async () => {
  async function* source() {
    for (let i = 0; i < 25; i += 1) {
      await Promise.resolve(); // force a real microtask boundary between yields
      yield i;
    }
  }
  const seen = [];
  await mapPoolAsync(source(), 5, async (item) => {
    seen.push(item);
  });
  assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i));
});

test("mapPoolAsync never runs more than `concurrency` mappers at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  async function* source() {
    for (let i = 0; i < 20; i += 1) yield i;
  }
  await mapPoolAsync(source(), 3, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
  });
  assert.equal(maxInFlight <= 3, true);
  assert.equal(maxInFlight > 1, true); // sanity: it did actually run concurrently, not accidentally serially
});

test("mapPoolAsync aborts remaining work on the first thrown error and rethrows it", async () => {
  const processed = [];
  async function* source() {
    for (let i = 0; i < 20; i += 1) yield i;
  }
  await assert.rejects(
    mapPoolAsync(source(), 4, async (item) => {
      processed.push(item);
      if (item === 3) throw new Error("boom");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }),
    /boom/,
  );
  // Some items may already have started before the failure was observed, but
  // the pool must not have drained and processed all 20.
  assert.ok(processed.length < 20);
});
