"use strict";

/**
 * Publication mode helpers for catalog import.
 * Prefer Asia/Tehran when callers omit an explicit timezone.
 */

const DEFAULT_TIMEZONE = "Asia/Tehran";

/**
 * @param {string} timeZone
 */
function assertValidTimeZone(timeZone) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${timeZone}`);
  }
}

/**
 * Convert a local wall-clock date+time in an IANA timezone to a UTC ISO string.
 * @param {string} date YYYY-MM-DD
 * @param {string} time HH:mm or HH:mm:ss
 * @param {string} timeZone
 * @returns {string} UTC ISO instant
 */
function zonedLocalToUtcIso(date, time, timeZone) {
  assertValidTimeZone(timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date: ${date}`);
  }
  const timeMatch = String(time).match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!timeMatch) throw new Error(`Invalid time: ${time}`);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] || "0");
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`Invalid time: ${time}`);

  const [year, month, day] = date.split("-").map(Number);
  // Initial UTC guess as if the local components were UTC, then correct using the zone offset.
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(utcMs))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    utcMs += desired - asUtc;
  }

  const resolved = new Date(utcMs);
  // Validate the wall clock round-trips (rejects impossible local times like 2026-03-22 02:30 in DST gaps).
  const check = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(resolved)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const localStamp = `${check.year}-${check.month}-${check.day}T${check.hour}:${check.minute}:${check.second}`;
  const wanted = `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  if (localStamp !== wanted) {
    throw new Error(`Impossible local datetime ${wanted} in timezone ${timeZone}`);
  }
  return resolved.toISOString();
}

/**
 * @param {object} opts
 * @param {"now"|"draft"|"scheduled"} [opts.mode]
 * @param {string} [opts.date]
 * @param {string} [opts.time]
 * @param {string} [opts.timezone]
 * @param {string} [opts.at] ISO instant (must include offset/Z)
 * @param {Date|number} [opts.now]
 * @param {string} [opts.wcStatus] WooCommerce product status
 * @param {Record<string,string>} [opts.statusMappings]
 */
function resolvePublication(opts = {}) {
  const mode = opts.mode || "now";
  const now = opts.now ? new Date(opts.now) : new Date();
  const statusMappings = opts.statusMappings || {};
  const timezone = opts.timezone || DEFAULT_TIMEZONE;

  if (mode === "draft") {
    return {
      Status: "InActive",
      scheduledPublishAt: null,
      scheduledPublishTimezone: null,
      scheduledPublishRequireMedia: false,
      scheduledPublishLastError: null,
    };
  }

  if (mode === "scheduled") {
    assertValidTimeZone(timezone);
    let atIso;
    if (opts.at) {
      if (!/(Z|[+-]\d{2}:\d{2})$/.test(String(opts.at))) {
        throw new Error("scheduled at must include an explicit timezone offset or Z");
      }
      atIso = new Date(opts.at).toISOString();
      if (Number.isNaN(Date.parse(atIso))) throw new Error(`Invalid scheduled at: ${opts.at}`);
    } else if (opts.date && opts.time) {
      atIso = zonedLocalToUtcIso(opts.date, opts.time, timezone);
    } else {
      throw new Error("scheduled mode requires date+time+timezone or an offset-aware at instant");
    }
    if (Date.parse(atIso) <= now.getTime()) {
      throw new Error("scheduledPublishAt must be in the future");
    }
    return {
      Status: "Scheduled",
      scheduledPublishAt: atIso,
      scheduledPublishTimezone: timezone,
      scheduledPublishRequireMedia: opts.requireMedia !== false,
      scheduledPublishLastError: null,
      scheduledPublishLastAttemptAt: null,
    };
  }

  // mode === "now" — preserve WC status mapping (publish→Active, draft→InActive).
  // WooCommerce "future" maps to Scheduled when date_created_gmt/date is in the future.
  const wcStatus = opts.wcStatus;
  if (wcStatus === "future" || (wcStatus && !statusMappings[wcStatus] && wcStatus === "future")) {
    // handled below
  }
  if (wcStatus === "future") {
    const raw = opts.wcDateGmt || opts.wcDate;
    if (raw) {
      const instant = new Date(String(raw).endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(String(raw)) ? raw : `${raw}Z`);
      if (!Number.isNaN(instant.getTime()) && instant.getTime() > now.getTime()) {
        return {
          Status: "Scheduled",
          scheduledPublishAt: instant.toISOString(),
          scheduledPublishTimezone: timezone,
          scheduledPublishRequireMedia: opts.requireMedia !== false,
          scheduledPublishLastError: null,
          scheduledPublishLastAttemptAt: null,
        };
      }
    }
  }

  const mapped = statusMappings[wcStatus] || "InActive";
  return {
    Status: mapped,
    scheduledPublishAt: null,
    scheduledPublishTimezone: null,
    scheduledPublishRequireMedia: false,
    scheduledPublishLastError: null,
    scheduledPublishLastAttemptAt: null,
  };
}

/**
 * Parse publication options from CLI flags / env-style key bags.
 * Accepts camelCase or kebab-case keys.
 *
 * @param {Record<string, unknown>} raw
 * @returns {{ mode: "now"|"draft"|"scheduled", date?: string, time?: string, timezone?: string, at?: string, requireMedia?: boolean } | null}
 */
function parsePublicationOptions(raw = {}) {
  const modeRaw = raw.publication || raw.mode || raw["publication-mode"] || raw.publicationMode;
  if (modeRaw === undefined || modeRaw === null || String(modeRaw).trim() === "") {
    return null;
  }
  const mode = String(modeRaw).trim().toLowerCase();
  if (!["now", "draft", "scheduled"].includes(mode)) {
    throw new Error(`Invalid publication mode: ${modeRaw}. Use now|draft|scheduled`);
  }

  const pick = (...keys) => {
    for (const key of keys) {
      const value = raw[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") {
        return String(value).trim();
      }
    }
    return undefined;
  };

  const requireMediaRaw = raw.requireMedia ?? raw["require-media"] ?? raw.publicationRequireMedia;
  let requireMedia;
  if (requireMediaRaw !== undefined && requireMediaRaw !== null && String(requireMediaRaw).trim() !== "") {
    const normalized = String(requireMediaRaw).trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(normalized)) requireMedia = true;
    else if (["0", "false", "no", "n"].includes(normalized)) requireMedia = false;
    else throw new Error(`Invalid require-media value: ${requireMediaRaw}`);
  }

  const publication = {
    mode,
    date: pick("date", "publication-date", "publicationDate"),
    time: pick("time", "publication-time", "publicationTime"),
    timezone: pick("timezone", "tz", "publication-timezone", "publicationTimezone") || DEFAULT_TIMEZONE,
    at: pick("at", "publication-at", "publicationAt"),
  };
  if (requireMedia !== undefined) publication.requireMedia = requireMedia;

  // Validate early so CLI fails before a long sync starts.
  resolvePublication({ ...publication, now: new Date() });
  return publication;
}

/**
 * Read publication options from process.env (woocommerce-sync service).
 * @param {NodeJS.ProcessEnv} [env]
 */
function publicationFromEnv(env = process.env) {
  return parsePublicationOptions({
    mode: env.WOO_SYNC_PUBLICATION_MODE || env.IMPORT_PUBLICATION_MODE,
    at: env.WOO_SYNC_PUBLICATION_AT || env.IMPORT_PUBLICATION_AT,
    date: env.WOO_SYNC_PUBLICATION_DATE || env.IMPORT_PUBLICATION_DATE,
    time: env.WOO_SYNC_PUBLICATION_TIME || env.IMPORT_PUBLICATION_TIME,
    timezone: env.WOO_SYNC_PUBLICATION_TIMEZONE || env.IMPORT_PUBLICATION_TIMEZONE,
    requireMedia: env.WOO_SYNC_PUBLICATION_REQUIRE_MEDIA || env.IMPORT_PUBLICATION_REQUIRE_MEDIA,
  });
}

module.exports = {
  DEFAULT_TIMEZONE,
  assertValidTimeZone,
  zonedLocalToUtcIso,
  resolvePublication,
  parsePublicationOptions,
  publicationFromEnv,
};
