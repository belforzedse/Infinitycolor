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
  /** Open a new 48h combined-shipping window with this order. */
  reserveShipping?: boolean;
  /** Attach this order to an existing window; shipping is then charged at 0. */
  reserveGroupId?: string;
}

/** Lifecycle of a combined-shipping group. Owned by the backend. */
export type ReserveGroupState =
  | "PendingActivation"
  | "Active"
  | "ReadyToFulfill"
  | "Fulfilling"
  | "Completed"
  | "Cancelled";

/** How an ended window ended. Kept so history stays readable after the fact. */
export type ReserveClosureReason =
  | "Expired"
  | "ReleasedEarly"
  | "ReleasedByAdmin"
  | "RootAbandoned";

/**
 * An order's reserve state, projected server-side from the group row.
 *
 * Never derived on the client: the order's own `reserveExpiresAt` column is
 * frozen at checkout and goes stale as soon as the window closes.
 */
export interface OrderReserveView {
  isReserveOrder: boolean;
  reserveGroupId: string | null;
  reserveExpiresAt: string | null;
  reserveState: ReserveGroupState | null;
  reserveClosureReason: ReserveClosureReason | null;
  reserveIsActive: boolean;
  reserveIsHeld: boolean;
}

/** The customer's single attachable window, as returned by /orders/active-reserve. */
export interface ActiveReserveGroup {
  reserveGroupId: string;
  reserveExpiresAt: string | null;
  orders: unknown[];
  orderCount: number;
  shippingCostPaid: number;
  shippingMethodTitle: string | null;
  deliveryAddress: unknown;
  lastOrderAttachedAt: string | null;
  rootOrderId: number | null;
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
  gateway: CheckoutGatewayCode;
  attemptId: string;
  quoteHash: string;
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
  /** True when this order joined an existing window rather than opening one. */
  reserveAttached?: boolean;
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
  /** Present when the paid order belongs to a combined-shipping group. */
  reserveGroupId?: string | null;
  reserveExpiresAt?: string | null;
  reserveState?: ReserveGroupState | null;
  reserveOrderCount?: number;
  reserveAttached?: boolean;
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
