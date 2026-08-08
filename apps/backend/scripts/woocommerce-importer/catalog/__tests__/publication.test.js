"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  zonedLocalToUtcIso,
  resolvePublication,
  DEFAULT_TIMEZONE,
} = require("../lib/publication");

test("zonedLocalToUtcIso converts Asia/Tehran wall clock to UTC", () => {
  // Asia/Tehran is UTC+3:30 without DST since 2022.
  const iso = zonedLocalToUtcIso("2026-09-01", "12:00", "Asia/Tehran");
  assert.equal(iso, "2026-09-01T08:30:00.000Z");
});

test("resolvePublication publish-now maps WC publish to Active", () => {
  const result = resolvePublication({
    mode: "now",
    wcStatus: "publish",
    statusMappings: { publish: "Active", draft: "InActive" },
  });
  assert.equal(result.Status, "Active");
  assert.equal(result.scheduledPublishAt, null);
});

test("resolvePublication publish without statusMappings stays InActive", () => {
  const result = resolvePublication({
    mode: "now",
    wcStatus: "publish",
  });
  assert.equal(result.Status, "InActive");
});

test("resolvePublication draft stays InActive", () => {
  const result = resolvePublication({ mode: "draft" });
  assert.equal(result.Status, "InActive");
});

test("resolvePublication scheduled requires future instant with timezone", () => {
  const now = new Date("2026-08-08T10:00:00.000Z");
  const result = resolvePublication({
    mode: "scheduled",
    date: "2026-08-09",
    time: "15:30",
    timezone: "Asia/Tehran",
    now,
  });
  assert.equal(result.Status, "Scheduled");
  assert.equal(result.scheduledPublishTimezone, "Asia/Tehran");
  assert.equal(result.scheduledPublishAt, "2026-08-09T12:00:00.000Z");
});

test("resolvePublication rejects timezone-less at", () => {
  assert.throws(
    () => resolvePublication({ mode: "scheduled", at: "2026-08-09T12:00:00" }),
    /timezone offset/,
  );
});

test("resolvePublication rejects past schedule", () => {
  assert.throws(
    () =>
      resolvePublication({
        mode: "scheduled",
        at: "2020-01-01T00:00:00.000Z",
        timezone: DEFAULT_TIMEZONE,
        now: new Date("2026-08-08T00:00:00.000Z"),
      }),
    /future/,
  );
});

test("WC future status becomes Scheduled when date is in the future", () => {
  const result = resolvePublication({
    mode: "now",
    wcStatus: "future",
    wcDateGmt: "2026-12-01T10:00:00",
    now: new Date("2026-08-08T00:00:00.000Z"),
    statusMappings: { publish: "Active" },
  });
  assert.equal(result.Status, "Scheduled");
  assert.equal(result.scheduledPublishAt, "2026-12-01T10:00:00.000Z");
});

const { parsePublicationOptions, publicationFromEnv } = require("../lib/publication");

test("parsePublicationOptions returns null when mode omitted", () => {
  assert.equal(parsePublicationOptions({}), null);
});

test("parsePublicationOptions accepts scheduled date+time", () => {
  const result = parsePublicationOptions({
    mode: "scheduled",
    date: "2026-12-01",
    time: "12:00",
    timezone: "Asia/Tehran",
  });
  assert.equal(result.mode, "scheduled");
  assert.equal(result.timezone, "Asia/Tehran");
});

test("publicationFromEnv reads WOO_SYNC_PUBLICATION_*", () => {
  const result = publicationFromEnv({
    WOO_SYNC_PUBLICATION_MODE: "draft",
  });
  assert.equal(result.mode, "draft");
});
