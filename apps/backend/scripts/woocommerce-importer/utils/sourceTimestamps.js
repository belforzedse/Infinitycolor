"use strict";

const SOURCE_CREATED_AT_HEADER = "X-Infinity-Source-Created-At";
const SOURCE_UPDATED_AT_HEADER = "X-Infinity-Source-Updated-At";

function parseTimestamp(value, { assumeUtc = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("0000-00-00")) return null;

  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (!assumeUtc && !hasZone) return null;
  const parsed = new Date(assumeUtc && !hasZone ? `${raw}Z` : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildSourceTimestamps(createdAt, updatedAt) {
  if (!createdAt) return null;
  const effectiveUpdatedAt = updatedAt || createdAt;
  if (new Date(effectiveUpdatedAt).getTime() < new Date(createdAt).getTime()) {
    throw new Error("SOURCE_UPDATED_BEFORE_CREATED");
  }
  return { createdAt, updatedAt: effectiveUpdatedAt };
}

function wooSourceTimestamps(entity) {
  const createdAt =
    parseTimestamp(entity?.date_created_gmt, { assumeUtc: true }) ||
    parseTimestamp(entity?.date_created);
  const updatedAt =
    parseTimestamp(entity?.date_modified_gmt, { assumeUtc: true }) ||
    parseTimestamp(entity?.date_modified);
  return buildSourceTimestamps(createdAt, updatedAt);
}

function wordpressSourceTimestamps(entity) {
  const createdAt =
    parseTimestamp(entity?.date_gmt, { assumeUtc: true }) ||
    parseTimestamp(entity?.registered_date, { assumeUtc: true }) ||
    parseTimestamp(entity?.date);
  const updatedAt =
    parseTimestamp(entity?.modified_gmt, { assumeUtc: true }) ||
    parseTimestamp(entity?.modified);
  return buildSourceTimestamps(createdAt, updatedAt);
}

function sourceTimestampHeaders(timestamps) {
  if (!timestamps) return {};
  return {
    [SOURCE_CREATED_AT_HEADER]: timestamps.createdAt,
    [SOURCE_UPDATED_AT_HEADER]: timestamps.updatedAt,
  };
}

module.exports = {
  SOURCE_CREATED_AT_HEADER,
  SOURCE_UPDATED_AT_HEADER,
  parseTimestamp,
  buildSourceTimestamps,
  wooSourceTimestamps,
  wordpressSourceTimestamps,
  sourceTimestampHeaders,
};
