"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../lib/transforms");

test("canonicalPhone normalizes Iranian digits and formats", () => {
  assert.equal(T.canonicalPhone("۰۹۱۲ ۳۴۵ ۶۷۸۹"), "+989123456789");
  assert.equal(T.canonicalPhone("0098-912-345-6789"), "+989123456789");
  assert.equal(T.canonicalPhone("not-a-phone"), null);
});

test("canonicalPhone recovers numbers written with a stray leading +", () => {
  // A leading "+" used to survive the strip and match no prefix branch, so these
  // real numbers normalized to null and the customer was dropped entirely.
  assert.equal(T.canonicalPhone("+09123381098"), "+989123381098");
  assert.equal(T.canonicalPhone("+98 0912 338 1098"), "+989123381098");
  assert.equal(T.canonicalPhone("+989123381098"), "+989123381098");
  assert.equal(T.canonicalPhone("+9123381098"), "+989123381098");
});

test("canonicalPhone accepts every legacy storage shape for one number", () => {
  for (const shape of ["09123381098", "9123381098", "989123381098", "00989123381098", "+989123381098"]) {
    assert.equal(T.canonicalPhone(shape), "+989123381098", shape);
  }
});

test("canonicalPhone still rejects non-mobile and malformed values", () => {
  assert.equal(T.canonicalPhone("02112345678"), null, "landline");
  assert.equal(T.canonicalPhone("0912"), null, "too short");
  assert.equal(T.canonicalPhone("091233810980"), null, "too long");
  assert.equal(T.canonicalPhone(""), null);
  assert.equal(T.canonicalPhone(null), null);
  // 10 digits that are not a mobile NSN (national IDs are 10 digits too).
  assert.equal(T.canonicalPhone("0079542619"), null);
});

test("decimalToInteger converts toman to rial exactly without floating point", () => {
  assert.equal(T.decimalToInteger("123456789012345678", 10), "1234567890123456780");
  assert.equal(T.decimalToInteger("12.5", 10), "125");
  assert.throws(() => T.decimalToInteger("1.23", 10), /MONEY_NOT_EXACT/);
  assert.throws(() => T.decimalToInteger("1"), /MONEY_MULTIPLIER_INVALID/);
});

test("Woo order money remains Toman while wallet money converts to Rial", () => {
  assert.equal(T.wooMoneyToToman("1000"), "1000");
  assert.equal(T.wooMoneyToRial("1000"), "10000");
  assert.throws(() => T.wooMoneyToToman("12.5"), /MONEY_NOT_EXACT/);
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
    billing: {
      phone: "09123456789",
      email: "buyer@example.com",
      first_name: "نام",
      last_name: "خانوادگی",
      address_1: "must-not-leak",
    },
    shipping: { address_1: "must-not-leak" },
  });
  assert.deepEqual(Object.keys(payload).sort(), ["email", "firstName", "lastName", "phone", "sourceId"]);
  assert.ok(!JSON.stringify(payload).includes("must-not-leak"));
});

test("customer payload falls back to the login username when billing/shipping phone is empty", () => {
  const payload = T.customerPayload({
    id: 8,
    username: "9368954421",
    billing: {},
    shipping: {},
  });
  assert.equal(payload.phone, "+989368954421");
});

test("customer payload prefers the login username over a valid but different billing phone", () => {
  // The discriminating case: both fields are valid and disagree. The username is
  // the number the customer authenticates with; the billing number is checkout
  // form data that is routinely shared between accounts and therefore collides.
  const payload = T.customerPayload({
    id: 12,
    username: "9368954421",
    billing: { phone: "09123456789" },
    shipping: { phone: "09123381098" },
  });
  assert.equal(payload.phone, "+989368954421");
});

test("customer payload recovers a malformed billing phone instead of dropping the customer", () => {
  const payload = T.customerPayload({
    id: 10,
    username: "9120254536",
    billing: { phone: "+09120254536" },
    shipping: {},
  });
  assert.equal(payload.phone, "+989120254536");
});

test("customer payload takes the first field yielding a valid number, not the first non-empty one", () => {
  // A junk billing entry must not mask a good shipping number.
  const payload = T.customerPayload({
    id: 11,
    username: "shop_customer_11",
    billing: { phone: "-" },
    shipping: { phone: "09123381098" },
  });
  assert.equal(payload.phone, "+989123381098");
});

test("customer payload ignores a non-phone username and still requires billing/shipping phone", () => {
  assert.throws(
    () => T.customerPayload({ id: 9, username: "shop_customer_9", billing: {}, shipping: {} }),
    /USER_PHONE_INVALID/,
  );
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

test("a customer with no usable phone is excluded by decision, with a stable code", () => {
  assert.throws(
    () => T.customerPayload({ id: 5, username: "noreply", billing: { phone: "" }, shipping: {} }),
    (error) => error.message === "USER_PHONE_INVALID" && error.code === "USER_PHONE_INVALID" && error.outcome === "excluded",
  );
});

test("order payload keeps the approved delivery snapshot and excludes notes and payment identifiers", () => {
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
    billing: {
      phone: "09123456789",
      email: "buyer@example.com",
      first_name: "نام",
      last_name: "خانوادگی",
      phone: "09123456789",
    },
    shipping: {
      first_name: "زهرا",
      last_name: "محمدی",
      state: "abz",
      city: "کرج",
      address_1: "خیابان شهید بهشتی",
      address_2: "پلاک ۱۲",
      postcode: "۳۱۵۳۶۱۲۳۴۵",
    },
    line_items: [{ id: 9, product_id: 3, variation_id: 4, quantity: 2, price: "475", name: "کالا", sku: "S" }],
    shipping_lines: [{ method_id: "flat_rate", method_title: "پست" }],
  });
  assert.equal(payload.totalToman, "1000");
  assert.equal(payload.shippingToman, "50");
  assert.equal(payload.items[0].unitPriceToman, "475");
  assert.ok(!("totalRial" in payload));
  assert.ok(!("shippingRial" in payload));
  assert.ok(!("unitPriceRial" in payload.items[0]));
  assert.equal(payload.paymentGateway, "ZarinPal");
  assert.equal(payload.contractType, "Cash");
  assert.equal(payload.taxPercent, 0);
  assert.equal(payload.sourceCreatedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(payload.sourceUpdatedAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(payload.guestIdentity, {
    phone: "+989123456789",
    email: "buyer@example.com",
    firstName: "نام",
    lastName: "خانوادگی",
  });
  assert.deepEqual(payload.deliveryAddress, {
    stateCode: "ABZ",
    cityTitle: "کرج",
    fullAddress: "خیابان شهید بهشتی — پلاک ۱۲",
    postalCode: "3153612345",
    recipientName: "زهرا محمدی",
    recipientPhone: "+989123456789",
  });
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
