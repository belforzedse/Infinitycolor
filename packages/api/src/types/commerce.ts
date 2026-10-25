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
  FullName?: string;
  Phone?: string;
}

/**
 * Who receives the parcel, as typed at checkout. It can differ from the account
 * placing the order (staff ordering for a customer), so the server stores it on
 * the order's own delivery address rather than reading the profile.
 */
export interface CheckoutRecipient {
  FullName?: string;
  Phone?: string;
}

export interface CheckoutQuoteRequest {
  shipping?: number;
  description?: string;
  note?: string;
  callbackURL?: string;
  addressId?: number;
  addressPayload?: CheckoutAddressPayload;
  /** Sent on every checkout that is not attaching to a reserve shipment. */
  recipient?: CheckoutRecipient;
  gateway?: CheckoutGatewayCode;
  mobile?: string;
  discountCode?: string;
  /** Open a new 48h combined-shipping window with this order. */
  reserveShipping?: boolean;
  /** Attach this order to an existing window; shipping is then charged at 0. */
  reserveGroupId?: string;
  /**
   * How much of the total to pay from wallet credit, in toman. Wallet credit is
   * a tender, not a discount: the total is unchanged and the gateway is asked
   * for `total - walletAmountToman`. Omit or send 0 for an ordinary checkout.
   */
  walletAmountToman?: number;
  /**
   * The customer's own earlier checkout attempt that this request replaces.
   * Only that named attempt's wallet hold may be reused, and only when it is
   * still `Created`. Never used to touch any other checkout.
   */
  supersedeAttemptId?: string;
}

/**
 * What the server will accept for this checkout. Always present on a quote, so
 * the storefront never has to infer a feature flag from a missing field.
 */
export interface PaymentCapabilities {
  walletEnabled: boolean;
  splitEnabled: boolean;
  splitDisabledReason: "disabled" | "unsupported_gateway" | null;
  splitGateways: CheckoutGatewayCode[];
  gatewayMinimumsToman: Record<string, number>;
}

/** The agreed `total = wallet + gateway` split for one checkout. */
export interface PaymentAllocation {
  totalToman: number;
  walletToman: number;
  gatewayToman: number;
  walletBalanceToman: number;
  walletHeldToman: number;
  walletAvailableToman: number;
  walletReusableToman: number;
  /** The gateway the client must submit; `wallet` when credit covers the total. */
  requiredGateway: CheckoutGatewayCode;
}

/** Wallet-specific checkout failures the storefront maps to Persian copy. */
export type WalletCheckoutErrorCode =
  | "WALLET_AMOUNT_INVALID"
  | "WALLET_INSUFFICIENT_AVAILABLE"
  | "WALLET_FUNDS_HELD_BY_PENDING_PAYMENT"
  | "WALLET_COVERS_TOTAL"
  | "WALLET_RESIDUAL_BELOW_GATEWAY_MINIMUM"
  | "WALLET_SPLIT_DISABLED"
  | "WALLET_SPLIT_UNSUPPORTED_GATEWAY"
  | "WALLET_DISABLED"
  | "WALLET_UNAVAILABLE"
  | "WALLET_HOLD_NOT_ACTIVE"
  | "ORDER_HAS_ACTIVE_WALLET_HOLD";

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
  /**
   * Set when the quote itself succeeded but the selected gateway is not usable
   * right now (e.g. SnappPay eligibility timed out). The totals are still valid;
   * the shopper is expected to pick another gateway rather than re-quote.
   */
  gatewayAvailable?: boolean;
  gatewayNotice?: string;
  gatewayErrorCode?: string;
  paymentAllocation?: PaymentAllocation;
  paymentCapabilities?: PaymentCapabilities;
}

export interface FinalizeCartRequest extends CheckoutQuoteRequest {
  gateway: CheckoutGatewayCode;
  attemptId: string;
  quoteHash: string;
}

/** Point-in-time, owner-scoped lookup; missing is not proof that an in-flight request stopped. */
export type CheckoutAttemptLookupResponse =
  | { success: true; lookup: "missing" }
  | {
      success: true;
      lookup: "found";
      attempt: {
        attemptId: string;
        quoteHash: string;
        status: PaymentAttemptStatus;
        orderId?: number;
      };
    };

export interface FinalizeCartResponse {
  success: boolean;
  message: string;
  orderId: number;
  contractId?: number;
  redirectUrl?: string;
  refId?: string;
  redirectMethod?: "GET" | "POST";
  formFields?: Record<string, string>;
  financialSummary?: FinancialSummary;
  requestId?: string;
  attemptId?: string;
  paymentStatus?: PaymentAttemptStatus;
  errorCode?: string;
  /** Present only for a confirmed concurrent stock shortage. */
  details?: { reason?: "insufficient_stock" };
  /** The backend owns the actionable report; the client logs customer impact. */
  telemetryOwner?: "backend";
  reserveGroupId?: string;
  reserveExpiresAt?: string;
  /** True when this order joined an existing window rather than opening one. */
  reserveAttached?: boolean;
  paymentAllocation?: PaymentAllocation;
}

export interface OrderPaymentStatusResponse {
  success: boolean;
  orderId: number;
  status: string;
  isPaid: boolean;
  transactionId?: string | number | null;
  paymentGateway?: string | null;
  shippingMethodCode?: string | null;
  shippingMethodTitle?: string | null;
  paymentStatus?: PaymentAttemptStatus;
  attemptId?: string;
  amountIrr?: number;
  /** Wallet leg of a split payment, in IRR. Absent for an ordinary checkout. */
  walletAmountIrr?: number;
  /** What the gateway was asked to charge, in IRR. Equals `amountIrr` when no wallet was used. */
  gatewayAmountIrr?: number;
  /**
   * Paid orders only: the sum of the order's settled, non-return charge legs,
   * in IRR (wallet + gateway for a split). The analytics `purchase` revenue.
   */
  paidAmountIrr?: number;
  /** Paid orders only: when the last charge leg settled, ISO. */
  paidAt?: string;
  /**
   * Lifecycle of this checkout's wallet credit. `Active` means the money is
   * still committed to this payment and cannot be spent anywhere else, which is
   * the only state where offering to abandon the checkout makes sense.
   */
  walletHoldStatus?: "None" | "DirectDebit" | "Active" | "Captured" | "Released";
  /**
   * How a live hold reads right now.
   *
   * `reclaimable` is the only state where the shopper's own claim can move
   * anything: their statement that they did not pay is consulted only for a
   * token the provider still reports as uncommitted. Everywhere else the
   * release is the worker's job and offering a button would promise something
   * the server would refuse.
   */
  walletHoldState?: "reconciling" | "awaiting_provider" | "reclaimable" | "releasing";
  /** When the credit was committed, ISO. Used to hold the manual button back. */
  walletHeldAt?: string;
  /**
   * Latest moment this hold can still be held: the SnappPay reservation
   * ceiling, or the order's reservation expiry for a bank gateway. Lets the
   * page promise an automatic release *and* say by when.
   */
  walletHoldBoundAt?: string;
  /**
   * Only present on a reconcile sent with `abandon: true`. `false` means the
   * claim was refused — the attempt is already resolved, or the shopper's own
   * successful return reached us first and outranks it — so no release is
   * coming and the page must not promise one.
   */
  walletReleaseRequested?: boolean;
  /**
   * Why `walletReleaseRequested` is what it is. `not_applicable` means this
   * gateway has no provider call behind the claim, so the button is not offered
   * at all rather than offered and silently ignored.
   */
  walletReleaseReason?: "queued" | "already_resolved" | "not_applicable";
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
