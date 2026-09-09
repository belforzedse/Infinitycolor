import type { ProductCoverImage } from "@/types/Product";

export type AnipoBarcodeState =
  | "Pending"
  | "Issued"
  | "NeedsAttention"
  | "Stopped"
  | "Voided";

export interface SuperAdminOrderItem {
  id: number;
  productId: number;
  productName: string;
  productCode: string;
  price: number;
  quantity: number;
  color?: string;
  size?: string;
  model?: string;
  image?: string;
  coverImage?: ProductCoverImage;
}

export interface SuperAdminOrderDetail {
  id: number;
  orderDate: Date;
  orderStatus: string;
  userId: string;
  userName?: string;
  description: string;
  note?: string;
  phoneNumber: string;
  address?: string;
  postalCode?: string;
  paymentGateway?: string;
  transactionId?: string;
  paymentToken?: string | null;
  createdAt: Date;
  updatedAt: Date;
  contractStatus:
    | "Not Ready"
    | "Confirmed"
    | "Finished"
    | "Failed"
    | "Cancelled";
  items: SuperAdminOrderItem[];
  shipping: number;
  shippingMethod?: string;
  shippingMethodCode?: string;
  subtotal: number;
  discount?: number;
  tax?: number;
  total: number;
  shippingBarcode?: string;
  shippingPostPrice?: number;
  shippingTax?: number;
  shippingWeight?: number;
  shippingBoxSizeId?: number;
  anipoBarcodeState?: AnipoBarcodeState;
  anipoSubmittedAt?: string;
  anipoLastCheckedAt?: string;
  anipoPollingDeadlineAt?: string;
  anipoIssuedAt?: string;
  anipoReadyToIssue?: boolean;
  anipoProviderStatus?: string;
  anipoLastMessage?: string;
  anipoLastError?: string;
  /**
   * Projected server-side from the order's reserve group, never from the order's
   * frozen reserve columns. `reserveIsHeld` means fulfillment is blocked at the
   * API, so the UI must reflect the refusal rather than invite it.
   */
  isReserveOrder?: boolean;
  reserveGroupId?: string | null;
  reserveState?: string | null;
  reserveClosureReason?: string | null;
  reserveExpiresAt?: string | null;
  reserveIsActive?: boolean;
  reserveIsHeld?: boolean;
}
