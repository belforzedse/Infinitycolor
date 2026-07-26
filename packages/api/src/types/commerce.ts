/** Shared storefront/backend contracts for product-critical commerce journeys. */
export type CheckoutGatewayCode = "samankish" | "mellat" | "zarinpal" | "snappay" | "wallet";

export type PaymentAttemptStatus =
  | "Created"
  | "Redirected"
  | "Pending"
  | "Succeeded"
  | "Failed"
  | "Cancelled"
  | "Unknown"
  | "Expired";

export interface CheckoutAddressPayload {
  shipping_city: number;
  PostalCode: string;
  FullAddress: string;
  Description?: string;
  save?: boolean;
}

export interface CheckoutQuoteRequest {
  shipping?: number;
  description?: string;
  note?: string;
  callbackURL?: string;
  addressId?: number;
  addressPayload?: CheckoutAddressPayload;
  gateway?: CheckoutGatewayCode;
  mobile?: string;
  discountCode?: string;
  reserveShipping?: boolean;
  reserveGroupId?: string;
}

export interface FinancialSummary {
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  total: number;
}

export interface CheckoutQuoteResponse {
  success: boolean;
  quoteHash: string;
  financialSummary: FinancialSummary;
}

export interface FinalizeCartRequest extends CheckoutQuoteRequest {
  /** Required for all gateways except the preserved legacy SnappPay flow. */
  attemptId?: string;
  /** Required for all gateways except the preserved legacy SnappPay flow. */
  quoteHash?: string;
}

export interface FinalizeCartResponse {
  success: boolean;
  message: string;
  orderId: number;
  contractId?: number;
  redirectUrl?: string;
  refId?: string;
  financialSummary?: FinancialSummary;
  requestId?: string;
  attemptId?: string;
  paymentStatus?: PaymentAttemptStatus;
  errorCode?: string;
  reserveGroupId?: string;
  reserveExpiresAt?: string;
}

export interface OrderPaymentStatusResponse {
  success: boolean;
  orderId: number;
  status: string;
  isPaid: boolean;
  transactionId?: string | number | null;
  paymentGateway?: string | null;
  paymentStatus?: PaymentAttemptStatus;
  attemptId?: string;
  amountIrr?: number;
  canRetry?: boolean;
  nextAction?: "view_order" | "return_to_cart" | "recheck";
  failureCode?: string;
  failureMessage?: string;
  lastReconciledAt?: string;
  authoritative?: true;
}

export interface GuestCartMergeOutcome {
  productVariationId: number;
  quantity: number;
  appliedQuantity?: number;
  resultingQuantity?: number;
  available?: number;
  reason?: string;
}

export interface GuestCartMergeResponse {
  success: true;
  mergeId: string;
  replayed: boolean;
  accepted: GuestCartMergeOutcome[];
  adjusted: GuestCartMergeOutcome[];
  rejected: GuestCartMergeOutcome[];
}

export interface AdminGatewayToggle {
  code: CheckoutGatewayCode;
  title: string;
  active: boolean;
  configured: boolean;
  updatedAt: string | null;
}

export interface AdminOrderTransitionRequest {
  status: "Shipment" | "Done";
}
