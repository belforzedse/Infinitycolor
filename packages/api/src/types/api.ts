/**
 * API Types
 * Shared types for HTTP client and responses (Strapi-oriented naming is OK for headless CMS consumers).
 */

export interface ApiResponse<T> {
  data: T;
  meta?: {
    pagination?: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}

export interface ApiError {
  message: string;
  status: number;
  errors?: Record<string, string[]>;
  error?: unknown;
  /** Strapi/Koa structured error details, preserved for product recovery UI. */
  details?: unknown;
  /** Product payload supplied through ctx.badRequest/conflict helpers. */
  data?: unknown;
  errorCode?: string;
  /** Sanitized transport context; never contains response text or request URLs. */
  cause?: Error;
  diagnostics?: {
    stage: "request" | "response_json" | "response_status";
    /** Present only when an HTTP response was received. */
    httpStatus?: number;
    name?: string;
    code?: string;
    requestId?: string;
    cancelled?: boolean;
  };
}

export interface ApiRequestOptions {
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean | undefined>;
  timeout?: number;
  retries?: number;
  withCredentials?: boolean;
  skipAuth?: boolean;
  suppressAuthRedirect?: boolean;
  signal?: AbortSignal;
  cache?: RequestCache;
  /** Skip shared in-flight GET coalescing when the caller coordinates requests itself. */
  deduplicate?: boolean;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sort?: string;
  order?: "asc" | "desc";
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
    itemsPerPage: number;
  };
}

export interface StrapiErrorResponse {
  error: {
    status: number;
    name: string;
    message: string;
    details?: unknown;
  };
}
