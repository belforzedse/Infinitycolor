/**
 * Social app API client — shared transport via `@repo/api`, with the same
 * in-memory central-auth bearer as the storefront. Callers must not attach a
 * reusable token from storage.
 */

import {
  ApiClient,
  API_BASE_URL,
  ERROR_MESSAGES,
  REQUEST_TIMEOUT,
  RETRY_CONFIG,
} from "@repo/api";
import type { ApiError, ApiRequestOptions } from "@repo/api/types";
import { handleAuthErrors } from "@/utils/auth";
import { centralAuth } from "./central-auth";

function onHttpError(
  error: ApiError,
  _context: { status: number; options?: ApiRequestOptions },
): void {
  handleAuthErrors(error);
}

export const apiClient = new ApiClient({
  baseUrl: API_BASE_URL,
  requestTimeout: REQUEST_TIMEOUT,
  retryConfig: RETRY_CONFIG,
  errorMessages: ERROR_MESSAGES,
  getAuthToken: (options) => centralAuth.tokenManager.getToken(options),
  onAuthTokenRejected: () => centralAuth.tokenManager.expire(),
  onHttpError,
});

export { ApiClient };
