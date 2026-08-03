"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseTimestamp,
  wooSourceTimestamps,
  wordpressSourceTimestamps,
  sourceTimestampHeaders,
} = require("../sourceTimestamps");

test("Woo timestamps prefer GMT and preserve the source modification instant", () => {
  const result = wooSourceTimestamps({
    date_created: "2020-01-01T07:30:00",
    date_created_gmt: "2020-01-01T04:00:00",
    date_modified_gmt: "2024-02-03T05:06:07",
  });
  assert.deepEqual(result, {
    createdAt: "2020-01-01T04:00:00.000Z",
    updatedAt: "2024-02-03T05:06:07.000Z",
  });
});

test("WordPress timestamps preserve post dates and user registration dates", () => {
  assert.deepEqual(wordpressSourceTimestamps({
    date_gmt: "2021-02-03T04:05:06",
    modified_gmt: "2022-03-04T05:06:07",
  }), {
    createdAt: "2021-02-03T04:05:06.000Z",
    updatedAt: "2022-03-04T05:06:07.000Z",
  });
  assert.deepEqual(wordpressSourceTimestamps({ registered_date: "2019-08-09T10:11:12" }), {
    createdAt: "2019-08-09T10:11:12.000Z",
    updatedAt: "2019-08-09T10:11:12.000Z",
  });
});

test("never assumes a timezone for a non-GMT source field", () => {
  assert.equal(parseTimestamp("2026-01-01T00:00:00"), null);
  assert.equal(parseTimestamp("2026-01-01T00:00:00+03:30"), "2025-12-31T20:30:00.000Z");
});

test("rejects source modification timestamps before creation", () => {
  assert.throws(() => wooSourceTimestamps({
    date_created_gmt: "2026-01-02T00:00:00",
    date_modified_gmt: "2026-01-01T00:00:00",
  }), /SOURCE_UPDATED_BEFORE_CREATED/);
});

test("builds migration headers only when source timestamps exist", () => {
  assert.deepEqual(sourceTimestampHeaders(null), {});
  assert.deepEqual(sourceTimestampHeaders({
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-02-01T00:00:00.000Z",
  }), {
    "X-Infinity-Source-Created-At": "2020-01-01T00:00:00.000Z",
    "X-Infinity-Source-Updated-At": "2020-02-01T00:00:00.000Z",
  });
});
