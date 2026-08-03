"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../lib/transforms");

test("canonicalPhone normalizes Iranian digits and formats", () => {
  assert.equal(T.canonicalPhone("۰۹۱۲ ۳۴۵ ۶۷۸۹"), "+989123456789");
  assert.equal(T.canonicalPhone("0098-912-345-6789"), "+989123456789");
  assert.equal(T.canonicalPhone("not-a-phone"), null);
});

test("decimalToInteger converts toman to rial exactly without floating point", () => {
  assert.equal(T.decimalToInteger("123456789012345678", 10), "1234567890123456780");
  assert.equal(T.decimalToInteger("12.5", 10), "125");
  assert.throws(() => T.decimalToInteger("1.23", 10), /MONEY_NOT_EXACT/);
});

test("wallet balance extraction accepts the live TeraWallet response shape", () => {
  assert.equal(T.walletBalanceValue({ user_id: 12, balance_base: 345 }), 345);
  assert.equal(T.walletBalanceValue({ data: { balance: "12.5" } }), "12.5");
  assert.throws(() => T.walletBalanceValue({ user_id: 12 }), /WALLET_BALANCE_SHAPE_INVALID/);
});

test("customer payload excludes every address field and password", () => {
  const payload = T.customerPayload({
    id: 7,
    email: "USER@example.com",
    first_name: "نام",
    last_name: "خانوادگی",
    billing: { phone: "09123456789", address_1: "must-not-leak" },
    shipping: { address_1: "must-not-leak" },
  });
  assert.deepEqual(Object.keys(payload).sort(), ["email", "firstName", "lastName", "phone", "sourceId"]);
  assert.ok(!JSON.stringify(payload).includes("must-not-leak"));
});

test("customer payload preserves Woo creation and modification timestamps", () => {
  const payload = T.customerPayload({
    id: 7,
    billing: { phone: "09123456789" },
    date_created_gmt: "2019-01-02T03:04:05",
    date_modified_gmt: "2024-05-06T07:08:09",
  });
  assert.equal(payload.sourceCreatedAt, "2019-01-02T03:04:05.000Z");
  assert.equal(payload.sourceUpdatedAt, "2024-05-06T07:08:09.000Z");
});

test("order payload keeps approved core fields and excludes addresses, notes, and payment identifiers", () => {
  const payload = T.orderPayload({
    id: 44,
    customer_id: 0,
    date_created_gmt: "2026-01-02T03:04:05",
    status: "processing",
    total: "1000",
    shipping_total: "50",
    payment_method: "zarinpal",
    transaction_id: "must-not-leak",
    order_key: "must-not-leak",
    customer_note: "must-not-leak",
    billing: { phone: "09123456789", address_1: "must-not-leak" },
    shipping: { address_1: "must-not-leak" },
    line_items: [{ id: 9, product_id: 3, variation_id: 4, quantity: 2, price: "475", name: "کالا", sku: "S" }],
    shipping_lines: [{ method_id: "flat_rate", method_title: "پست" }],
  });
  assert.equal(payload.totalRial, "10000");
  assert.equal(payload.items[0].unitPriceRial, "4750");
  assert.equal(payload.paymentGateway, "ZarinPal");
  assert.equal(payload.contractType, "Cash");
  assert.equal(payload.taxPercent, 0);
  assert.equal(payload.sourceCreatedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(payload.sourceUpdatedAt, "2026-01-02T03:04:05.000Z");
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("must-not-leak"));
  assert.ok(!("billing" in payload));
  assert.ok(!("shipping" in payload));
});

test("SnappPay orders become credit contracts and non-zero tax is quarantined", () => {
  const base = {
    id: 45,
    customer_id: 0,
    date_created_gmt: "2026-01-02T03:04:05",
    date_modified_gmt: "2026-01-03T03:04:05",
    status: "completed",
    total: "1000",
    total_tax: "0",
    shipping_total: "0",
    payment_method: "WC_Gateway_SnappPay",
    billing: { phone: "09123456789" },
    line_items: [{ id: 10, product_id: 3, variation_id: 4, quantity: 1, price: "1000", name: "کالا" }],
  };
  assert.equal(T.orderPayload(base).contractType, "Credit");
  assert.throws(
    () => T.orderPayload({ ...base, total_tax: "9" }),
    /ORDER_NONZERO_TAX_REQUIRES_MAPPING/,
  );
});
