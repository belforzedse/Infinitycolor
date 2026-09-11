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
