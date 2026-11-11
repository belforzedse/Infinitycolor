import { checkoutPath } from "./checkout-path";
import type { PaymentCapabilities } from "@repo/api/commerce";
import { apiClient } from "../index";
import type {
  CartStockCheckResponse,
  CheckoutQuoteRequest,
  CheckoutQuoteResponse,
  CheckoutGatewayCode,
} from "./types/cart";
import { unwrap } from "./helpers/response";
import { CHECKOUT_MAX_RETRIES, CHECKOUT_REQUEST_TIMEOUT_MS } from "@/constants/api";

type SnappEligibilityResponse = {
  eligible: boolean;
  title?: string;
  description?: string;
  amountIRR?: number;
};

type ShippingPreviewResponse = {
  success: boolean;
  shipping: number;
  weight?: number;
  message?: string;
};

interface AvailableGatewaysResponse {
  gateways?: Array<{
    code?: string;
    title?: string;
  }>;
  paymentCapabilities?: PaymentCapabilities;
}

type ReservationLookupFailedError = {
  errorCode?: string;
  message?: string;
  data?: CartStockCheckResponse;
};

const isReservationLookupFailed = (error: unknown): error is ReservationLookupFailedError => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as ReservationLookupFailedError;
  return (
    candidate.errorCode === "RESERVATION_LOOKUP_FAILED" ||
    candidate.data?.errorCode === "RESERVATION_LOOKUP_FAILED"
  );
};

export const checkCartStock = async (
  attemptId?: string,
  baleCheckoutId?: string,
): Promise<CartStockCheckResponse> => {
  const normalizedAttemptId = String(attemptId || "").trim();
  const query = normalizedAttemptId
    ? `?attemptId=${encodeURIComponent(normalizedAttemptId)}`
    : "";
  try {
    const response = await apiClient.get<CartStockCheckResponse>(checkoutPath(`/carts/check-stock${query}`, baleCheckoutId));
    return unwrap<CartStockCheckResponse>(response);
  } catch (error: unknown) {
    if (!isReservationLookupFailed(error)) throw error;
    return {
      success: false,
      valid: false,
      errorCode: "RESERVATION_LOOKUP_FAILED",
      message: error.data?.message || error.message,
      reservationOutcome: "unavailable",
      cart: error.data?.cart,
    };
  }
};

export const getCheckoutQuote = async (
  data: CheckoutQuoteRequest,
  baleCheckoutId?: string,
): Promise<CheckoutQuoteResponse> => {
  const response = await apiClient.post<CheckoutQuoteResponse>(checkoutPath("/carts/quote", baleCheckoutId), data);
  return unwrap<CheckoutQuoteResponse>(response);
};

export const getSnappEligible = async (
  params: {
    amount?: number;
    shippingId?: number;
    discountCode?: string;
  } = {},
  baleCheckoutId?: string,
): Promise<SnappEligibilityResponse> => {
  const qs = new URLSearchParams();
  if (params.amount) qs.set("amount", String(params.amount));
  if (params.shippingId) qs.set("shippingId", String(params.shippingId));
  if (params.discountCode) qs.set("discountCode", params.discountCode);

  const query = qs.toString();

  const url = `/payment-gateway/snapp-eligible${query ? `?${query}` : ""}`;


  try {
    const response = await apiClient.get<SnappEligibilityResponse>(checkoutPath(url, baleCheckoutId), {
      timeout: CHECKOUT_REQUEST_TIMEOUT_MS,
      retries: CHECKOUT_MAX_RETRIES,
    });
    return unwrap<SnappEligibilityResponse>(response) ?? { eligible: false };
  } catch {
    return { eligible: false };
  }
};

export const getShippingPreview = async (
  params:
    | number
    | {
        addressId: number;
        shippingId?: number;
      },
): Promise<ShippingPreviewResponse> => {
  const resolved =
    typeof params === "number"
      ? { addressId: params }
      : { addressId: params.addressId, shippingId: params.shippingId };


  try {
    const response = await apiClient.post<ShippingPreviewResponse>("/carts/shipping-preview", resolved);

    return unwrap<ShippingPreviewResponse>(response) ?? { success: false, shipping: 0 };
  } catch {
    return { success: false, shipping: 0 };
  }
};

const parseGatewayCodes = (payload: AvailableGatewaysResponse | undefined) =>
  (payload?.gateways || [])
    .map((item) => String(item?.code || "").toLowerCase())
    .filter(
      (code): code is CheckoutGatewayCode =>
        code === "samankish" ||
        code === "mellat" ||
        code === "snappay" ||
        code === "wallet" ||
        code === "zarinpal",
    );

export const getAvailableGateways = async (): Promise<CheckoutGatewayCode[]> => {
  try {
    const response = await apiClient.get<AvailableGatewaysResponse>("/payment-gateway/available", {
      timeout: CHECKOUT_REQUEST_TIMEOUT_MS,
      retries: CHECKOUT_MAX_RETRIES,
    });
    return parseGatewayCodes(unwrap<AvailableGatewaysResponse>(response));
  } catch {
    return [];
  }
};

/**
 * The gateways *and* what the store will accept alongside them.
 *
 * Capabilities travel with the gateway list because both answer the same
 * question — what may this checkout offer — and the UI must never infer a
 * server feature flag from an absent field.
 */
export const getCheckoutPaymentOptions = async (): Promise<{
  gateways: CheckoutGatewayCode[];
  paymentCapabilities: PaymentCapabilities | null;
}> => {
  try {
    const response = await apiClient.get<AvailableGatewaysResponse>("/payment-gateway/available", {
      timeout: CHECKOUT_REQUEST_TIMEOUT_MS,
      retries: CHECKOUT_MAX_RETRIES,
    });
    const payload = unwrap<AvailableGatewaysResponse>(response);
    return {
      gateways: parseGatewayCodes(payload),
      paymentCapabilities: payload?.paymentCapabilities ?? null,
    };
  } catch {
    return { gateways: [], paymentCapabilities: null };
  }
};
