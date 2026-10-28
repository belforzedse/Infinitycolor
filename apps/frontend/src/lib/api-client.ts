/**
 * Storefront API client: composes `@repo/api` transport with app auth + cache rules.
 */

import {
  ApiClient,
  ERROR_MESSAGES,
  getStrapiServerUrl,
  REQUEST_TIMEOUT,
  RETRY_CONFIG,
} from "@repo/api";
import type { ApiError } from "@repo/api/types";
import { handleAuthErrors } from "@/utils/auth";
import { apiCache } from "./api-cache";
import { centralAuth } from "./central-auth";

function onHttpError(error: ApiError): void {
  handleAuthErrors(error);
}

export const apiClient = new ApiClient({
  baseUrl: getStrapiServerUrl(),
  requestTimeout: REQUEST_TIMEOUT,
  retryConfig: RETRY_CONFIG,
  errorMessages: ERROR_MESSAGES,
  apiCache,
  getAuthToken: (options) => centralAuth.tokenManager.getToken(options),
  onAuthTokenRejected: () => centralAuth.tokenManager.expire(),
  onHttpError,
});

export { ApiClient };
