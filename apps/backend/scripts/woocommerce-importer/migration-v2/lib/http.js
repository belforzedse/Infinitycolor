"use strict";

const { setTimeout: delay } = require("node:timers/promises");

/**
 * Transport-level failures worth retrying.
 *
 * Node's `fetch` does not surface these the way axios does: it throws a bare
 * `TypeError: fetch failed` and puts the real reason on `error.cause.code`.
 * The retry predicate below used to test only `error.status`, so every one of
 * these fell straight through the retry loop on the first attempt. On
 * 2026-09-12 a ~10s DNS blip (EAI_AGAIN, then UND_ERR_CONNECT_TIMEOUT
 * reaching the source) killed a 5-hour unattended campaign 65 minutes in,
 * because the rejection escaped `source.js#pagesParallel` and nothing above it
 * catches.
 *
 * A sibling list lives in `catalog/lib/backoff.js`, which is axios-shaped and
 * therefore never sees the `UND_ERR_*` codes; unifying the two is a separate
 * refactor, so this set is deliberately the superset of both.
 */
const RETRYABLE_NETWORK_CODES = new Set([
  // POSIX / Node socket errors
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // undici (the engine behind global fetch)
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Walk the `cause` chain looking for a recognised transport code.
 *
 * Depth-capped because a self-referential `cause` would otherwise hang, and
 * `AggregateError.errors` is inspected too: on a dual-stack host Node reports a
 * failed connect as an aggregate whose children carry the code, not the parent.
 *
 * Only *recognised* codes retry. A `TypeError: fetch failed` carrying no known
 * code is far more likely to be a malformed URL from our own caller than a
 * blip, and looping on that just delays a real bug by 30 seconds.
 */
function isRetryableNetworkError(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (typeof current.code === "string" && RETRYABLE_NETWORK_CODES.has(current.code)) return true;
    for (const nested of Array.isArray(current.errors) ? current.errors : []) {
      if (typeof nested?.code === "string" && RETRYABLE_NETWORK_CODES.has(nested.code)) return true;
    }
  }
  return false;
}

class JsonHttp {
  // retries=6 with the capped backoff below is ~30s of budget. The 4 it used to
  // be gave ~7.5s, which is shorter than an ordinary DNS or upstream-restart
  // blip and is what made the campaign crash survivable-in-principle but not in
  // practice. Retrying writes is safe and intentional: the importer's writes are
  // idempotent upserts keyed on `external_id`.
  constructor({ baseUrl, headers, sourceReadOnly = false, retries = 6, timeoutMs = 30_000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.headers = { ...headers };
    this.sourceReadOnly = sourceReadOnly;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.metrics = { requests: 0, retries: 0, totalMs: 0, slowestMs: 0, failures: 0 };
  }

  async request(method, pathname, { query, body, headers } = {}) {
    const normalizedMethod = String(method).toUpperCase();
    if (this.sourceReadOnly && !["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) {
      throw new Error(`SOURCE_WRITE_BLOCKED:${normalizedMethod}`);
    }
    const url = new URL(`${this.baseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const started = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        this.metrics.requests += 1;
        const response = await fetch(url, {
          method: normalizedMethod,
          headers: {
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...this.headers,
            ...(headers || {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        const elapsed = Date.now() - started;
        this.metrics.totalMs += elapsed;
        this.metrics.slowestMs = Math.max(this.metrics.slowestMs, elapsed);
        const responseText = await response.text();
        let parsed = null;
        if (responseText) {
          try {
            parsed = JSON.parse(responseText);
          } catch {
            parsed = { error: "NON_JSON_RESPONSE" };
          }
        }
        if (!response.ok) {
          const error = new Error(`HTTP_${response.status}`);
          error.status = response.status;
          error.payload = parsed;
          throw error;
        }
        return { data: parsed, headers: response.headers, status: response.status, elapsedMs: elapsed };
      } catch (error) {
        lastError = error;
        const status = error?.status;
        const retryable = error?.name === "AbortError"
          || isRetryableNetworkError(error)
          || status === 429
          || (status >= 500 && status < 600);
        if (!retryable || attempt >= this.retries) {
          this.metrics.failures += 1;
          throw error;
        }
        this.metrics.retries += 1;
        await delay(Math.min(15_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  get(pathname, query) { return this.request("GET", pathname, { query }); }
  post(pathname, body, headers) { return this.request("POST", pathname, { body, headers }); }
  put(pathname, body, headers) { return this.request("PUT", pathname, { body, headers }); }
}

module.exports = { JsonHttp, isRetryableNetworkError, RETRYABLE_NETWORK_CODES };
