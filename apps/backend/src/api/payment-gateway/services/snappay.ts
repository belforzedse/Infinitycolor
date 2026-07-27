/**
 * Narrow SnappPay HTTP adapter.
 *
 * This module owns authentication, transport timeouts and response parsing.
 * Payment/order state transitions belong to snappay-orchestrator.ts.
 */

import axios, { AxiosError, AxiosInstance } from "axios";
import type { Strapi } from "@strapi/strapi";

export type SnappayErrorData = {
  errorCode?: number;
  message: string;
};

export type SnappayCallResult<T> = {
  successful: boolean;
  response?: T;
  errorData?: SnappayErrorData;
  diagnostic: {
    endpoint: SnappayEndpoint;
    httpStatus?: number;
    providerCode?: number;
    timedOut?: boolean;
    transportError?: boolean;
  };
};

export type SnappayEndpoint =
  | "eligible"
  | "token"
  | "verify"
  | "settle"
  | "revert"
  | "cancel"
  | "status"
  | "update";

export type SnappayCartItem = {
  amount: number;
  category: string;
  count: number;
  id: number;
  name: string;
  commissionType: number;
};

export type SnappayCart = {
  cartId: number;
  cartItems: SnappayCartItem[];
  isShipmentIncluded: boolean;
  isTaxIncluded: boolean;
  taxAmount: number;
  shippingAmount: number;
  totalAmount: number;
};

export type SnappayTokenRequest = {
  amount: number;
  discountAmount: number;
  externalSourceAmount: number;
  mobile: string;
  returnURL: string;
  transactionId: string;
  cartList: SnappayCart[];
};

export type SnappayUpdateRequest = {
  paymentToken: string;
  amount: number;
  discountAmount: number;
  externalSourceAmount: number;
  cartList: SnappayCart[];
};

type AccessTokenResponse = {
  access_token: string;
  expires_in: number;
};

type EligibleResponse = {
  eligible: boolean;
  title_message?: string;
  description?: string;
};

type TokenResponse = {
  paymentToken: string;
  paymentPageUrl: string;
};

type SimpleResponse = {
  transactionId?: string;
  status?: string;
};

type ProviderEnvelope<T> = {
  successful: boolean;
  response?: T;
  errorData?: {
    errorCode?: number | string;
    message?: string;
    data?: unknown;
  };
};

type SnappayConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

function exactCart(cart: SnappayCart): SnappayCart {
  return {
    cartId: cart.cartId,
    cartItems: (cart.cartItems || []).map((item) => ({
      amount: item.amount,
      category: item.category,
      count: item.count,
      id: item.id,
      name: item.name,
      commissionType: item.commissionType,
    })),
    isShipmentIncluded: cart.isShipmentIncluded,
    isTaxIncluded: cart.isTaxIncluded,
    taxAmount: cart.taxAmount,
    shippingAmount: cart.shippingAmount,
    totalAmount: cart.totalAmount,
  };
}

function exactTokenRequest(payload: SnappayTokenRequest): SnappayTokenRequest {
  return {
    amount: payload.amount,
    discountAmount: payload.discountAmount,
    externalSourceAmount: payload.externalSourceAmount,
    mobile: payload.mobile,
    returnURL: payload.returnURL,
    transactionId: payload.transactionId,
    cartList: (payload.cartList || []).map(exactCart),
  };
}

function exactUpdateRequest(payload: SnappayUpdateRequest): SnappayUpdateRequest {
  return {
    paymentToken: payload.paymentToken,
    amount: payload.amount,
    discountAmount: payload.discountAmount,
    externalSourceAmount: payload.externalSourceAmount,
    cartList: (payload.cartList || []).map(exactCart),
  };
}

const required = (name: string): string => {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`SNAPPAY_CONFIG_INVALID:${name} is required`);
  return value;
};

export function getSnappayConfig(): SnappayConfig {
  const baseUrl = required("SNAPPAY_BASE_URL").replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("SNAPPAY_CONFIG_INVALID:SNAPPAY_BASE_URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("SNAPPAY_CONFIG_INVALID:SNAPPAY_BASE_URL must use HTTPS");
  }
  return {
    baseUrl,
    clientId: required("SNAPPAY_CLIENT_ID"),
    clientSecret: required("SNAPPAY_CLIENT_SECRET"),
    username: required("SNAPPAY_USERNAME"),
    password: required("SNAPPAY_PASSWORD"),
  };
}

function providerCode(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function safeMessage(value: unknown, fallback: string): string {
  const text = String(value || "").trim();
  return text ? text.slice(0, 500) : fallback;
}

function normalizeEnvelope<T>(
  endpoint: SnappayEndpoint,
  data: ProviderEnvelope<T>,
  httpStatus?: number,
): SnappayCallResult<T> {
  const code = providerCode(data?.errorData?.errorCode);
  return {
    successful: data?.successful === true,
    response: data?.successful === true ? data.response : undefined,
    errorData:
      data?.successful === true
        ? undefined
        : {
            errorCode: code,
            message: safeMessage(
              data?.errorData?.message,
              "SnappPay rejected the request",
            ),
          },
    diagnostic: {
      endpoint,
      httpStatus,
      providerCode: code,
    },
  };
}

function normalizeTransportError<T>(
  endpoint: SnappayEndpoint,
  error: unknown,
): SnappayCallResult<T> {
  const axiosError = error as AxiosError<ProviderEnvelope<T>>;
  const status = axiosError.response?.status;
  const body = axiosError.response?.data;
  const code = providerCode(body?.errorData?.errorCode);
  const timedOut =
    axiosError.code === "ECONNABORTED" ||
    axiosError.code === "ETIMEDOUT" ||
    /timeout/i.test(String(axiosError.message || ""));
  return {
    successful: false,
    errorData: {
      errorCode: code,
      message: safeMessage(
        body?.errorData?.message,
        timedOut ? "SnappPay request timed out" : "SnappPay request failed",
      ),
    },
    diagnostic: {
      endpoint,
      httpStatus: status,
      providerCode: code,
      timedOut,
      transportError: !axiosError.response,
    },
  };
}

function logResult<T>(
  strapi: Strapi,
  result: SnappayCallResult<T>,
): void {
  const details = {
    endpoint: result.diagnostic.endpoint,
    successful: result.successful,
    httpStatus: result.diagnostic.httpStatus,
    providerCode: result.diagnostic.providerCode,
    timedOut: result.diagnostic.timedOut,
    transportError: result.diagnostic.transportError,
  };
  if (result.successful) {
    strapi.log.info("SnappPay provider call completed", details);
  } else {
    strapi.log.warn("SnappPay provider call failed", details);
  }
  const metrics = (strapi as any).metrics;
  const metricName = `snappay_provider_${result.diagnostic.endpoint}_${
    result.successful ? "success" : "failure"
  }`;
  if (typeof metrics?.increment === "function") {
    metrics.increment(metricName);
    if (result.diagnostic.providerCode) {
      metrics.increment(
        `snappay_provider_code_${result.diagnostic.providerCode}`,
      );
    }
  }
  if (
    result.diagnostic.providerCode === 1048 ||
    result.diagnostic.providerCode === 1051
  ) {
    strapi.log.error("SnappPay provider launch-blocking alert", details);
  }
}

async function fetchAccessToken(http: AxiosInstance): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 10_000) {
    return cachedToken.token;
  }
  const config = getSnappayConfig();
  const basic = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    scope: "online-merchant",
    username: config.username,
    password: config.password,
  });
  const response = await http.post<AccessTokenResponse>(
    "/api/online/v1/oauth/token",
    body.toString(),
    {
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 20_000,
    },
  );
  if (!response.data?.access_token) {
    throw new Error("SNAPPAY_AUTH_RESPONSE_INVALID");
  }
  const ttlSeconds = Math.max(30, Number(response.data.expires_in || 0));
  cachedToken = {
    token: response.data.access_token,
    expiresAt: Date.now() + Math.max(1, ttlSeconds - 30) * 1000,
  };
  return cachedToken.token;
}

function createHttp(): AxiosInstance {
  return axios.create({ baseURL: getSnappayConfig().baseUrl });
}

async function callProvider<T>(
  strapi: Strapi,
  endpoint: SnappayEndpoint,
  execute: (http: AxiosInstance, accessToken: string) => Promise<{
    data: ProviderEnvelope<T>;
    status: number;
  }>,
): Promise<SnappayCallResult<T>> {
  const http = createHttp();
  try {
    const accessToken = await fetchAccessToken(http);
    const response = await execute(http, accessToken);
    const result = normalizeEnvelope(endpoint, response.data, response.status);
    logResult(strapi, result);
    return result;
  } catch (error) {
    const result = normalizeTransportError<T>(endpoint, error);
    logResult(strapi, result);
    return result;
  }
}

export function createSnappayAdapter(strapi: Strapi) {
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const post = <T>(
    endpoint: SnappayEndpoint,
    path: string,
    payload: unknown,
    timeout = 30_000,
  ) =>
    callProvider<T>(strapi, endpoint, (http, token) =>
      http.post(path, payload, {
        headers: {
          ...bearer(token),
          "Content-Type": "application/json",
        },
        timeout,
      }),
    );

  return {
    async eligible(amountIRR: number) {
      return callProvider<EligibleResponse>(
        strapi,
        "eligible",
        (http, token) =>
          http.get("/api/online/offer/v1/eligible", {
            params: { amount: amountIRR },
            headers: bearer(token),
            timeout: 20_000,
          }),
      );
    },

    async requestPaymentToken(payload: SnappayTokenRequest) {
      return post<TokenResponse>(
        "token",
        "/api/online/payment/v1/token",
        exactTokenRequest(payload),
      );
    },

    async verify(paymentToken: string) {
      return post<SimpleResponse>(
        "verify",
        "/api/online/payment/v1/verify",
        { paymentToken },
        30_000,
      );
    },

    async settle(paymentToken: string) {
      return post<SimpleResponse>(
        "settle",
        "/api/online/payment/v1/settle",
        { paymentToken },
      );
    },

    async revert(paymentToken: string) {
      return post<SimpleResponse>(
        "revert",
        "/api/online/payment/v1/revert",
        { paymentToken },
      );
    },

    async cancel(paymentToken: string) {
      return post<SimpleResponse>(
        "cancel",
        "/api/online/payment/v1/cancel",
        { paymentToken },
      );
    },

    async status(paymentToken: string) {
      return callProvider<SimpleResponse>(
        strapi,
        "status",
        (http, token) =>
          http.get("/api/online/payment/v1/status", {
            params: { paymentToken },
            headers: bearer(token),
            timeout: 20_000,
          }),
      );
    },

    async update(payload: SnappayUpdateRequest) {
      return post<SimpleResponse>(
        "update",
        "/api/online/payment/v1/update",
        exactUpdateRequest(payload),
      );
    },
  };
}

export default ({ strapi }: { strapi: Strapi }) =>
  createSnappayAdapter(strapi);
