"use strict";

const { setTimeout: delay } = require("node:timers/promises");

class JsonHttp {
  constructor({ baseUrl, headers, sourceReadOnly = false, retries = 4, timeoutMs = 30_000 }) {
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
        const retryable = error?.name === "AbortError" || status === 429 || (status >= 500 && status < 600);
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
  post(pathname, body) { return this.request("POST", pathname, { body }); }
  put(pathname, body) { return this.request("PUT", pathname, { body }); }
}

module.exports = { JsonHttp };
