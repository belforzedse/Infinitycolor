import type { ImageResponse, ProductCategory } from "./media";
import type {
  CheckoutGatewayCode as SharedCheckoutGatewayCode,
  CheckoutQuoteRequest as SharedCheckoutQuoteRequest,
  CheckoutQuoteResponse as SharedCheckoutQuoteResponse,
  CheckoutAttemptLookupResponse,
  FinalizeCartRequest as SharedFinalizeCartRequest,
  FinalizeCartResponse as SharedFinalizeCartResponse,
  GuestCartMergeResponse as SharedGuestCartMergeResponse,
} from "@repo/api/commerce";

export type CheckoutGatewayCode = SharedCheckoutGatewayCode;

export const DEFAULT_CHECKOUT_GATEWAYS: CheckoutGatewayCode[] = [
  "samankish",
  "mellat",
  "snappay",
  "wallet",
];

export interface CartItemResponse {
  id: number;
  Count: number;
  Sum: string | number;
  /** Server-computed Count minus active reservations at cart-read time. */
  availableStock?: number;
  createdAt?: string;
  updatedAt?: string;
  product_variation: {
    id: number;
    IsPublished?: boolean;
    SKU?: string;
    Price: number | string;
    createdAt?: string;
    updatedAt?: string;
    product_stock: {
      id?: number;
      Count: number;
      createdAt?: string;
      updatedAt?: string;
    };
    product_variation_color?: {
      id: number;
      Title: string;
      ColorCode?: string;
      createdAt?: string;
      updatedAt?: string;
    };
    product_variation_size?: {
      id: number;
      Title: string;
      createdAt?: string;
      updatedAt?: string;
    };
    product_variation_model?: {
      id: number;
      Title: string;
      createdAt?: string;
      updatedAt?: string;
    };
    product: {
      id?: number;
      Title: string;
      Description?: string;
      Status?: string;
      AverageRating?: number | null;
      RatingCount?: number | null;
      SKU?: string;
      category?: string;
      createdAt?: string;
      updatedAt?: string;
      CleaningTips?: string | null;
      ReturnConditions?: string | null;
      removedAt?: string | null;
      CoverImage?: ImageResponse;
      product_main_category?: ProductCategory;
    };
  };
}

export interface CartResponse {
  id: number;
  Status: string;
  cart_items: CartItemResponse[];
}

export interface CartStockCheckResponse {
  success: boolean;
  valid: boolean;
  cartIsEmpty?: boolean;
  itemsAdjusted?: Array<{
    cartItemId: number;
    productVariationId: number;
    requested: number;
    available: number;
    newQuantity: number;
    /** Backend-provided product title (present for some cases; may be missing). */
    productTitle?: string;
    /** English diagnostic message from the backend — do not show to users. */
    message: string;
  }>;
  itemsRemoved?: Array<{
    cartItemId: number;
    productVariationId: number;
    requested?: number;
    available?: number;
    /** Backend-provided product title (present for some removal reasons). */
    productTitle?: string;
    /** English diagnostic message from the backend — do not show to users. */
    message: string;
  }>;
  cart?: CartResponse;
  message?: string;
  errorCode?: string;
  /** Present when check-stock was asked to consider a specific checkout hold. */
  reservationOutcome?: "held" | "expired" | "released" | "ineligible" | "unavailable";
  heldOrderId?: number;
  /**
   * The authenticated user's live Paying reservation, when one exists.
   * Independent of a client-supplied attempt id so resume survives lost localStorage.
   */
  resumableCheckout?: ResumableCheckout | null;
}

/** Live unpaid checkout the server will replay on the same quote. */
export interface ResumableCheckout {
  attemptId: string;
  orderId: number;
  quoteHash: string;
  gateway?: string;
  reservedUntil?: string;
}

export type CheckoutAttemptLookup = CheckoutAttemptLookupResponse;

export interface AddItemRequest {
  productVariationId: number;
  count: number;
}

export interface UpdateItemRequest {
  cartItemId: number;
  count: number;
}

export type FinalizeCartRequest = SharedFinalizeCartRequest & {
  /** Ephemeral browser correlation copied into the authoritative order row. */
  analyticsCorrelationId?: string;
};
export type GuestCartMergeResponse = SharedGuestCartMergeResponse;
export type CheckoutQuoteRequest = SharedCheckoutQuoteRequest;
export type CheckoutQuoteResponse = SharedCheckoutQuoteResponse;
export type FinalizeCartResponse = SharedFinalizeCartResponse;

/** Delivery address as returned alongside an active reserve group. */
export interface ReserveDeliveryAddress {
  id?: number;
  FullName?: string | null;
  FullAddress?: string | null;
  PostalCode?: string | null;
  shipping_city?: {
    Title?: string | null;
    shipping_province?: { Title?: string | null } | null;
  } | null;
}

export interface ActiveReserveResponse {
  data: {
    reserveGroupId: string;
    reserveExpiresAt: string | null;
    orders: unknown[];
    orderCount: number;
    /** Shipping already paid by the group, in Toman. Later orders add nothing. */
    shippingCostPaid?: number;
    shippingMethodTitle?: string | null;
    deliveryAddress?: ReserveDeliveryAddress | null;
    lastOrderAttachedAt?: string | null;
    rootOrderId?: number | null;
  } | null;
}
