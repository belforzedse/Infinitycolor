"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseArgs,
  resolveWindow,
  localDayToUtcInstant,
  summarizeSourceOrder,
  sumIntegerStrings,
  exactIntegerString,
  rialToToman,
  iterateWooOrders,
} = require("../reconcile-orders");

/**
 * The reconciliation report is read as evidence, so every population and every
 * money figure has to mean exactly one thing. These tests pin the window
 * arithmetic (a half-open Tehran day range), the exactness of the sums, and the
 * classification of the source-side populations.
 */

test("a Tehran day window resolves to the right UTC instants and is half-open", () => {
  const window = resolveWindow({ from: "2026-07-23", to: "2026-08-23", timezone: "Asia/Tehran" });
  assert.equal(window.startInclusive.toISOString(), "2026-07-22T20:30:00.000Z");
  assert.equal(window.endExclusive.toISOString(), "2026-08-22T20:30:00.000Z");
  assert.match(window.description, /Asia\/Tehran/);
  // UTC is its own control: the same days in UTC are midnight to midnight.
  const utc = resolveWindow({ from: "2026-07-23", to: "2026-08-23", timezone: "UTC" });
  assert.equal(utc.startInclusive.toISOString(), "2026-07-23T00:00:00.000Z");
  assert.equal(localDayToUtcInstant("2026-01-01", "UTC").toISOString(), "2026-01-01T00:00:00.000Z");
  assert.throws(() => localDayToUtcInstant("2026-1-1", "UTC"), /LOCAL_DAY_INVALID/);
});

test("window flags are validated together and never mixed with raw ISO filters", () => {
  assert.throws(() => parseArgs(["--dry-run", "--from", "2026-07-23"]), /together/);
  assert.throws(() => parseArgs(["--dry-run", "--from", "07-23-2026", "--to", "2026-08-23"]), /YYYY-MM-DD/);
  assert.throws(
    () => parseArgs(["--dry-run", "--from", "2026-07-23", "--to", "2026-08-23", "--after", "2026-07-23"]),
    /not both/,
  );
  assert.throws(() => parseArgs(["--dry-run", "--from", "2026-08-23", "--to", "2026-07-23"]), /must be after/);
  const options = parseArgs(["--dry-run", "--from", "2026-07-23", "--to", "2026-08-23"]);
  assert.equal(options.timezone, "Asia/Tehran", "the storefront's own zone is the default");
});

test("targeted selection flags parse into explicit id and failure-class lists", () => {
  const byIds = parseArgs(["--apply", "--ids", "1269185, 1276485 ,1273484", "--concurrency", "4"]);
  assert.deepEqual(byIds.ids, ["1269185", "1276485", "1273484"]);
  assert.equal(byIds.concurrency, 4);
  const byClass = parseArgs(["--dry-run", "--failure-class", "ORDER_ITEMS_EMPTY,ORDER_ITEM_PRODUCT_REFERENCE_INVALID"]);
  assert.deepEqual(byClass.failureClasses, ["ORDER_ITEMS_EMPTY", "ORDER_ITEM_PRODUCT_REFERENCE_INVALID"]);
  assert.throws(() => parseArgs(["--dry-run", "--ids", ""]), /at least one id/);
  assert.throws(() => parseArgs(["--dry-run", "--concurrency", "0"]), /between 1 and 16/);
  assert.throws(() => parseArgs(["--dry-run", "--concurrency", "17"]), /between 1 and 16/);
});

test("money sums stay exact past the float range and name their currency", () => {
  assert.equal(sumIntegerStrings(["9007199254740993", "1"]), "9007199254740994");
  assert.equal(sumIntegerStrings([]), "0");
  assert.equal(exactIntegerString("301960405360.00"), "301960405360");
  assert.throws(() => exactIntegerString("1.5", "CONTRACT_AMOUNT_NOT_INTEGER"), /CONTRACT_AMOUNT_NOT_INTEGER/);
  // The production liquidity figure: 30,196,040,536 Toman of settled cash.
  assert.deepEqual(rialToToman("301960405360"), { toman: "30196040536", remainderRial: "0", exact: true });
  // A sub-Toman remainder is surfaced rather than rounded away in silence.
  assert.deepEqual(rialToToman("15"), { toman: "1", remainderRial: "5", exact: false });
  assert.deepEqual(rialToToman("-20"), { toman: "-2", remainderRial: "0", exact: true });
});

test("source orders are classified into the populations the report names", () => {
  const orphaned = summarizeSourceOrder({
    id: 1269185,
    status: "completed",
    total: "450000",
    shipping_total: "40000",
    date_created_gmt: "2026-08-01T10:00:00",
    line_items: [
      { id: 1, product_id: 0, variation_id: 0, quantity: 1 },
      { id: 2, product_id: 5, variation_id: 6, quantity: 1 },
    ],
  });
  assert.equal(orphaned.orphanLineCount, 1);
  assert.equal(orphaned.lineCount, 2);
  assert.equal(orphaned.totalToman, "450000");
  assert.equal(orphaned.shippingToman, "40000");
  assert.equal(orphaned.expectedStatus, "Done");
  assert.equal(orphaned.isEmptyZeroTotal, false);

  const emptied = summarizeSourceOrder({ id: 1273484, status: "cancelled", total: "0", line_items: [] });
  assert.equal(emptied.isEmptyZeroTotal, true);
  assert.equal(emptied.isEmptyNonzeroTotal, false);
  assert.equal(emptied.expectedStatus, "Cancelled");

  const suspicious = summarizeSourceOrder({ id: 3, status: "completed", total: "250000", line_items: [] });
  assert.equal(suspicious.isEmptyNonzeroTotal, true);

  // One malformed total must not blind the rest of the reconciliation.
  const broken = summarizeSourceOrder({ id: 4, status: "completed", total: "12.5", line_items: [] });
  assert.equal(broken.totalToman, null);
  assert.match(broken.moneyIssue, /ORDER_TOTAL_UNPARSEABLE/);
});

test("window enumeration asks Woo for GMT dates and enforces the exact half-open range itself", async () => {
  const requests = [];
  const source = {
    woo: {
      async get(endpoint, params) {
        requests.push({ endpoint, params });
        return {
          data: [
            { id: 1, status: "completed", date_created_gmt: "2026-07-22T20:29:59" },
            { id: 2, status: "completed", date_created_gmt: "2026-07-22T20:30:00" },
            { id: 3, status: "completed", date_created_gmt: "2026-08-22T20:29:59" },
            { id: 4, status: "completed", date_created_gmt: "2026-08-22T20:30:00" },
          ],
          headers: { get: () => "1" },
        };
      },
    },
  };
  const seen = [];
  for await (const order of iterateWooOrders(source, {
    from: "2026-07-23",
    to: "2026-08-23",
    timezone: "Asia/Tehran",
    pageSize: 100,
  })) {
    seen.push(order.id);
  }
  // Woo's own `after`/`before` are widened by a second and are not trusted for
  // the boundary; the instant comparison decides membership.
  assert.deepEqual(seen, [2, 3]);
  assert.equal(requests[0].params.dates_are_gmt, true);
  assert.equal(requests[0].params.after, "2026-07-22T20:29:59.000Z");
  assert.equal(requests[0].params.before, "2026-08-22T20:30:01.000Z");
  assert.match(requests[0].params._fields, /line_items/);
});
