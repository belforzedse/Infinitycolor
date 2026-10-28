import { createHash, randomBytes } from "crypto";
import MellatCheckout from "mellat-checkout";
import type { Strapi } from "@strapi/strapi";

export const MELLAT_SOAP_TIMEOUT_MS = 15_000;
const SIGNED_LONG_MAX = "9223372036854775807";
const PAYMENT_URL = "https://bpm.shaparak.ir/pgwchannel/startpay.mellat";

interface MellatPaymentParams {
  orderId: string | number;
  amount: number;
  userId?: string | number;
  callbackURL?: string;
  /** Internal callers must explicitly select the server-owned wallet callback. */
  callbackPurpose?: "order" | "wallet";
  contractId?: number;
  amountInRial?: boolean;
  includePayerId?: boolean;
}

interface MellatVerifyParams {
  orderId: string | number;
  saleOrderId: string | number;
  saleReferenceId: string | number;
  requestedAmountIrr?: number;
  /** Retained for caller compatibility; 45 is an idempotent settlement response. */
  allowResCode45Success?: boolean;
}

export interface PaymentResponse {
  success: boolean;
  ambiguous: boolean;
  refId?: string;
  redirectUrl?: string;
  error?: string;
  requestId: string;
  resCode?: number;
  rawResCode?: string;
  message?: string;
  errorCode?: string;
  errorErrno?: number;
  terminalFingerprint?: string;
  requestedAmountIrr?: number;
  saleOrderId?: string;
}

class MellatAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly ambiguous = false,
  ) {
    super(message);
  }
}

/** Never pass JavaScript numbers through Number() when they may be SOAP longs. */
export const mellatLong = (value: unknown, allowZero = false): string => {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new MellatAdapterError("MELLAT_INVALID_ID", "Invalid Mellat identifier");
  }
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    throw new MellatAdapterError("MELLAT_INVALID_ID", "Invalid Mellat identifier");
  }
  const digits = String(value).replace(/^0+(?=\d)/, "");
  if ((!allowZero && digits === "0") || digits.length > SIGNED_LONG_MAX.length ||
      (digits.length === SIGNED_LONG_MAX.length && digits > SIGNED_LONG_MAX)) {
    throw new MellatAdapterError("MELLAT_INVALID_ID", "Invalid Mellat identifier");
  }
  return digits;
};

export const mellatAmountIrr = (amount: number, alreadyIrr = false): number => {
  const converted = alreadyIrr ? amount : amount * 10;
  if (!Number.isSafeInteger(amount) || amount <= 0 ||
      !Number.isSafeInteger(converted) || converted <= 0) {
    throw new MellatAdapterError("MELLAT_INVALID_AMOUNT", "Invalid Mellat payment amount");
  }
  return converted;
};

export const mellatTerminalFingerprint = (
  terminalId = process.env.MELLAT_TERMINAL_ID || "",
  username = process.env.MELLAT_USERNAME || "",
): string => createHash("sha256").update(`${terminalId.trim()}|${username.trim()}`).digest("hex");

export const mellatLocalDateTime = (date = new Date()): { localDate: string; localTime: string } => {
  const parts = new Intl.DateTimeFormat("en-GB-u-ca-gregory-nu-latn", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  return {
    localDate: `${part("year")}${part("month")}${part("day")}`,
    localTime: `${part("hour")}${part("minute")}${part("second")}`,
  };
};

interface ParsedReturn {
  valid: boolean;
  resCode?: number;
  rawResCode?: string;
  refId?: string;
}

/** Only the documented string grammar is authoritative, never a package's inferred RefId. */
export const parseMellatReturn = (response: unknown, payRequest = false): ParsedReturn => {
  if (!response || typeof response !== "object" || Array.isArray(response)) return { valid: false };
  const raw = (response as Record<string, unknown>).return;
  if (typeof raw !== "string") return { valid: false };
  const fields = raw.split(",");
  const rawResCode = fields[0];
  if (!/^(0|[1-9]\d*)$/.test(rawResCode) || !Number.isSafeInteger(Number(rawResCode))) {
    return { valid: false };
  }
  const code = { resCode: Number(rawResCode), rawResCode };
  if (Object.keys(response).length !== 1) return { valid: false, ...code };
  if (payRequest && rawResCode === "0") {
    return fields.length === 2 && /^[^\s,\u0000-\u001f\u007f]+$/.test(fields[1])
      ? { valid: true, ...code, refId: fields[1] }
      : { valid: false, ...code };
  }
  return { valid: fields.length === 1, ...code };
};

const withDeadline = <T>(start: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new MellatAdapterError(
    "ETIMEDOUT", "Mellat initialization timed out", true,
  )), MELLAT_SOAP_TIMEOUT_MS);
  Promise.resolve().then(start).then(resolve, reject).finally(() => clearTimeout(timer));
});

/** soap 0.23 does not return the request from bp*; capture it at its HTTP boundary. */
const rawSoapCall = (client: any, method: string, args: Record<string, unknown>): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let completed = false;
    let transport: any;
    const httpClient = client.httpClient;
    const originalRequest = httpClient?.request;
    const finish = (error?: unknown, response?: unknown) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (originalRequest) httpClient.request = originalRequest;
      error ? reject(error) : resolve(response);
    };
    const timer = setTimeout(() => {
      finish(new MellatAdapterError("ETIMEDOUT", "Mellat SOAP request timed out", true));
      try {
        if (typeof transport?.abort === "function") transport.abort();
        else if (typeof transport?.destroy === "function") transport.destroy();
      } catch (_) {
        // A local abort error cannot change the already ambiguous provider outcome.
      }
    }, MELLAT_SOAP_TIMEOUT_MS);
    if (originalRequest) {
      httpClient.request = function (url: unknown, data: unknown, callback: unknown,
        headers: unknown, options: Record<string, unknown>, ...rest: unknown[]) {
        transport = originalRequest.call(this, url, data, callback, headers,
          { ...options, timeout: MELLAT_SOAP_TIMEOUT_MS }, ...rest);
        return transport;
      };
    }
    try {
      if (typeof client[method] !== "function") {
        throw new MellatAdapterError("MELLAT_SOAP_METHOD_MISSING", "Mellat SOAP method unavailable", true);
      }
      client[method](args, (error: unknown, response: unknown) => finish(error, response), {
        timeout: MELLAT_SOAP_TIMEOUT_MS,
      });
    } catch (error) {
      finish(error);
    }
  });

const safeFailure = (error: any): Pick<PaymentResponse, "error" | "errorCode" | "errorErrno" | "ambiguous"> => {
  if (error instanceof MellatAdapterError) {
    return { error: error.message, errorCode: error.code, ambiguous: error.ambiguous };
  }
  // SOAP faults and transport messages may embed credentials or the complete request body.
  const errorCode = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : "MELLAT_SOAP_ERROR";
  return {
    error: "Mellat SOAP request failed",
    errorCode,
    ...(Number.isSafeInteger(error?.errno) ? { errorErrno: error.errno } : {}),
    ambiguous: true,
  };
};

export default ({ strapi }: { strapi: Strapi }) => ({
  createMellatClient() {
    const terminalId = process.env.MELLAT_TERMINAL_ID?.trim();
    const username = process.env.MELLAT_USERNAME?.trim();
    const password = process.env.MELLAT_PASSWORD;
    if (!terminalId || !username || !password) {
      throw new MellatAdapterError("MELLAT_CONFIG_INVALID", "Mellat gateway credentials not configured");
    }
    mellatLong(terminalId);
    const rawUrl = (process.env.MELLAT_GATEWAY_URL ||
      "https://bpm.shaparak.ir/pgwchannel/services/pgw?wsdl").trim();
    const config = {
      terminalId, username, password,
      timeout: MELLAT_SOAP_TIMEOUT_MS,
      apiUrl: /\?wsdl$/i.test(rawUrl) ? rawUrl : `${rawUrl.replace(/\/$/, "")}?wsdl`,
    };
    const mellat = new MellatCheckout(config);
    // The package mutates a shared BaseConfig object. Each operation needs a frozen snapshot.
    mellat.config = { ...config };
    return mellat;
  },

  formatCallbackUrl(_callbackURL?: string, purpose: "order" | "wallet" = "order"): string {
    try {
      const base = new URL(process.env.URL || "https://api.infinitycolor.co/");
      if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw new Error();
      return new URL(purpose === "wallet" ? "/api/wallet/payment-callback" :
        "/api/orders/payment-callback", base.origin).toString();
    } catch (_) {
      throw new MellatAdapterError("MELLAT_CALLBACK_INVALID", "Mellat server callback URL is invalid");
    }
  },

  generateRequestId(prefix = "REQ"): string {
    return `${prefix}-${Date.now()}-${randomBytes(6).toString("hex")}`;
  },

  logMellatErrorCode(requestId: string, resCode: number): void {
    strapi.log.warn(`[${requestId}] Mellat provider rejected request`, { resCode });
  },

  async requestPayment(params: MellatPaymentParams): Promise<PaymentResponse> {
    const requestId = this.generateRequestId();
    const context: Partial<PaymentResponse> = {};
    try {
      context.saleOrderId = mellatLong(params.orderId);
      context.requestedAmountIrr = mellatAmountIrr(params.amount, params.amountInRial);
      const callbackUrl = this.formatCallbackUrl(params.callbackURL, params.callbackPurpose);
      const payerId = params.includePayerId ? mellatLong(params.userId, true) : "0";
      const mellat = this.createMellatClient();
      context.terminalFingerprint = mellatTerminalFingerprint(mellat.config.terminalId, mellat.config.username);
      await withDeadline(() => mellat.initialize());
      const response = parseMellatReturn(await rawSoapCall(mellat.client, "bpPayRequest", {
        terminalId: mellat.config.terminalId,
        userName: mellat.config.username,
        userPassword: mellat.config.password,
        orderId: context.saleOrderId,
        amount: context.requestedAmountIrr,
        ...mellatLocalDateTime(),
        callBackUrl: callbackUrl,
        payerId,
        additionalData: "",
      }), true);
      const { valid, ...provider } = response;
      if (!valid) return {
        ...context, ...provider, success: false, ambiguous: true, requestId,
        error: "Invalid Mellat SOAP response", errorCode: "MELLAT_MALFORMED_RESPONSE",
      };
      if (response.resCode !== 0) {
        this.logMellatErrorCode(requestId, response.resCode!);
        return {
          ...context, ...provider, success: false, ambiguous: false, requestId,
          error: `Gateway error: ${response.rawResCode}`,
        };
      }
      return {
        ...context, ...provider, success: true, ambiguous: false, requestId,
        redirectUrl: PAYMENT_URL, message: "Payment request successful",
      };
    } catch (error) {
      return { ...context, success: false, requestId, ...safeFailure(error) };
    }
  },

  async transactionRequest(method: string, prefix: string, params: MellatVerifyParams,
    successCodes: number[], inquiry = false): Promise<PaymentResponse> {
    const requestId = this.generateRequestId(prefix);
    const context: Partial<PaymentResponse> = {};
    try {
      const tuple = {
        orderId: mellatLong(params.orderId),
        saleOrderId: mellatLong(params.saleOrderId),
        saleReferenceId: mellatLong(params.saleReferenceId),
      };
      context.saleOrderId = tuple.saleOrderId;
      if (params.requestedAmountIrr !== undefined) {
        context.requestedAmountIrr = mellatAmountIrr(params.requestedAmountIrr, true);
      }
      const mellat = this.createMellatClient();
      context.terminalFingerprint = mellatTerminalFingerprint(mellat.config.terminalId, mellat.config.username);
      await withDeadline(() => mellat.initialize());
      const response = parseMellatReturn(await rawSoapCall(mellat.client, method, {
        terminalId: mellat.config.terminalId,
        userName: mellat.config.username,
        userPassword: mellat.config.password,
        ...tuple,
      }));
      const { valid, ...provider } = response;
      if (!valid) return {
        ...context, ...provider, success: false, ambiguous: true, requestId,
        error: "Invalid Mellat SOAP response", errorCode: "MELLAT_MALFORMED_RESPONSE",
      };
      const success = inquiry || successCodes.includes(response.resCode!);
      if (!success) this.logMellatErrorCode(requestId, response.resCode!);
      return {
        ...context, ...provider, success, ambiguous: false, requestId,
        ...(success ? { message: `Mellat ${prefix.toLowerCase()} response: ${response.rawResCode}` }
          : { error: `Gateway error: ${response.rawResCode}` }),
      };
    } catch (error) {
      return { ...context, success: false, requestId, ...safeFailure(error) };
    }
  },

  async verifyTransaction(params: MellatVerifyParams): Promise<PaymentResponse> {
    return this.transactionRequest("bpVerifyRequest", "VERIFY", params, [0, 43]);
  },

  async settleTransaction(params: MellatVerifyParams): Promise<PaymentResponse> {
    return this.transactionRequest("bpSettleRequest", "SETTLE", params, [0, 45]);
  },

  async reverseTransaction(params: MellatVerifyParams): Promise<PaymentResponse> {
    return this.transactionRequest("bpReversalRequest", "REVERSE", params, [0, 48]);
  },

  async inquiryTransaction(params: MellatVerifyParams): Promise<PaymentResponse> {
    return this.transactionRequest("bpInquiryRequest", "INQUIRY", params, [], true);
  },
});
