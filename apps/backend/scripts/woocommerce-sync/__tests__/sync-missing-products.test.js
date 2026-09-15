"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  APPLY_CONFIRMATION,
  buildDiff,
  parseArgs,
  parseIdList,
  selectMissingIds,
  installZeroStockOverride,
} = require("../sync-missing-products");

test("parseIdList accepts numeric ids and removes duplicates", () => {
  assert.deepEqual(parseIdList("12, 34,12"), ["12", "34"]);
  assert.throws(() => parseIdList("12,nope"), /numeric WooCommerce ids/);
});

test("apply is explicit, mutually exclusive and confirmation-gated", () => {
  assert.throws(() => parseArgs(["apply", "--ids", "12"]), /requires --confirm/);
  assert.throws(
    () => parseArgs([
      "apply", "--ids", "12", "--all-missing", "--confirm", APPLY_CONFIRMATION,
    ]),
    /exactly one/,
  );
  assert.deepEqual(
    parseArgs(["apply", "--ids", "12,34", "--confirm", APPLY_CONFIRMATION]),
    {
      command: "apply",
      options: {
        status: "any",
        ids: ["12", "34"],
        allMissing: false,
        confirm: APPLY_CONFIRMATION,
        unmanagedStock: null,
      },
    },
  );
  assert.equal(
    parseArgs([
      "apply", "--all-missing", "--unmanaged-stock", "zero",
      "--confirm", APPLY_CONFIRMATION,
    ]).options.unmanagedStock,
    "zero",
  );
  assert.throws(
    () => parseArgs([
      "apply", "--all-missing", "--unmanaged-stock", "9999",
      "--confirm", APPLY_CONFIRMATION,
    ]),
    /only supports zero/,
  );
});

test("buildDiff compares only Woo external identity", () => {
  const diff = buildDiff(
    [
      { id: 10, name: "ten", status: "publish" },
      { id: 20, name: "twenty", status: "publish" },
    ],
    [
      { id: 1, attributes: { external_id: "20" } },
      { id: 2, attributes: { external_id: "30" } },
    ],
  );
  assert.deepEqual(diff.missing.map((row) => row.id), ["10"]);
  assert.deepEqual(diff.appOnly, ["30"]);
  assert.equal(diff.sourceCount, 2);
  assert.equal(diff.appWooCount, 2);
});

test("selected ids must belong to the fresh missing snapshot", () => {
  const diff = { missing: [{ id: "10" }, { id: "20" }] };
  assert.deepEqual(selectMissingIds(diff, { ids: ["20"], allMissing: false }), ["20"]);
  assert.deepEqual(selectMissingIds(diff, { ids: null, allMissing: true }), ["10", "20"]);
  assert.throws(
    () => selectMissingIds(diff, { ids: ["30"], allMissing: false }),
    /not currently missing: 30/,
  );
});

test("zero-stock override is process-local and restores normal transforms", () => {
  const transforms = require("../../woocommerce-importer/catalog/lib/transforms");
  const originalEligibility = transforms.evaluateProductStockEligibility;
  const originalMapStock = transforms.mapStock;
  const restore = installZeroStockOverride();
  assert.equal(
    transforms.evaluateProductStockEligibility({ manage_stock: false }, []).eligible,
    true,
  );
  assert.equal(
    transforms.mapStock({ id: 7, manage_stock: false, stock_quantity: null }).count,
    0,
  );
  restore();
  assert.equal(transforms.evaluateProductStockEligibility, originalEligibility);
  assert.equal(transforms.mapStock, originalMapStock);
});
