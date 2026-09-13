"use strict";

const axios = require("axios");
const http = require("node:http");
const https = require("node:https");
const {
  computeBackoffDelay,
  parseRetryAfter,
  isRetryableError,
  isTransportError,
} = require("./backoff");

// Reused across every request: without keep-alive, axios' default agents open
// a fresh TCP+TLS connection per request, which dominates latency once many
// short requests run back to back (e.g. one Woo/Strapi round trip per
// product/variation). maxSockets is generous rather than tied to a specific
// concurrency knob, since Woo and Strapi clients are each shared across
// product-loop, variation-pool, and entity-pool callers with independent caps.
const KEEP_ALIVE_MAX_SOCKETS = 64;
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: KEEP_ALIVE_MAX_SOCKETS });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: KEEP_ALIVE_MAX_SOCKETS });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Thin retry wrapper around an axios instance.
 *
 * Fixes the legacy `ApiClient.retryRequest`: real exponential backoff with jitter,
 * honours `Retry-After` on 429/503, and only retries network errors / 429 / 5xx —
 * never a 4xx (which would just waste attempts).
 */
class HttpClient {
  /**
   * @param {import('axios').AxiosInstance} instance
   * @param {object} [opts]
   * @param {{ warn: Function, debug: Function }} [opts.logger]
   * @param {number} [opts.maxRetries=4]
   * @param {number} [opts.baseDelay=1000]
   * @param {number} [opts.maxDelay=30000]
   * @param {(ms:number)=>Promise<void>} [opts.sleepFn]
   * @param {{ holdUntilHealthy: Function }} [opts.sourceGate] Set on the Woo client
   *   only — never the Strapi writer. When the retry budget is exhausted by a
   *   transport failure, park on the gate until the source recovers instead of
   *   throwing, then spend a fresh retry budget on the same request.
   * @param {number} [opts.maxGateHolds=3] Cap on gate holds for one request, so a
   *   flapping source cannot park a single call forever.
   */
  constructor(instance, opts = {}) {
    this.instance = instance;
    this.logger = opts.logger || { warn() {}, debug() {} };
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseDelay = opts.baseDelay ?? 1000;
    this.maxDelay = opts.maxDelay ?? 30000;
    this.sleepFn = opts.sleepFn || sleep;
    this.sourceGate = opts.sourceGate || null;
    this.maxGateHolds = opts.maxGateHolds ?? 3;
    this.metrics = { requests: 0, attempts: 0, retries: 0, latencyMs: 0, failures: 0, gateHolds: 0 };
  }

  /**
   * Perform a request with retry/backoff. Resolves with the axios response.
   * @param {import('axios').AxiosRequestConfig} config
   */
  async request(config) {
    this.metrics.requests += 1;
    let gateHolds = 0;
    for (;;) {
      try {
        return await this.attemptWithRetries(config);
      } catch (error) {
        // Retries are exhausted. If the source (not the destination) simply is
        // not answering, park on the gate rather than failing the run, then
        // spend a fresh retry budget once it comes back.
        if (this.sourceGate && gateHolds < this.maxGateHolds && isTransportError(error)) {
          gateHolds += 1;
          this.metrics.gateHolds += 1;
          await this.sourceGate.holdUntilHealthy({
            reason: `${config.method?.toUpperCase() || "GET"} ${config.url}: ${error.code || error.message}`,
          });
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * One request plus its normal retry budget. Throws the last error when the
   * budget is spent; `request` decides whether that is fatal or gate-worthy.
   * @param {import('axios').AxiosRequestConfig} config
   */
  async attemptWithRetries(config) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      const started = process.hrtime.bigint();
      this.metrics.attempts += 1;
      try {
        const response = await this.instance.request(config);
        this.metrics.latencyMs += Number(process.hrtime.bigint() - started) / 1e6;
        return response;
      } catch (error) {
        this.metrics.latencyMs += Number(process.hrtime.bigint() - started) / 1e6;
        lastError = error;
        const status = error.response?.status;
        const retryable = isRetryableError(error);

        if (!retryable || attempt === this.maxRetries) {
          this.metrics.failures += 1;
          break;
        }
        this.metrics.retries += 1;

        const retryAfter = parseRetryAfter(error.response?.headers?.["retry-after"]);
        const delay =
          retryAfter !== null
            ? Math.min(retryAfter, this.maxDelay)
            : computeBackoffDelay(attempt, { baseDelay: this.baseDelay, maxDelay: this.maxDelay });

        this.logger.warn(
          `🔄 ${config.method?.toUpperCase() || "GET"} ${config.url} failed ` +
            `(attempt ${attempt}/${this.maxRetries}${status ? `, status ${status}` : `, ${error.code || "network"}`}), ` +
            `retrying in ${delay}ms`,
        );
        await this.sleepFn(delay);
      }
    }
    throw lastError;
  }

  get(url, config = {}) {
    return this.request({ ...config, method: "get", url });
  }

  post(url, data, config = {}) {
    return this.request({ ...config, method: "post", url, data });
  }

  put(url, data, config = {}) {
    return this.request({ ...config, method: "put", url, data });
  }

  delete(url, config = {}) {
    return this.request({ ...config, method: "delete", url });
  }
}

/** Build a fail-closed, read-only WooCommerce client using HTTPS Basic auth. */
function createWooAxios(config) {
  const instance = axios.create({
    baseURL: config.woocommerce.baseUrl,
    timeout: config.woocommerce.timeout || 60000,
    headers: { "User-Agent": "catalog-importer/2.0" },
    auth: {
      username: config.woocommerce.auth.consumerKey,
      password: config.woocommerce.auth.consumerSecret,
    },
    httpAgent,
    httpsAgent,
  });
  instance.interceptors.request.use((request) => {
    const method = String(request.method || "get").toLowerCase();
    if (!["get", "head", "options"].includes(method)) {
      throw new Error(`WooCommerce source is read-only; blocked ${method.toUpperCase()} request`);
    }
    return request;
  });
  return instance;
}

/** Build an axios instance for the Strapi REST API (Bearer auth). */
function createStrapiAxios(config) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "catalog-importer/2.0",
  };
  if (!config.strapi.usePublicAccess && config.strapi.auth?.token) {
    headers.Authorization = `Bearer ${config.strapi.auth.token}`;
  }
  if (config.migration?.controlToken) {
    headers["X-Infinity-Migration-Mode"] = "wordpress-v2";
    headers["X-Infinity-Migration-Control"] = config.migration.controlToken;
  }
  return axios.create({
    baseURL: config.strapi.baseUrl,
    timeout: config.strapi.timeout || 30000,
    headers,
    httpAgent,
    httpsAgent,
  });
}

module.exports = { HttpClient, createWooAxios, createStrapiAxios, sleep };
