"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { SourceGate } = require("../lib/sourceGate");
const { isSourceDownError } = require("../lib/http");
const { JsonHttp } = require("../lib/http");

/** A clock and sleep pair that advances instantly, so held time is simulated. */
function fakeClock() {
  let nowMs = 0;
  return {
    now: () => nowMs,
    sleepFn: async (ms) => { nowMs += ms; },
    advance: (ms) => { nowMs += ms; },
  };
}

const silent = { info() {}, warn() {} };

function transportError(code = "ECONNABORTED") {
  return Object.assign(new Error("connect failed"), { code, cause: { code } });
}

test("holds until the probe succeeds, then resolves", async () => {
  const clock = fakeClock();
  let probes = 0;
  const gate = new SourceGate({
    probe: async () => {
      probes += 1;
      if (probes < 3) throw transportError();
    },
    logger: silent,
    sleepFn: clock.sleepFn,
    now: clock.now,
  });

  await gate.holdUntilHealthy({ reason: "test" });

  assert.equal(probes, 3);
  assert.equal(gate.metrics.holds, 1);
  assert.ok(gate.metrics.heldMs > 0, "held time must be recorded");
  assert.equal(gate.holding, false, "gate must release after recovery");
});

test("throws SOURCE_UNAVAILABLE once the hold budget is spent", async () => {
  const clock = fakeClock();
  const gate = new SourceGate({
    probe: async () => { throw transportError(); },
    logger: silent,
    maxHoldMs: 5 * 60 * 1000,
    sleepFn: clock.sleepFn,
    now: clock.now,
  });

  await assert.rejects(
    () => gate.holdUntilHealthy({ reason: "test" }),
    (error) => error.code === "SOURCE_UNAVAILABLE",
  );
  assert.equal(gate.holding, false, "gate must release after giving up");
});

test("exhaustion is sticky: later callers fail instantly, no fresh hold", async () => {
  const clock = fakeClock();
  const gate = new SourceGate({
    probe: async () => { throw transportError(); },
    logger: silent,
    maxHoldMs: 60_000,
    sleepFn: clock.sleepFn,
    now: clock.now,
  });

  await assert.rejects(() => gate.holdUntilHealthy(), (e) => e.code === "SOURCE_UNAVAILABLE");
  const probesAfterFirst = gate.metrics.probes;
  const heldAfterFirst = gate.metrics.heldMs;

  // The entity loops catch per-item errors, so a dead source reaches the gate
  // once per remaining product/customer/order. None may open a new hold.
  for (let i = 0; i < 50; i += 1) {
    await assert.rejects(() => gate.holdUntilHealthy(), (e) => e.code === "SOURCE_UNAVAILABLE");
  }

  assert.equal(gate.metrics.probes, probesAfterFirst, "must not probe a source already given up on");
  assert.equal(gate.metrics.heldMs, heldAfterFirst, "must not spend more hold budget");
  assert.equal(gate.metrics.holds, 1, "50 further failures must not open 50 holds");
});

test("reset() lets the next job hold again", async () => {
  const clock = fakeClock();
  let healthy = false;
  const gate = new SourceGate({
    probe: async () => { if (!healthy) throw transportError(); },
    logger: silent,
    maxHoldMs: 60_000,
    sleepFn: clock.sleepFn,
    now: clock.now,
  });

  await assert.rejects(() => gate.holdUntilHealthy(), (e) => e.code === "SOURCE_UNAVAILABLE");
  assert.equal(gate.exhausted, true);

  // The worker shares one gate across every job; a bad night must not disable
  // holding until the container restarts.
  gate.reset();
  healthy = true;
  await gate.holdUntilHealthy();

  assert.equal(gate.metrics.holds, 2);
});

test("concurrent callers share one hold and one probe loop", async () => {
  const clock = fakeClock();
  let probes = 0;
  const gate = new SourceGate({
    probe: async () => {
      probes += 1;
      if (probes < 2) throw transportError();
    },
    logger: silent,
    sleepFn: clock.sleepFn,
    now: clock.now,
  });

  // 24 concurrent Woo requests all fail at the same instant, as they do when the
  // source drops mid-campaign at entity concurrency 24.
  await Promise.all(Array.from({ length: 24 }, () => gate.holdUntilHealthy()));

  assert.equal(gate.metrics.holds, 1, "must not start 24 separate holds");
  assert.equal(probes, 2, "must not fire 24 probes at a dead source");
});

test("a fresh hold can start after an earlier one resolved", async () => {
  const clock = fakeClock();
  // Two separate outages: the probe fails once, recovers, then fails once again.
  const script = [false, true, false, true];
  const gate = new SourceGate({
    probe: async () => { if (script.shift() === false) throw transportError(); },
    logger: silent,
    sleepFn: clock.sleepFn,
    now: clock.now,
  });

  await gate.holdUntilHealthy();
  assert.equal(gate.holding, false);
  await gate.holdUntilHealthy();

  assert.equal(gate.metrics.holds, 2);
  assert.equal(gate.metrics.probes, 4);
});

test("maxHoldMs=0 disables holding entirely rather than failing differently", () => {
  const { createSourceGate } = require("../lib/sourceGate");
  assert.equal(
    createSourceGate({ probe: async () => {}, maxHoldMs: 0 }),
    null,
    "a disabled gate must be absent, so clients take the original throw path",
  );
  assert.ok(createSourceGate({ probe: async () => {}, maxHoldMs: 1000 }));
  assert.ok(createSourceGate({ probe: async () => {} }), "defaults to holding");

  // The documented escape hatch: WOOCOMMERCE_SYNC_SOURCE_HOLD_MAX_MS=0.
  const { WordPressSource } = require("../lib/source");
  const cfg = { sourceBaseUrl: "https://x.test", wooKey: "k", wooSecret: "s", wpUsername: "u", wpApplicationPassword: "p" };

  const disabled = new WordPressSource(cfg, { sourceHoldMaxMs: 0 });
  assert.equal(disabled.sourceGate, null);
  assert.equal(disabled.woo.sourceGate, null, "no gate means the original error propagates");

  // Ad-hoc callers (identity-audit, cli.js, reconcile-orders…) pass no options
  // and must keep failing fast rather than appearing to hang.
  const adhoc = new WordPressSource(cfg);
  assert.equal(adhoc.sourceGate, null, "holding is opt-in for WordPressSource");

  const campaign = new WordPressSource(cfg, { sourceHoldMaxMs: 5000 });
  assert.ok(campaign.sourceGate, "the sync service opts in");
  assert.equal(campaign.woo.sourceGate, campaign.sourceGate);
});

test("isSourceDownError separates unreachable from reachable-but-unhappy", () => {
  assert.equal(isSourceDownError(transportError("ECONNRESET")), true);
  assert.equal(isSourceDownError(transportError("UND_ERR_CONNECT_TIMEOUT")), true);
  assert.equal(isSourceDownError(Object.assign(new Error("t"), { name: "AbortError" })), true);

  // Woo answered — retry it, but do not park the campaign.
  assert.equal(isSourceDownError(Object.assign(new Error("HTTP_429"), { status: 429 })), false);
  assert.equal(isSourceDownError(Object.assign(new Error("HTTP_503"), { status: 503 })), false);
  assert.equal(isSourceDownError(Object.assign(new Error("HTTP_404"), { status: 404 })), false);
  // A bare failure with no recognised code is likelier our own bad URL.
  assert.equal(isSourceDownError(new Error("fetch failed")), false);
});

test("JsonHttp ignores a gate on a destination (write) client", () => {
  const gate = new SourceGate({ probe: async () => {}, logger: silent });
  const writer = new JsonHttp({ baseUrl: "http://dest", sourceReadOnly: false, sourceGate: gate });
  assert.equal(writer.sourceGate, null, "a Strapi outage must still fail fast");

  const reader = new JsonHttp({ baseUrl: "http://src", sourceReadOnly: true, sourceGate: gate });
  assert.equal(reader.sourceGate, gate);
});
