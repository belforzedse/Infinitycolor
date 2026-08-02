"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scanUsers, scanWallets, scanOrders, limitPages } = require("../dry-run");
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

test("sample page limiter yields exactly the requested number of rows", async () => {
  async function* pages() {
    yield { page: 1, rows: [{ id: 1 }, { id: 2 }] };
    yield { page: 2, rows: [{ id: 3 }, { id: 4 }] };
  }
  const rows = [];
  for await (const page of limitPages(pages(), 3)) rows.push(...page.rows);
  assert.deepEqual(rows.map((row) => row.id), [1, 2, 3]);
});

test("bounded wallet sampling stops at the row limit and records outside-user exclusions", async () => {
  const source = {
    async *walletUsers() {
      yield { page: 1, rows: [{ id: 2, balance: "0" }, { id: 3, balance: "0" }] };
      yield { page: 2, rows: [{ id: 4, balance: "0" }] };
    },
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-wallet-sample-"));
  const ledger = new RunLedger(stateDir, "dry-run", "wallets").start();
  ledger.summary.sample = {
    exclusions: { walletUserOutsideCustomerSample: 0 },
  };
  try {
    await scanWallets(
      source,
      { walletsByUserSource: emptyIndex() },
      { validUserIds: new Set(["1"]), sampledUserIds: new Set(["1"]) },
      ledger,
      2,
    );
    assert.equal(ledger.summary.entities.wallets.source, 2);
    assert.equal(ledger.summary.entities.wallets.skipped, 2);
    assert.equal(ledger.summary.sample.exclusions.walletUserOutsideCustomerSample, 2);
  } finally {
    ledger.release();
  }
});

test("bounded order sampling separates dependency exclusions from malformed rows", async () => {
  const source = {
    async *orders() {
      yield {
        page: 1,
        rows: [
          {
            id: 10,
            customer_id: 200,
            date_created: "2026-01-01T00:00:00",
            total: "1",
            shipping_total: "0",
            line_items: [{ id: 1, quantity: 1, product_id: 300, price: "1" }],
          },
          {
            id: 11,
            customer_id: 0,
            date_created: "2026-01-01T00:00:00",
            total: "1",
            shipping_total: "0",
            line_items: [{ id: 2, quantity: 1, product_id: 0, price: "1" }],
          },
        ],
      };
      yield { page: 2, rows: [{ id: 12 }] };
    },
  };
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-order-sample-"));
  const ledger = new RunLedger(stateDir, "dry-run", "orders").start();
  ledger.summary.sample = {
    exclusions: { orderCustomerOutsideSample: 0, orderProductOutsideSample: 0 },
  };
  try {
    await scanOrders(
      source,
      { ordersBySource: emptyIndex() },
      {
        validUserIds: new Set(),
        sampledUserIds: new Set(),
        duplicatePhones: new Set(),
        phoneOwners: new Map(),
      },
      {
        eligibleVariationIds: new Set(),
        sampledVariationIds: new Set(),
        pilotVariationIds: new Set(),
      },
      ledger,
      2,
    );
    assert.equal(ledger.summary.entities.orders.source, 2);
    assert.equal(ledger.summary.entities.orders.skipped, 1);
    assert.equal(ledger.summary.entities.orders.failed, 1);
    assert.equal(ledger.summary.sample.exclusions.orderCustomerOutsideSample, 1);
    assert.equal(ledger.summary.sample.exclusions.orderProductOutsideSample, 1);
    assert.equal(ledger.summary.failures[0].code, "ORDER_ITEM_PRODUCT_REFERENCE_INVALID");
  } finally {
    ledger.release();
  }
});
