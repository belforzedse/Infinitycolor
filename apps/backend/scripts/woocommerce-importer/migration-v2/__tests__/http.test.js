"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JsonHttp } = require("../lib/http");

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
