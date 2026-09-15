"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../lib/transforms");

test("wallet balance rounds TeraWallet IEEE float toman to integer Rial", () => {
  assert.equal(T.wooWalletBalanceToRial("690818999.9999999"), "6908190000");
  assert.equal(T.wooWalletBalanceToRial(690818999.9999999), "6908190000");
  assert.equal(T.wooWalletBalanceToRial("1000"), "10000");
  assert.equal(
    T.walletPayload({ id: 12, balance: 690818999.9999999 }).balanceRial,
    "6908190000",
  );
});

test("order line money stays exact and never uses wallet rounding", () => {
  assert.throws(() => T.wooMoneyToToman("12.5"), /MONEY_NOT_EXACT/);
  assert.equal(T.lineUnitPriceToman({ total: "2398000", price: "1199000.1", quantity: 2 }, 2), "1199000");
  assert.equal(T.lineUnitPriceToman({ total: "1199000", price: "1199000", quantity: 1 }, 1), "1199000");
});

test("orderPayload prefers exact line totals when price is a noisy float", () => {
  const payload = T.orderPayload({
    id: 99,
    customer_id: 0,
    date_created_gmt: "2026-01-02T03:04:05",
    status: "completed",
    total: "2398000",
    shipping_total: "0",
    total_tax: "0",
    payment_method: "cod",
    billing: { phone: "09123456789" },
    line_items: [{
      id: 1,
      product_id: 3,
      variation_id: 4,
      quantity: 2,
      price: 1199000.0000001,
      total: "2398000",
      name: "کالا",
    }],
  });
  assert.equal(payload.items[0].unitPriceToman, "1199000");
  assert.equal(payload.status, "Done");
});

const PAID_ORDER = {
  id: 1222924,
  customer_id: 7,
  created_via: "checkout",
  date_created_gmt: "2026-07-01T08:00:00",
  date_paid_gmt: "2026-07-01T20:45:00",
  status: "completed",
  total: "813000",
  shipping_total: "115000",
  total_tax: "0",
  payment_method: "WC_Gateway_SnappPay",
  transaction_id: "ref-1",
  billing: { phone: "09123456789" },
  line_items: [{ id: 1, product_id: 3, variation_id: 4, quantity: 1, price: "12694000", total: "12694000", name: "کالا" }],
  fee_lines: [{ id: 9, name: "با کیف پول", total: "-11996000" }],
};

test("signed fee money accepts a leading minus and keeps totals strict", () => {
  assert.equal(T.signedWooMoneyToToman("-11996000"), "-11996000");
  assert.equal(T.signedWooMoneyToToman("-0"), "0");
  assert.equal(T.signedWooMoneyToToman("5000"), "5000");
  assert.throws(() => T.wooMoneyToToman("-1"), /MONEY_FORMAT_INVALID/);
});

test("fee lines split into the wallet leg, the payment-method discount and the rest", () => {
  assert.deepEqual(T.classifyFeeLines({ fee_lines: [
    { name: "با کیف پول", total: "-11996000" },
    { name: "تخفیف پرداخت با اسنپ‌پی", total: "-1000000" },
    { name: "تخفیف ویژه", total: "-5000" },
    { name: "بسته‌بندی", total: "20000" },
    { name: "خالی", total: "0" },
  ] }), { walletLeg: "11996000", paymentMethodDiscount: "1000000", otherDiscount: "5000", surcharge: "20000" });
  assert.deepEqual(T.classifyFeeLines({}), { walletLeg: "0", paymentMethodDiscount: "0", otherDiscount: "0", surcharge: "0" });
});

test("a wallet + gateway split order carries the full sales value and two settlement legs", () => {
  const payload = T.orderPayload(PAID_ORDER);
  assert.equal(payload.totalToman, "813000");
  assert.equal(payload.salesValueToman, "12809000"); // lines + shipping
  assert.equal(payload.appliedDiscountToman, "0");
  assert.equal(payload.paidAt, "2026-07-01T20:45:00.000Z");
  assert.equal(payload.hasGatewayReference, true);
  assert.equal(payload.createdVia, "checkout");
  assert.deepEqual(payload.settlements, [
    { leg: "gateway", channel: "SnappPay", amountToman: "813000", date: "2026-07-01T20:45:00.000Z" },
    { leg: "wallet", channel: "Wallet", amountToman: "11996000", date: "2026-07-01T20:45:00.000Z" },
  ]);
  assert.ok(!JSON.stringify(payload).includes("ref-1"));
});

test("the SnappPay promotion is a payment-method discount, not a wallet leg", () => {
  const payload = T.orderPayload({
    ...PAID_ORDER,
    total: "5000000",
    shipping_total: "0",
    line_items: [{ id: 1, product_id: 3, variation_id: 4, quantity: 1, price: "6000000", total: "6000000", name: "کالا" }],
    fee_lines: [{ id: 9, name: "تخفیف پرداخت با اسنپ‌پی", total: "-1000000" }],
  });
  assert.equal(payload.salesValueToman, "5000000");
  assert.equal(payload.appliedDiscountToman, "1000000");
  assert.deepEqual(payload.settlements.map((leg) => [leg.leg, leg.channel, leg.amountToman]), [
    ["gateway", "SnappPay", "5000000"],
  ]);
});

test("a paid order on an online gateway with no gateway reference was settled off-gateway", () => {
  const payload = T.orderPayload({ ...PAID_ORDER, payment_method: "pa_behpardakht", transaction_id: "", fee_lines: [] });
  assert.equal(payload.paymentGateway, "Mellat");
  assert.equal(payload.hasGatewayReference, false);
  assert.deepEqual(payload.settlements, [
    { leg: "gateway", channel: "OffGateway", amountToman: "813000", date: "2026-07-01T20:45:00.000Z" },
  ]);
});

test("a pre-Payzito SnappPay order never carries a reference and stays credited to SnappPay", () => {
  // Until 2026-05-20 the store used WC_Gateway_SnappPay, which wrote no
  // transaction_id; 2,185 such paid orders must not read as off-gateway.
  const payload = T.orderPayload({ ...PAID_ORDER, payment_method: "WC_Gateway_SnappPay", transaction_id: "", fee_lines: [] });
  assert.equal(payload.hasGatewayReference, false);
  assert.deepEqual(payload.settlements.map((leg) => leg.channel), ["SnappPay"]);
  const payzito = T.orderPayload({ ...PAID_ORDER, payment_method: "pa_snapppay", transaction_id: "", fee_lines: [] });
  assert.deepEqual(payzito.settlements.map((leg) => leg.channel), ["OffGateway"]);
});

test("unpaid, cancelled and failed orders have no settlement legs; paid date falls back to the order date", () => {
  for (const status of ["pending", "on-hold", "cancelled", "failed"]) {
    assert.deepEqual(T.orderPayload({ ...PAID_ORDER, status }).settlements, [], status);
  }
  const noPaidDate = T.orderPayload({ ...PAID_ORDER, status: "processing", date_paid_gmt: null, fee_lines: [] });
  assert.equal(noPaidDate.paidAt, "2026-07-01T08:00:00.000Z");
  assert.equal(noPaidDate.settlements[0].date, "2026-07-01T08:00:00.000Z");
});

test("a refunded order keeps its legs and adds a return leg", () => {
  const payload = T.orderPayload({
    ...PAID_ORDER,
    status: "refunded",
    fee_lines: [],
    refunds: [{ id: 5, total: "-813000" }],
  });
  assert.equal(payload.status, "Returned");
  assert.deepEqual(payload.settlements.map((leg) => [leg.leg, leg.channel, leg.amountToman]), [
    ["gateway", "SnappPay", "813000"],
    ["return", "SnappPay", "813000"],
  ]);
  const whole = T.orderPayload({ ...PAID_ORDER, status: "refunded", fee_lines: [] });
  assert.equal(whole.settlements[1].amountToman, "813000");
});

test("admin-created orders without a method are Manual, offline methods get their own labels", () => {
  assert.equal(T.paymentGateway("", "", { createdVia: "admin" }), "Manual");
  assert.equal(T.paymentGateway("", "", { createdVia: "checkout" }), "Unknown");
  assert.equal(T.paymentGateway(undefined, undefined), "Unknown");
  assert.equal(T.paymentGateway("shetab", "کارت به کارت"), "CardToCard");
  assert.equal(T.paymentGateway("cod", "پرداخت در محل"), "Other");
  assert.equal(T.paymentGateway("pa_behpardakht", ""), "Mellat");
  assert.equal(T.orderPayload({ ...PAID_ORDER, created_via: "admin", payment_method: "", payment_method_title: "", fee_lines: [] }).paymentGateway, "Manual");
  assert.deepEqual(
    T.orderPayload({ ...PAID_ORDER, created_via: "admin", payment_method: "", payment_method_title: "", fee_lines: [] }).settlements,
    [{ leg: "gateway", channel: "Manual", amountToman: "813000", date: "2026-07-01T20:45:00.000Z" }],
  );
});
