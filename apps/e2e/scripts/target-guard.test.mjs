import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSafeTargets, checkTargets } from "../helpers/target-guard.mjs";

const STAGING = {
  storefront: "https://staging.infinitycolor.co",
  api: "https://api.staging.infinitycolor.co/api",
  auth: "https://auth.staging.infinitycolor.co",
};

test("staging and local disposable stacks are allowed", () => {
  assert.deepEqual(checkTargets(STAGING), { ok: true });
  assert.deepEqual(
    checkTargets({ storefront: "http://localhost:2888", api: "http://127.0.0.1:1337/api", media: "https://media.infinitycolor.test" }),
    { ok: true },
  );
  assert.deepEqual(checkTargets({ api: "http://backend:1337/api" }, { allowHosts: "backend, build" }), { ok: true });
});

for (const url of [
  "https://infinitycolor.co",
  "https://www.infinitycolor.co/checkout",
  "https://api.infinitycolor.co/api",
  "https://auth.infinitycolor.co",
  "https://new.infinitycolor.co",
  "https://infinitygram.co",
]) {
  test(`production ${url} is refused, even when explicitly allowed`, () => {
    const host = new URL(url).hostname;
    const result = checkTargets({ ...STAGING, storefront: url }, { allowHosts: host });
    assert.equal(result.ok, false);
    assert.throws(() => assertSafeTargets({ storefront: url }, { allowHosts: host }), /production/);
  });
}

test("an unknown host needs an explicit allowance", () => {
  assert.equal(checkTargets({ api: "https://example.com/api" }).ok, false);
  assert.equal(checkTargets({ api: "not a url" }).ok, false);
  assert.equal(checkTargets({ api: "https://staging.infinitycolor.co.evil.example" }).ok, false);
});
