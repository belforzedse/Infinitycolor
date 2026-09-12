"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JsonHttp, isRetryableNetworkError } = require("../lib/http");

test("source HTTP client rejects all mutation verbs before network access", async () => {
  const client = new JsonHttp({ baseUrl: "https://example.com", sourceReadOnly: true });
  await assert.rejects(() => client.post("/products", { name: "x" }), /SOURCE_WRITE_BLOCKED:POST/);
  await assert.rejects(() => client.put("/products/1", { name: "x" }), /SOURCE_WRITE_BLOCKED:PUT/);
  assert.equal(client.metrics.requests, 0);
});

test("HTTP client preserves status and retries a non-JSON server error", async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("temporarily unavailable", { status: 503 });
    }
    return Response.json({ ok: true });
  };
  t.after(() => { global.fetch = originalFetch; });

  const client = new JsonHttp({ baseUrl: "https://example.com", retries: 1 });
  const response = await client.get("/health");
  assert.deepEqual(response.data, { ok: true });
  assert.equal(calls, 2);
  assert.equal(client.metrics.retries, 1);
});

test("retries the transport failure shape that killed the 2026-09-12 campaign", async (t) => {
  // Exactly what Node threw: `TypeError: fetch failed` with the real reason
  // buried on `cause.code`. The old predicate only read `error.status`, so this
  // escaped the retry loop on attempt 0 and took the whole run down.
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      });
    }
    return Response.json({ ok: true });
  };
  t.after(() => { global.fetch = originalFetch; });

  const client = new JsonHttp({ baseUrl: "https://example.com", retries: 2 });
  assert.deepEqual((await client.get("/customers")).data, { ok: true });
  assert.equal(calls, 2);
  assert.equal(client.metrics.retries, 1);
});

test("retries a DNS failure reported inside an AggregateError", async (t) => {
  // Dual-stack hosts report a failed connect as an aggregate whose *children*
  // carry the code; the parent has none.
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new AggregateError([
          Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }),
        ], "all attempts failed"), { code: undefined }),
      });
    }
    return Response.json({ ok: true });
  };
  t.after(() => { global.fetch = originalFetch; });

  const client = new JsonHttp({ baseUrl: "https://example.com", retries: 2 });
  assert.deepEqual((await client.get("/customers")).data, { ok: true });
  assert.equal(calls, 2);
});

test("does not retry a 4xx, or a transport error carrying no recognised code", async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "BAD" }), { status: 400 });
  };
  t.after(() => { global.fetch = originalFetch; });

  const client = new JsonHttp({ baseUrl: "https://example.com", retries: 4 });
  await assert.rejects(() => client.get("/customers"), /HTTP_400/);
  assert.equal(calls, 1, "a 400 must not be retried");
  assert.equal(client.metrics.failures, 1);

  // An unrecognised transport failure is treated as our own bug, not a blip.
  calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new TypeError("fetch failed");
  };
  const strict = new JsonHttp({ baseUrl: "https://example.com", retries: 4 });
  await assert.rejects(() => strict.get("/customers"), /fetch failed/);
  assert.equal(calls, 1, "no recognised code must not loop");
});

test("terminates instead of hanging on a self-referential cause chain", () => {
  const looping = new TypeError("fetch failed");
  looping.cause = looping;
  assert.equal(isRetryableNetworkError(looping), false);
  const deep = Object.assign(new Error("a"), {
    cause: Object.assign(new Error("b"), { code: "ECONNRESET" }),
  });
  assert.equal(isRetryableNetworkError(deep), true);
});
