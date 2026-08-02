"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanUsers } = require("../dry-run");
const { RunLedger } = require("../lib/ledger");

const emptyIndex = () => ({ map: new Map(), duplicates: new Set() });

test("user dry-run quarantines both owners of a duplicate phone", async () => {
  const source = {
    async *customers() {
      yield {
        page: 1,
        rows: [
          { id: 1, email: "one@example.com", billing: { phone: "09120000001" } },
          { id: 2, email: "two@example.com", billing: { phone: "09120000001" } },
          { id: 3, email: "three@example.com", billing: { phone: "09120000003" } },
        ],
      };
    },
  };
  const destinationIndexes = {
    usersBySource: emptyIndex(),
    usersByPhone: emptyIndex(),
    usersByEmail: emptyIndex(),
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-dry-run-"));
  const ledger = new RunLedger(stateDir, "dry-run", "users").start();
  try {
    const result = await scanUsers(source, destinationIndexes, ledger);
    assert.deepEqual(Array.from(result.validUserIds), ["3"]);
    assert.equal(ledger.summary.entities.users.source, 3);
    assert.equal(ledger.summary.entities.users.eligible, 1);
    assert.equal(ledger.summary.entities.users.inserted, 1);
    assert.equal(ledger.summary.entities.users.failed, 2);
    assert.deepEqual(
      ledger.summary.failures.map((failure) => [failure.sourceId, failure.code]),
      [["1", "USER_DUPLICATE_PHONE"], ["2", "USER_DUPLICATE_PHONE"]],
    );
  } finally {
    ledger.release();
  }
});
