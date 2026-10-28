import type { ProductCoverImage } from "@/types/Product";
import type { VariantAttribute } from "@/utils/orderAttributes";
import type { OrderPaymentLeg } from "@/utils/paymentLegs";

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
  /**
   * The variation's other attributes — a «کد» design code, a pattern — each with
   * its own attribute name. Colour/size/model are above only because they have a
   * relation column of their own; these are shown the same way.
   */
  customAttributes?: VariantAttribute[];
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
  addressLine?: string;
  deliveryAddressId?: number;
  shippingCityId?: number;
  shippingCityTitle?: string;
  shippingProvinceId?: number;
  shippingProvinceTitle?: string;
  recipientName?: string;
  recipientPhone?: string;
  postalCode?: string;
  paymentGateway?: string;
  /**
   * Every method that funded this order, with its own amount in IRR. More than
   * one entry means a split payment (typically wallet + gateway), which
   * `paymentGateway` alone cannot represent.
   */
  paymentLegs?: OrderPaymentLeg[];
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
  anipoBarcodeData?: { expectedCount: number; barcodes: string[] } | null;
  anipoSubmittedAt?: string;
  anipoLastCheckedAt?: string;
  anipoPollingDeadlineAt?: string;
  anipoIssuedAt?: string;
  anipoReadyToIssue?: boolean;
  anipoProviderStatus?: string;
  anipoLastMessage?: string;
  anipoLastError?: string;
  anipoRecipientRevision?: number;
  anipoRecipientSyncedRevision?: number;
  anipoRecipientSyncState?: "Pending" | "Synced" | "NeedsAttention";
  anipoRecipientSyncAttempts?: number;
  anipoRecipientSyncLastAttemptAt?: string;
  anipoRecipientSyncLastError?: string;
  anipoRecipientSyncedAt?: string;
  /**
   * Projected server-side from the order's reserve group, never from the order's
   * frozen reserve columns. `reserveIsHeld` means fulfillment is blocked at the
   * API, so the UI must reflect the refusal rather than invite it.
   */
  isReserveOrder?: boolean;
  reserveGroupId?: string | null;
  hasSharedReserveAddress?: boolean;
  reserveState?: string | null;
  reserveClosureReason?: string | null;
  reserveExpiresAt?: string | null;
  reserveIsActive?: boolean;
  reserveIsHeld?: boolean;
}
