import type { ImageResponse, ProductCategory } from "./media";
import type {
  CheckoutGatewayCode as SharedCheckoutGatewayCode,
  CheckoutQuoteRequest as SharedCheckoutQuoteRequest,
  CheckoutQuoteResponse as SharedCheckoutQuoteResponse,
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
}

export interface AddItemRequest {
  productVariationId: number;
  count: number;
}

export interface UpdateItemRequest {
  cartItemId: number;
  count: number;
}

export type FinalizeCartRequest = SharedFinalizeCartRequest;
export type GuestCartMergeResponse = SharedGuestCartMergeResponse;
export type CheckoutQuoteRequest = SharedCheckoutQuoteRequest;
export type CheckoutQuoteResponse = SharedCheckoutQuoteResponse;
export type FinalizeCartResponse = SharedFinalizeCartResponse;

export interface ActiveReserveResponse {
  data: {
    reserveGroupId: string;
    reserveExpiresAt: string;
    orders: unknown[];
    orderCount: number;
  } | null;
}
