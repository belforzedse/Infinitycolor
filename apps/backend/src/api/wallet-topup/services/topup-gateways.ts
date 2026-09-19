import type { Strapi } from "@strapi/strapi";
import { isCheckoutGatewayEnabled } from "../../payment-gateway/services/checkout-gateway-availability";

/**
 * Per-provider adapters for wallet top-ups.
 *
 * A top-up is not an order: it has no cart, no stock, no coupon and no
 * contract. What it shares with a checkout is the hard part — an external
 * payment whose outcome must be established by the server, exactly once, from
 * evidence the provider gives us rather than from whatever the browser was
 * redirected back with.
 *
 * SnappPay is deliberately absent. It is a buy-now-pay-later lender; letting a
 * customer borrow money to load store credit turns a purchase financing product
 * into a cash-advance one.
 */

export type TopupGatewayCode = "Mellat" | "SamanKish" | "ZarinPal";

export const TOPUP_GATEWAYS: readonly TopupGatewayCode[] = [
  "Mellat",
  "SamanKish",
  "ZarinPal",
];

const GATEWAY_TITLES: Record<TopupGatewayCode, string> = {
  Mellat: "بانک ملت",
  SamanKish: "سامان‌کیش",
  ZarinPal: "زرین‌پال",
};

/** Checkout-gateway code for the availability lookup. */
const CHECKOUT_CODE = {
  Mellat: "mellat",
  SamanKish: "samankish",
  ZarinPal: "zarinpal",
} as const;

export type TopupInitiation =
  | {
      outcome: "redirect";
      /** The provider's own handle for this attempt, persisted before we redirect. */
      providerReference: string;
      redirectUrl: string;
      /** Mellat needs a form POST of its RefId; the others are plain redirects. */
      method: "GET" | "POST";
      formFields?: Record<string, string>;
    }
  | { outcome: "failed"; errorCode: string; message: string }
  | { outcome: "unknown"; errorCode: string; message: string };

export type TopupCallback = {
  gateway: TopupGatewayCode;
  /** Our own minted reference, when the provider echoes one back. */
  saleOrderId?: string;
  /** The provider's handle: Mellat RefId, Saman RefNum, ZarinPal Authority. */
  providerReference?: string;
  /** Mellat's settlement reference, present only on success. */
  saleReferenceId?: string;
  /** What the browser claims happened. Informational until the server verifies. */
  declaredSuccess: boolean;
  rawCode?: string;
};

export type TopupVerification =
  | {
      outcome: "confirmed";
      /** The reference the ledger entry is keyed on. */
      providerReference: string;
      providerCode: number | null;
      amountIrr?: number;
    }
  | { outcome: "failed"; providerCode: number | null; message: string }
  | { outcome: "unknown"; providerCode: number | null; message: string };

const truthy = (value?: string): boolean =>
  ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

const numericOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const text = (value: unknown): string => String(value ?? "").trim();

export const isTopupGatewayCode = (value: unknown): value is TopupGatewayCode =>
  TOPUP_GATEWAYS.includes(text(value) as TopupGatewayCode);

/**
 * Which gateways may fund a wallet right now: the operator's allow-list,
 * intersected with the gateways that are actually configured and switched on
 * for checkout. A gateway the store cannot charge with is never offered.
 */
export async function resolveTopupGateways(
  strapi: Strapi,
): Promise<Array<{ code: TopupGatewayCode; title: string }>> {
  const configured = text(process.env.WALLET_TOPUP_GATEWAYS) || "mellat";
  const allowed = new Set(
    configured
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );

  const available: Array<{ code: TopupGatewayCode; title: string }> = [];
  for (const code of TOPUP_GATEWAYS) {
    if (!allowed.has(code.toLowerCase())) continue;
    if (!(await isCheckoutGatewayEnabled(strapi, CHECKOUT_CODE[code]))) continue;
    available.push({ code, title: GATEWAY_TITLES[code] });
  }
  return available;
}

/** `${base}/api/wallet/payment-callback` — never the order callback. */
export function walletCallbackUrl(strapi: Strapi): string {
  const configured = text(
    strapi.config.get("server.url", process.env.URL || ""),
  );
  let baseUrl = configured;
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = text(process.env.URL);
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error("WALLET_CALLBACK_URL_UNCONFIGURED");
  }
  baseUrl = baseUrl.replace(/\/$/, "").replace(/\/api$/i, "");
  return `${baseUrl}/api/wallet/payment-callback`;
}

/**
 * Asks the provider to open a payment session.
 *
 * The outcome is three-way on purpose. "Failed" means the provider answered and
 * refused, so nothing exists and the intent can be closed. "Unknown" means we
 * never got an answer — a timeout, a dropped response — and a session may well
 * exist, so the intent stays open for reconciliation instead of being marked
 * failed and forgotten.
 */
export async function initiateTopup(
  strapi: Strapi,
  params: {
    gateway: TopupGatewayCode;
    saleOrderId: string;
    amountIrr: number;
    mobile?: string;
  },
): Promise<TopupInitiation> {
  const callbackUrl = walletCallbackUrl(strapi);

  if (params.gateway === "Mellat") {
    const mellat = strapi.service("api::payment-gateway.mellat-v3") as any;
    if (!mellat) {
      return { outcome: "failed", errorCode: "MELLAT_UNAVAILABLE", message: "Mellat service missing" };
    }
    const response = await mellat.requestPayment({
      orderId: Number(params.saleOrderId),
      amount: params.amountIrr,
      amountInRial: true,
      callbackURL: callbackUrl,
    });
    if (response?.success && text(response.refId)) {
      return {
        outcome: "redirect",
        providerReference: text(response.refId),
        redirectUrl: text(response.redirectUrl),
        // Mellat's gateway is entered by POSTing the RefId, not by a GET.
        method: "POST",
        formFields: { RefId: text(response.refId) },
      };
    }
    // `resCode` present means the bank answered; anything else was a transport
    // failure and may still have opened a session.
    return numericOrNull(response?.resCode) !== null
      ? {
          outcome: "failed",
          errorCode: `MELLAT_${response.resCode}`,
          message: text(response?.error) || "Mellat refused the request",
        }
      : {
          outcome: "unknown",
          errorCode: "MELLAT_INITIATION_UNKNOWN",
          message: text(response?.error) || "Mellat did not answer",
        };
  }

  if (params.gateway === "SamanKish") {
    const saman = strapi.service("api::payment-gateway.saman-kish") as any;
    const response = await saman.requestPayment({
      orderId: Number(params.saleOrderId),
      amount: params.amountIrr,
      callbackURL: callbackUrl,
      // Our minted reference travels as ResNum and comes back on the callback.
      resNum: params.saleOrderId,
      cellNumber: params.mobile,
    });
    if (response?.success && text(response.token)) {
      return {
        outcome: "redirect",
        providerReference: text(response.token),
        redirectUrl: text(response.redirectUrl),
        method: "GET",
      };
    }
    return numericOrNull(response?.status) !== null
      ? {
          outcome: "failed",
          errorCode: `SAMAN_${response.status}`,
          message: text(response?.error) || "Saman refused the request",
        }
      : {
          outcome: "unknown",
          errorCode: "SAMAN_INITIATION_UNKNOWN",
          message: text(response?.error) || "Saman did not answer",
        };
  }

  const zarinpal = strapi.service("api::payment-gateway.zarinpal") as any;
  const response = await zarinpal.requestPayment({
    orderId: Number(params.saleOrderId),
    amountToman: Math.floor(params.amountIrr / 10),
    mobile: params.mobile,
    description: `Wallet top-up ${params.saleOrderId}`,
    callbackUrl,
  });
  if (response?.success && text(response.authority)) {
    return {
      outcome: "redirect",
      providerReference: text(response.authority),
      redirectUrl: text(response.redirectUrl),
      method: "GET",
    };
  }
  return numericOrNull(response?.code) !== null
    ? {
        outcome: "failed",
        errorCode: `ZARINPAL_${response.code}`,
        message: text(response?.error) || "ZarinPal refused the request",
      }
    : {
        outcome: "unknown",
        errorCode: "ZARINPAL_INITIATION_UNKNOWN",
        message: text(response?.error) || "ZarinPal did not answer",
      };
}

/**
 * Works out which provider a callback came from, and what it is claiming.
 *
 * Providers return by different methods — Mellat POSTs a form, ZarinPal sends
 * the browser back with `?Authority=&Status=` — so both the query string and
 * the body are read. Nothing here is trusted: the fields only identify *which*
 * durable intent to look at, and the intent's own stored gateway decides how it
 * is verified.
 */
export function parseTopupCallback(input: {
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}): TopupCallback | null {
  const merged: Record<string, unknown> = { ...(input.query || {}), ...(input.body || {}) };
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = text(merged[key]);
      if (value) return value;
    }
    return "";
  };

  const authority = pick("Authority", "authority");
  if (authority) {
    const status = pick("Status", "status").toUpperCase();
    return {
      gateway: "ZarinPal",
      providerReference: authority,
      declaredSuccess: status === "OK",
      rawCode: status || undefined,
    };
  }

  const resCode = pick("ResCode", "resCode");
  const saleOrderId = pick("SaleOrderId", "saleOrderId");
  if (resCode || pick("SaleReferenceId", "saleReferenceId")) {
    return {
      gateway: "Mellat",
      saleOrderId: saleOrderId || undefined,
      providerReference: pick("RefId", "refId") || undefined,
      saleReferenceId: pick("SaleReferenceId", "saleReferenceId") || undefined,
      declaredSuccess: resCode === "0",
      rawCode: resCode || undefined,
    };
  }

  const refNum = pick("RefNum", "refNum");
  const resNum = pick("ResNum", "resNum");
  if (refNum || resNum) {
    const state = pick("State", "state");
    return {
      gateway: "SamanKish",
      saleOrderId: resNum || undefined,
      providerReference: refNum || undefined,
      declaredSuccess: state.toUpperCase() === "OK",
      rawCode: state || undefined,
    };
  }

  return null;
}

/**
 * Establishes, from the provider, whether this intent was actually paid.
 *
 * The browser's claim is never the evidence. `unknown` is a first-class answer:
 * a verification we could not complete leaves the intent open for the
 * reconciler rather than crediting or closing it.
 */
export async function verifyTopup(
  strapi: Strapi,
  params: {
    gateway: TopupGatewayCode;
    saleOrderId: string;
    amountIrr: number;
    providerReference: string;
    saleReferenceId?: string;
  },
): Promise<TopupVerification> {
  if (params.gateway === "Mellat") {
    const mellat = strapi.service("api::payment-gateway.mellat-v3") as any;
    const saleReferenceId = text(params.saleReferenceId);
    if (!saleReferenceId) {
      return { outcome: "unknown", providerCode: null, message: "Mellat callback carried no settlement reference" };
    }
    const verify = await mellat.verifyTransaction({
      orderId: params.saleOrderId,
      saleOrderId: params.saleOrderId,
      saleReferenceId,
    });
    const verifyCode = numericOrNull(verify?.resCode);
    // 43 is "already verified": a replay of a verification that succeeded.
    if (!verify?.success && verifyCode !== 43) {
      return {
        outcome: "unknown",
        providerCode: verifyCode,
        message: text(verify?.error) || "Mellat verification is ambiguous",
      };
    }
    const settle = await mellat.settleTransaction({
      orderId: params.saleOrderId,
      saleOrderId: params.saleOrderId,
      saleReferenceId,
      allowResCode45Success: true,
    });
    const settleCode = numericOrNull(settle?.resCode);
    if (settle?.success || settleCode === 0 || settleCode === 45) {
      return { outcome: "confirmed", providerReference: saleReferenceId, providerCode: settleCode };
    }
    return {
      outcome: "unknown",
      providerCode: settleCode,
      message: text(settle?.error) || "Mellat settlement is ambiguous",
    };
  }

  if (params.gateway === "SamanKish") {
    const saman = strapi.service("api::payment-gateway.saman-kish") as any;
    const refNum = text(params.providerReference);
    if (!refNum) {
      return { outcome: "unknown", providerCode: null, message: "Saman callback carried no RefNum" };
    }
    const verify = await saman.verifyTransaction({ refNum });
    const resultCode = numericOrNull(verify?.resultCode);
    if (!verify?.success || resultCode !== 0) {
      return {
        outcome: "failed",
        providerCode: resultCode,
        message: text(verify?.resultDescription) || "Saman verification failed",
      };
    }
    const detail = verify.transactionDetail || verify.TransactionDetail || {};
    const settledIrr = numericOrNull(detail?.AffectiveAmount ?? detail?.OrginalAmount);
    // A settled amount that is not what we asked for is not our payment.
    if (settledIrr !== null && settledIrr > 0 && settledIrr !== params.amountIrr) {
      try {
        await saman.reverseTransaction({ refNum });
      } catch (error) {
        strapi.log.error(
          `Saman wallet top-up amount mismatch could not be reversed for ${params.saleOrderId}: ${String(
            (error as any)?.message || error,
          ).slice(0, 200)}`,
        );
        return {
          outcome: "unknown",
          providerCode: resultCode,
          message: "Saman amount mismatch and the reversal outcome is unknown",
        };
      }
      return {
        outcome: "failed",
        providerCode: resultCode,
        message: `Saman settled ${settledIrr} IRR for a ${params.amountIrr} IRR top-up`,
      };
    }
    return { outcome: "confirmed", providerReference: refNum, providerCode: resultCode, amountIrr: settledIrr ?? undefined };
  }

  const zarinpal = strapi.service("api::payment-gateway.zarinpal") as any;
  const authority = text(params.providerReference);
  if (!authority) {
    return { outcome: "unknown", providerCode: null, message: "ZarinPal callback carried no authority" };
  }
  // The amount is an input to ZarinPal's verification, so a mismatch cannot be
  // confirmed at all — the provider itself rejects it.
  const verify = await zarinpal.verifyPayment({
    authority,
    amountToman: Math.floor(params.amountIrr / 10),
    callbackUrl: walletCallbackUrl(strapi),
  });
  const code = numericOrNull(verify?.code);
  if (verify?.success) {
    return {
      outcome: "confirmed",
      providerReference: text(verify.refId) || authority,
      providerCode: code,
    };
  }
  if (verify?.ambiguous) {
    return {
      outcome: "unknown",
      providerCode: code,
      message: text(verify?.error) || "ZarinPal verification is ambiguous",
    };
  }
  return {
    outcome: "failed",
    providerCode: code,
    message: text(verify?.message) || text(verify?.error) || "ZarinPal verification failed",
  };
}

export const walletTopupLimits = () => ({
  enabled: truthy(process.env.WALLET_TOPUP_ENABLED),
  minToman: Math.max(1, Number(process.env.WALLET_TOPUP_MIN_TOMAN || 10_000)),
  maxToman: Math.max(1, Number(process.env.WALLET_TOPUP_MAX_TOMAN || 50_000_000)),
  maxPending: Math.max(1, Number(process.env.WALLET_TOPUP_MAX_PENDING || 3)),
  ttlMinutes: Math.max(1, Number(process.env.WALLET_TOPUP_TTL_MINUTES || 30)),
  presetsToman: text(process.env.WALLET_TOPUP_PRESETS_TOMAN || "100000,200000,500000,1000000")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((value) => Number.isInteger(value) && value > 0),
});
