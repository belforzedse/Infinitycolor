"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RunLedger, loadRun } = require("../lib/ledger");

test("RunLedger uses a global exclusive lock and persists redacted identifiers only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-ledger-"));
  const first = new RunLedger(dir, "dry-run", "run-one").start();
  assert.throws(() => new RunLedger(dir, "pilot", "run-two").start(), /Another migration runner/);
  first.count("users", "source");
  first.failure("users", 123, "USER_PHONE_INVALID");
  first.issue("users", 456, "USER_PHONE_DUPLICATE");
  first.finish("completed-with-exceptions");
  const saved = loadRun(dir, "run-one");
  assert.equal(saved.entities.users.source, 1);
  assert.equal(saved.entities.users.failed, 1);
  assert.deepEqual(saved.failures, [
    { entity: "users", sourceId: "123", code: "USER_PHONE_INVALID" },
    { entity: "users", sourceId: "456", code: "USER_PHONE_DUPLICATE" },
  ]);
  assert.equal(fs.statSync(path.join(dir, "runs", "run-one", "summary.json")).mode & 0o077, 0);
});
