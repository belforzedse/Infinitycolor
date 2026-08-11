"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  addressFromOrder,
  parseArgs,
  resolveCity,
} = require("../../../backfill-woo-order-addresses");

test("targeted address-only mode is explicit and validates the Woo order id", () => {
  assert.deepEqual(
    parseArgs(["--apply", "--force", "--woo-order-id", "1281175", "--addresses-only"]),
    {
      apply: true,
      force: true,
      limit: null,
      batch: 100,
      pages: null,
      statuses: "completed,processing",
      wooOrderId: 1281175,
      addressesOnly: true,
    },
  );
  assert.throws(() => parseArgs(["--woo-order-id", "0"]), /positive integer/);
});

test("address extraction preserves the Woo recipient and normalizes Persian digits", () => {
  assert.deepEqual(addressFromOrder({
    shipping: {
      first_name: "زهرا",
      last_name: "محمدی",
      state: "abz",
      city: "کرج",
      address_1: "خیابان شهید بهشتی",
      address_2: "پلاک ۱۲",
      postcode: "۳۱۵۳۶۱۲۳۴۵",
    },
    billing: { phone: "۰۹۱۲۳۴۵۶۷۸۹" },
  }), {
    stateCode: "ABZ",
    cityTitle: "کرج",
    fullAddress: "خیابان شهید بهشتی — پلاک ۱۲",
    postalCode: "3153612345",
    recipientName: "زهرا محمدی",
    recipientPhone: "+989123456789",
  });
});

test("city resolution is scoped to the Woo province code", () => {
  const maps = {
    provinceByCode: new Map([["ABZ", { id: 5, title: "البرز" }]]),
    citiesByProvince: new Map([[5, new Map([["کرج", 31]])]]),
  };
  assert.deepEqual(resolveCity(maps, "abz", " كرج "), {
    ok: true,
    reason: "CITY_MATCH",
    province: { id: 5, title: "البرز" },
    cityId: 31,
  });
});
