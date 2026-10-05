/**
 * Admin API client: composes `@repo/api` transport with ephemeral auth and
 * low-cardinality request correlation.
 */

import {
  ApiClient,
  ERROR_MESSAGES,
  getStrapiServerUrl,
  REQUEST_TIMEOUT,
  RETRY_CONFIG,
} from "@repo/api";
import type { ApiError, ApiRequestOptions } from "@repo/api/types";
import { handleAuthErrors } from "@/utils/auth";
import { apiCache } from "./api-cache";
import { centralAuth } from "./central-auth";

export function onHttpError(
  error: ApiError,
  _context: { status: number; options?: ApiRequestOptions },
): void {
  // Denying one request must never erase the signed-in identity. `handleAuthErrors`
  // owns the response: 401 rechecks the session before central login, while 403
  // only surfaces a permission notice and deliberately keeps the cached user so the
  // page stays usable. Clearing `currentUserAtom` here as well made any single
  // forbidden resource look like a logout and bounced the operator off the page.
  handleAuthErrors(error);
}

export const apiClient = new ApiClient({
  baseUrl: getStrapiServerUrl(),
  requestTimeout: REQUEST_TIMEOUT,
  retryConfig: RETRY_CONFIG,
  errorMessages: ERROR_MESSAGES,
  apiCache,
  getRequestHeaders: () => ({ "X-Correlation-Id": crypto.randomUUID() }),
  getAuthToken: (options) => centralAuth.tokenManager.getToken(options),
  onAuthTokenRejected: () => centralAuth.tokenManager.expire(),
  onHttpError,
});

export { ApiClient };
