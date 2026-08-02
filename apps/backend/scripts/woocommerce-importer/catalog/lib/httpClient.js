"use strict";

const axios = require("axios");
const {
  computeBackoffDelay,
  parseRetryAfter,
  isRetryableError,
} = require("./backoff");

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
   */
  constructor(instance, opts = {}) {
    this.instance = instance;
    this.logger = opts.logger || { warn() {}, debug() {} };
    this.maxRetries = opts.maxRetries ?? 4;
    this.baseDelay = opts.baseDelay ?? 1000;
    this.maxDelay = opts.maxDelay ?? 30000;
    this.sleepFn = opts.sleepFn || sleep;
  }

  /**
   * Perform a request with retry/backoff. Resolves with the axios response.
   * @param {import('axios').AxiosRequestConfig} config
   */
  async request(config) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.instance.request(config);
      } catch (error) {
        lastError = error;
        const status = error.response?.status;
        const retryable = isRetryableError(error);

        if (!retryable || attempt === this.maxRetries) {
          break;
        }

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
  });
}

module.exports = { HttpClient, createWooAxios, createStrapiAxios, sleep };
