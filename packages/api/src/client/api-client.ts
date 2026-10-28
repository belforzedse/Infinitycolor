/**
 * Fetch-based API client with retries, optional browser cache (SWR + ETag), and injectable auth.
 */

import type { ApiRequestOptions, ApiResponse, ApiError } from "../types/api";
import {
  ERROR_MESSAGES,
  REQUEST_TIMEOUT,
  RETRY_CONFIG,
  type ErrorMessages,
} from "../config/public";
import type { ApiCache } from "../cache/api-cache";

interface ErrorResponse {
  message?: string;
  errors?: Record<string, string[]>;
  data?: unknown;
  error?: {
    message?: string;
    details?: unknown;
  };
}

/** Keep the failure stack without copying the exception text, request or response. */
function sanitizedTransportCause(
  error: unknown,
  stage: string,
  name?: string,
  code?: string,
): Error {
  const safe = new Error(`API ${stage} failed`);
  if (name) safe.name = name;
  if (code) Object.assign(safe, { code });
  if (error instanceof Error && typeof error.stack === "string") {
    const frames = error.stack
      .split("\n")
      .filter(
        (line) =>
          /^\s+at\s/.test(line) &&
          /\((?:node:|\/|file:\/\/\/)[^?\n]+:\d+:\d+\)$/.test(line),
      )
      .slice(0, 20);
    safe.stack = [
      `${safe.name}: ${safe.message}`,
      ...frames.map((line) => line.slice(0, 500)),
    ].join("\n");
  }
  return safe;
}

class NotModifiedError extends Error {
  constructor() {
    super("304_NOT_MODIFIED");
    this.name = "NotModifiedError";
    Object.setPrototypeOf(this, NotModifiedError.prototype);
  }
}

export interface ApiClientConfig {
  baseUrl: string;
  requestTimeout?: number;
  retryConfig?: {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    retryableStatusCodes: readonly number[];
  };
  errorMessages?: ErrorMessages;
  /** Explicit async provider for an ephemeral Bearer token. There is no storage fallback. */
  getAuthToken?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<string | null> | string | null;
  /** Optional per-attempt headers such as a non-sensitive correlation id. */
  getRequestHeaders?: () => Record<string, string>;
  /** Invalidates the provider's cached token before the single safe 401 retry. */
  onAuthTokenRejected?: () => void;
  /**
   * Called for failed responses before throw, unless suppressAuthRedirect is true.
   * Use for session cleanup, toasts, redirects, etc.
   */
  onHttpError?: (
    error: ApiError,
    context: { status: number; options?: ApiRequestOptions },
  ) => void;
  /**
   * Optional browser cache: SWR + ETag for eligible GETs, and in-flight deduplication
   * for GET only. POST/PUT/PATCH/DELETE always run independently (never share pending).
   */
  apiCache?: ApiCache;
}

const defaultRetryConfig = {
  maxRetries: RETRY_CONFIG.maxRetries,
  baseDelay: RETRY_CONFIG.baseDelay,
  maxDelay: RETRY_CONFIG.maxDelay,
  retryableStatusCodes: [...RETRY_CONFIG.retryableStatusCodes],
};

/**
 * Methods whose 401 may be replayed once with a refreshed token. A 401 is raised during
 * authentication, before the handler runs, so an idempotent request had no effect. The
 * unsafe methods stay off the list on purpose -- see the matching
 * "never retries a mutation" contract in apps/auth/src/security-contract.test.ts.
 */
const IDEMPOTENT_RETRY_METHODS = new Set(["GET", "HEAD", "PUT"]);

export class ApiClient {
  private readonly baseUrl: string;
  private readonly requestTimeout: number;
  private readonly retryConfig: {
    maxRetries: number;
    baseDelay: number;
    maxDelay: number;
    retryableStatusCodes: readonly number[];
  };
  private readonly errorMessages: ErrorMessages;
  private readonly getAuthToken?: ApiClientConfig["getAuthToken"];
  private readonly getRequestHeaders?: ApiClientConfig["getRequestHeaders"];
  private readonly onAuthTokenRejected?: ApiClientConfig["onAuthTokenRejected"];
  private readonly onHttpError?: ApiClientConfig["onHttpError"];
  private readonly apiCache?: ApiCache;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl;
    this.requestTimeout = config.requestTimeout ?? REQUEST_TIMEOUT;
    this.retryConfig = config.retryConfig ?? defaultRetryConfig;
    this.errorMessages = config.errorMessages ?? ERROR_MESSAGES;
    this.getAuthToken = config.getAuthToken;
    this.getRequestHeaders = config.getRequestHeaders;
    this.onAuthTokenRejected = config.onAuthTokenRejected;
    this.onHttpError = config.onHttpError;
    this.apiCache = config.apiCache;
  }

  private async retryRequest<T>(
    requestFn: () => Promise<T>,
    retries: number = this.retryConfig.maxRetries,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await requestFn();
      } catch (error: unknown) {
        lastError = error;

        if (error instanceof NotModifiedError) {
          throw error;
        }

        const diagnostics = (
          error as {
            name?: string;
            diagnostics?: {
              cancelled?: boolean;
              stage?: string;
              name?: string;
            };
          } | null
        )?.diagnostics;
        if (
          diagnostics?.cancelled ||
          (diagnostics?.stage === "response_json" &&
            diagnostics.name === "SyntaxError") ||
          (error as { name?: string } | null)?.name === "TokenAcquisitionError"
        )
          break;

        if (attempt >= retries) {
          break;
        }

        const status =
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          typeof (error as { status: unknown }).status === "number"
            ? (error as { status: number }).status
            : undefined;

        if (
          status !== undefined &&
          !this.retryConfig.retryableStatusCodes.includes(status)
        ) {
          break;
        }

        const delay = Math.min(
          this.retryConfig.baseDelay * Math.pow(2, attempt),
          this.retryConfig.maxDelay,
        );

        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  async get<T>(
    endpoint: string,
    options?: ApiRequestOptions,
  ): Promise<ApiResponse<T>> {
    return this.request<T>("GET", endpoint, undefined, options);
  }

  async getPublic<T>(
    endpoint: string,
    options?: ApiRequestOptions,
  ): Promise<ApiResponse<T>> {
    return this.request<T>("GET", endpoint, undefined, {
      ...options,
      skipAuth: true,
    });
  }

  async post<T>(
    endpoint: string,
    data?: unknown,
    options?: ApiRequestOptions,
  ): Promise<ApiResponse<T>> {
    return this.request<T>("POST", endpoint, data, options);
  }

  async put<T>(
    endpoint: string,
    data?: unknown,
    options?: ApiRequestOptions,
  ): Promise<ApiResponse<T>> {
    return this.request<T>("PUT", endpoint, data, options);
  }

  async patch<T>(
    endpoint: string,
    data?: unknown,
    options?: ApiRequestOptions,
  ): Promise<ApiResponse<T>> {
    return this.request<T>("PATCH", endpoint, data, options);
  }

  async delete<T>(
    endpoint: string,
    options?: ApiRequestOptions,
  ): Promise<ApiResponse<T>> {
    return this.request<T>("DELETE", endpoint, undefined, options);
  }

  private handleError(status: number, data: ErrorResponse): ApiError {
    const details = data.error?.details;
    const productData =
      details && typeof details === "object" && "data" in details
        ? (details as { data?: unknown }).data
        : data.data;
    const errorCode =
      productData &&
      typeof productData === "object" &&
      "errorCode" in productData
        ? String((productData as { errorCode?: unknown }).errorCode || "") ||
          undefined
        : undefined;
    const error: ApiError = {
      message:
        data.error?.message || data.message || this.errorMessages.DEFAULT,
      status,
      errors: data.errors,
    };

    // Keep the established error shape for ordinary auth/network failures.
    // Recovery-only fields are added only when the backend actually supplied
    // them, so callers doing exact comparisons do not receive meaningless
    // `undefined` properties or an empty raw error object.
    if (status === 400) error.error = data.error || data;
    if (details !== undefined) error.details = details;
    if (productData !== undefined) error.data = productData;
    if (errorCode !== undefined) error.errorCode = errorCode;

    return error;
  }

  private async parseResponseData(response: Response): Promise<unknown> {
    if (response.status === 204 || response.status === 205) {
      return {};
    }

    if (typeof response.text === "function") {
      const text = await response.text();
      if (!text.trim()) {
        return {};
      }

      try {
        return JSON.parse(text);
      } catch {
        if (response.ok) throw new SyntaxError("Invalid API JSON response");
        return { message: text };
      }
    }

    if (typeof response.json === "function") {
      return response.json();
    }

    return {};
  }

  private async request<T>(
    method: string,
    endpoint: string,
    data?: unknown,
    options?: ApiRequestOptions,
  ): Promise<ApiResponse<T>> {
    if (!this.baseUrl || this.baseUrl === "undefined") {
      throw this.handleError(500, {
        message: "API base URL is not configured",
      });
    }

    const baseUrlObj = new URL(this.baseUrl);
    const endpointPath = endpoint.startsWith("/")
      ? endpoint.slice(1)
      : endpoint;
    const basePath = baseUrlObj.pathname.endsWith("/")
      ? baseUrlObj.pathname
      : `${baseUrlObj.pathname}/`;
    const fullPath = `${basePath}${endpointPath}`;
    const url = new URL(fullPath, `${baseUrlObj.protocol}//${baseUrlObj.host}`);

    if (options?.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      });
    }

    if (options?.cache === "no-store") {
      url.searchParams.set("_cb", String(Date.now()));
    }

    const isGet = method.toUpperCase() === "GET";
    const urlString = url.toString();
    // Reads may be retried safely. Mutations default to one attempt because a
    // lost response does not prove the server failed to apply the operation.
    const retries =
      isGet || method.toUpperCase() === "HEAD"
        ? (options?.retries ?? this.retryConfig.maxRetries)
        : 0;

    const cache = this.apiCache;
    const cacheKey = cache ? cache.generateKey(method, urlString, data) : "";

    // In-flight dedupe only for GET: mutating requests must not share one promise by URL/body.
    if (cache && isGet) {
      const pendingRequest = cache.getPending<{
        data: ApiResponse<T>;
        headers: Headers;
      }>(cacheKey);
      if (pendingRequest) {
        return pendingRequest.then((response) => response.data);
      }
    }

    const enableCache =
      typeof window !== "undefined" &&
      !!cache &&
      cache.shouldCache(method, urlString) &&
      options?.cache !== "no-store";

    const cacheConfig =
      enableCache && cache ? cache.getCacheConfig(urlString) : null;

    if (enableCache && cache && cacheConfig && isGet) {
      const cached = cache.get<ApiResponse<T>>(cacheKey);

      if (cached) {
        const bgRefreshKey = `bg-${cacheKey}`;
        if (!cache.getPending(bgRefreshKey)) {
          const bgPromise = this.retryRequest(
            () =>
              this.executeRequest<T>(
                method,
                urlString,
                data,
                options,
                cached.etag,
              ),
            retries,
          )
            .then((response) => {
              const etag = this.extractETag(response.headers);
              cache.set(cacheKey, response.data, etag, cacheConfig);
            })
            .catch((error: unknown) => {
              if (
                typeof error === "object" &&
                error !== null &&
                "message" in error &&
                (error as { message: unknown }).message === "304_NOT_MODIFIED"
              ) {
                return;
              }
            });
          cache.setPending(bgRefreshKey, bgPromise);
        }

        return Promise.resolve(cached.data);
      }
    }

    const requestPromise = this.retryRequest(
      () => this.executeRequest<T>(method, urlString, data, options, null),
      retries,
    );

    if (cache && isGet) {
      cache.setPending(cacheKey, requestPromise);
    }

    try {
      const response = await requestPromise;

      if (enableCache && cache && cacheConfig && isGet && response) {
        const etag = this.extractETag(response.headers);
        cache.set(cacheKey, response.data, etag, cacheConfig);
      }

      return response.data;
    } catch (error) {
      throw error;
    }
  }

  private async executeRequest<T>(
    method: string,
    url: string,
    requestData: unknown,
    options: ApiRequestOptions | undefined,
    etag: string | null,
  ): Promise<{ data: ApiResponse<T>; headers: Headers }> {
    let failureStage: "request" | "response_json" | "response_status" =
      "request";
    let requestId: string | undefined;
    let httpStatus: number | undefined;
    let headers = await this.buildHeaders(options?.headers, options?.skipAuth);

    if (etag && method.toUpperCase() === "GET") {
      (headers as Record<string, string>)["If-None-Match"] = etag;
    }

    const config: RequestInit = {
      method,
      headers,
      credentials: options?.withCredentials ? "include" : "same-origin",
      body: requestData ? JSON.stringify(requestData) : undefined,
      cache: options?.cache || "default",
    };

    const controller = new AbortController();
    const abortError = () =>
      Object.assign(new Error("Request interrupted"), { name: "AbortError" });
    let onInterrupted!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      onInterrupted = () => reject(abortError());
      controller.signal.addEventListener("abort", onInterrupted, {
        once: true,
      });
    });
    // Observe interruption even when a custom fetch/body implementation ignores the signal.
    void interrupted.catch(() => undefined);
    const cleanupExternalAbort = options?.signal
      ? (() => {
          const onAbort = () => controller.abort();
          if (options.signal!.aborted) onAbort();
          options.signal!.addEventListener("abort", onAbort);
          return () => options.signal!.removeEventListener("abort", onAbort);
        })()
      : undefined;
    const timeoutId = setTimeout(
      () => controller.abort(),
      options?.timeout ?? this.requestTimeout,
    );

    try {
      if (controller.signal.aborted) throw abortError();
      let response = await Promise.race([
        fetch(url, {
          ...config,
          signal: controller.signal,
        }),
        interrupted,
      ]);
      httpStatus = response.status;

      const methodUpper = method.toUpperCase();
      const authRejected =
        response.status === 401 &&
        !options?.skipAuth &&
        !options?.headers?.Authorization &&
        Boolean(this.getAuthToken);

      if (authRejected) {
        // Always evict first, even when the request will not be replayed. This used to
        // live inside the GET/HEAD branch, so a rejected mutation kept the stale JWT
        // cached and the retry the user made by hand failed for the same reason.
        this.onAuthTokenRejected?.();

        // API JWTs live 60 seconds, so a form left open longer than that saves with an
        // expired token. A 401 is raised during authentication, before the handler runs,
        // so the request had no effect and replaying an idempotent one is safe --
        // `PUT /auth/self` is exactly that case. POST/PATCH/DELETE are never replayed.
        if (IDEMPOTENT_RETRY_METHODS.has(methodUpper)) {
          headers = await this.buildHeaders(options?.headers, false, true);
          if (etag && methodUpper === "GET") {
            (headers as Record<string, string>)["If-None-Match"] = etag;
          }
          if (new Headers(headers).has("authorization")) {
            response = await Promise.race([
              fetch(url, {
                ...config,
                headers,
                signal: controller.signal,
              }),
              interrupted,
            ]);
            httpStatus = response.status;
          }
        }
      }

      if (controller.signal.aborted) throw abortError();

      if (response.status === 304) {
        throw new NotModifiedError();
      }

      const candidateRequestId = response.headers?.get("x-request-id");
      if (
        candidateRequestId &&
        /^[a-zA-Z0-9_.:-]{1,100}$/.test(candidateRequestId)
      )
        requestId = candidateRequestId;
      failureStage = "response_json";
      const responseData = await Promise.race([
        this.parseResponseData(response),
        interrupted,
      ]);

      if (!response.ok) {
        const error = this.handleError(
          response.status,
          responseData as ErrorResponse,
        );
        error.diagnostics = { stage: "response_status", requestId, httpStatus };

        if (!options?.suppressAuthRedirect) {
          this.onHttpError?.(error, { status: response.status, options });
        }

        throw error;
      }

      return {
        data: responseData as ApiResponse<T>,
        headers: response.headers,
      };
    } catch (error: unknown) {
      if (error instanceof NotModifiedError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw {
          ...this.handleError(408, { message: this.errorMessages.TIMEOUT }),
          cause: sanitizedTransportCause(error, failureStage, "AbortError"),
          diagnostics: {
            stage: failureStage,
            name: "AbortError",
            requestId,
            httpStatus,
            cancelled: Boolean(options?.signal?.aborted),
          },
        } satisfies ApiError;
      }

      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        ("message" in error || "error" in error)
      ) {
        throw error;
      }

      const safeNames = new Set([
        "Error",
        "TypeError",
        "SyntaxError",
        "NetworkError",
        "TimeoutError",
      ]);
      const safeCodes = new Set([
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_SOCKET",
      ]);
      const fields =
        error && typeof error === "object"
          ? (error as {
              name?: string;
              code?: string;
              cause?: { code?: string };
            })
          : {};
      const code = fields.code ?? fields.cause?.code;
      throw {
        ...this.handleError(500, { message: this.errorMessages.DEFAULT }),
        cause: sanitizedTransportCause(
          error,
          failureStage,
          fields.name && safeNames.has(fields.name) ? fields.name : undefined,
          code && safeCodes.has(code) ? code : undefined,
        ),
        diagnostics: {
          stage: failureStage,
          requestId,
          httpStatus,
          name:
            fields.name && safeNames.has(fields.name) ? fields.name : undefined,
          code: code && safeCodes.has(code) ? code : undefined,
        },
      } satisfies ApiError;
    } finally {
      clearTimeout(timeoutId);
      cleanupExternalAbort?.();
      controller.signal.removeEventListener("abort", onInterrupted);
    }
  }

  private extractETag(headers: Headers): string | null {
    return headers.get("etag") || null;
  }

  private async buildHeaders(
    customHeaders?: Record<string, string>,
    skipAuth?: boolean,
    forceRefresh = false,
  ): Promise<HeadersInit> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...this.getRequestHeaders?.(),
      ...customHeaders,
    };

    if (!skipAuth && !customHeaders?.Authorization) {
      const token = await this.resolveAuthToken(forceRefresh);
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    return headers;
  }

  private async resolveAuthToken(
    forceRefresh: boolean,
  ): Promise<string | null> {
    return (await this.getAuthToken?.({ forceRefresh })) ?? null;
  }
}

export default ApiClient;
