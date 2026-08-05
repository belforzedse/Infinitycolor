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

function onHttpError(
  error: ApiError,
  context: { status: number; options?: ApiRequestOptions },
): void {
  handleAuthErrors(error);
  if (context.status === 403 && typeof window !== "undefined") {
    if (window.location.pathname.startsWith("/")) {
      void import("@/lib/atoms/auth").then(({ currentUserAtom }) => {
        void import("@/lib/jotaiStore").then(({ jotaiStore }) => {
          jotaiStore.set(currentUserAtom, null);
          setTimeout(() => {
            if (window.history.length > 1) {
              window.history.back();
            } else {
              window.location.href = "/";
            }
          }, 100);
        });
      });
    }
  }
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
