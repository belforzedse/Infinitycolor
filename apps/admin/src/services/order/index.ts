import { apiClient } from "../index";
import { getActiveReserve, releaseReserve } from "./reserve";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import type { OrderPaymentStatusResponse as SharedOrderPaymentStatusResponse } from "@repo/api/commerce";

/** Established callback response used by the SnappPay return journey. */
export interface PaymentVerificationResponse {
  success: boolean;
  message: string;
  orderId: number;
  orderNumber: string;
  paymentStatus: string;
  transactionId?: string | number | null;
}

export interface OrderStatusResponse {
  id: number;
  Status: string;
  OrderNumber: string;
  PaymentStatus: string;
  createdAt: string;
  updatedAt: string;
  Total: number;
}

/**
 * Interface for order payment status check
 */
export type OrderPaymentStatusResponse = SharedOrderPaymentStatusResponse;

/**
 * Interface for user's order list
 */
export interface OrderItem {
  id: number;
  Count: number;
  PerAmount: number;
  ProductTitle: string;
  ProductSKU: string;
  product_variation: {
    id: number;
    product: {
      id: number;
      Title: string;
      cover_image?: {
        url: string;
      };
    } | null;
    product_color?: {
      id: number;
      Title: string;
    };
    product_size?: {
      id: number;
      Title: string;
    };
    product_variation_model?: {
      id: number;
      Title: string;
    };
  };
}

export interface Order {
  id: number;
  Status: string;
  Date: string;
  Type: string;
  ShippingCost: number;
  ShippingMethodCode?: string | null;
  ShippingMethodTitle?: string | null;
  ShippingBarcode?: string;
  isReserveOrder?: boolean;
  reserveExpiresAt?: string | null;
  reserveGroupId?: string | null;
  Description?: string;
  Note?: string;
  createdAt: string;
  updatedAt: string;
  PaymentGateway?: string | null;
  user?: {
    id: number;
    Phone?: string;
    FirstName?: string;
    LastName?: string;
  } | null;
  order_items: OrderItem[];
  shipping?: {
    id: number;
    Title: string;
    Price: number;
  } | null;
  contract?: {
    Amount?: number;
    DiscountAmount?: number;
  };
  delivery_address?: DeliveryAddress | null;
  orderLogs?: OrderLog[];
  contract_transactions?: ContractTransaction[];
}

export interface DeliveryAddress {
  id: number;
  FullAddress?: string;
  PostalCode?: string;
  Name?: string;
  Phone?: string;
  shipping_city?: {
    id: number;
    Title: string;
    shipping_province?: {
      id: number;
      Title: string;
    } | null;
  } | null;
}

export interface OrderLog {
  id: number;
  Action: string;
  Description?: string;
  Changes?: unknown;
  createdAt?: string;
}

export interface ContractTransaction {
  id: number;
  Amount: number;
  Status: string;
  Type: string;
  TrackId?: string;
  Date?: string;
  external_source?: string | null;
  payment_gateway?: {
    id: number;
    Title: string;
    Code?: string;
  } | null;
}

export interface OrdersResponse {
  data: Order[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}

/** Preserve the established callback verification client used by SnappPay. */
export const verifyPayment = async (
  orderId: number,
  refNum: string,
): Promise<PaymentVerificationResponse> => {
  try {
    const response = await apiClient.get<PaymentVerificationResponse>(
      `/orders/verify-payment?orderId=${orderId}&refNum=${refNum}`,
    );
    return response as any;
  } catch (error: any) {
    console.error("Error verifying payment:", error);
    throw error;
  }
};

export const getOrderStatus = async (
  orderId: number,
): Promise<OrderStatusResponse> => {
  try {
    const response = await apiClient.get<OrderStatusResponse>(
      `/orders/${orderId}/status`,
    );
    return response as any;
  } catch (error: any) {
    console.error("Error getting order status:", error);
    throw error;
  }
};

/**
 * Check the payment status of an order
 * @param orderId The order ID
 * @returns Order payment status information
 */
export const getOrderPaymentStatus = async (
  orderId: number,
  signal?: AbortSignal,
): Promise<OrderPaymentStatusResponse> => {
  try {
    const response = signal
      ? await apiClient.get<OrderPaymentStatusResponse>(
          `/orders/${orderId}/payment-status`,
          { signal, suppressAuthRedirect: true },
        )
      : await apiClient.get<OrderPaymentStatusResponse>(
          `/orders/${orderId}/payment-status`,
          { suppressAuthRedirect: true },
        );
    return response.data;
  } catch (error: any) {
    console.error("Error checking order payment status:", error);
    throw error;
  }
};

export const reconcileOrderPayment = async (
  orderId: number,
): Promise<OrderPaymentStatusResponse> => {
  const response = await apiClient.post<OrderPaymentStatusResponse>(
    `/orders/${orderId}/payment-reconcile`,
    {},
  );
  return response.data;
};

export interface GetMyOrdersOptions {
  reserveGroupId?: string;
}

/**
 * Get the list of orders for the current user
 * @param page Page number for pagination
 * @param pageSize Number of orders per page
 * @param options Optional filters (e.g. reserveGroupId for reserve group page)
 * @returns List of user orders with pagination metadata
 */
export const getMyOrders = async (
  page: number = 1,
  pageSize: number = 10,
  options?: GetMyOrdersOptions,
): Promise<OrdersResponse> => {
  const reserveGroupId = options?.reserveGroupId;
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (reserveGroupId) params.set("reserveGroupId", reserveGroupId);

  try {
    const response = await apiClient.get<{ data?: Order[]; meta?: OrdersResponse["meta"] }>(
      `/orders/my-orders?${params.toString()}`,
    );

    // Support multiple response shapes: direct array, { data, meta }, or { data: { data, meta } }
    const raw = response as { data?: Order[] | { data?: Order[]; meta?: OrdersResponse["meta"] }; meta?: OrdersResponse["meta"] } | Order[] | null | undefined;
    let ordersArray: Order[] = [];
    if (Array.isArray(raw)) {
      ordersArray = raw;
    } else if (raw && typeof raw === "object") {
      const inner = raw.data;
      if (Array.isArray(inner)) {
        ordersArray = inner;
      } else if (inner && typeof inner === "object" && Array.isArray(inner.data)) {
        ordersArray = inner.data;
      }
    }

    type Meta = OrdersResponse["meta"];
    const rawObj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { data?: unknown; meta?: Meta }) : null;
    let metaFromResponse: Meta | undefined;
    if (rawObj && "meta" in rawObj && rawObj.meta && typeof rawObj.meta === "object" && "pagination" in rawObj.meta) {
      metaFromResponse = rawObj.meta as Meta;
    } else if (rawObj?.data && typeof rawObj.data === "object" && !Array.isArray(rawObj.data) && "meta" in rawObj.data) {
      const inner = rawObj.data as { meta?: Meta };
      if (inner.meta && typeof inner.meta === "object" && "pagination" in inner.meta) {
        metaFromResponse = inner.meta;
      }
    }

    if (!ordersArray.length && !metaFromResponse) {
      return {
        data: [],
        meta: {
          pagination: {
            page,
            pageSize,
            pageCount: 1,
            total: 0,
          },
        },
      };
    }

    // Add full image URLs and normalize CoverImage -> cover_image for order items
    const ordersWithFullImageUrls = ordersArray.map((order: Order) => ({
      ...order,
      order_items: (order.order_items ?? []).map((item: OrderItem) => {
        const product = item.product_variation?.product as
          | (Record<string, unknown> & { CoverImage?: { url?: string }; cover_image?: { url?: string } })
          | null
          | undefined;
        const coverImage = product?.cover_image ?? product?.CoverImage;
        const imageUrl = coverImage?.url;
        return {
          ...item,
          product_variation: {
            ...item.product_variation,
            product: item.product_variation?.product
              ? {
                  ...item.product_variation.product,
                  cover_image: imageUrl
                    ? { url: getFullImageUrl(imageUrl) }
                    : undefined,
                }
              : null,
          },
        };
      }),
    }));

    const pagination = metaFromResponse?.pagination ?? {
      page,
      pageSize,
      pageCount: 1,
      total: ordersWithFullImageUrls.length,
    };

    const result = {
      data: ordersWithFullImageUrls,
      meta: {
        pagination,
      },
    };

    return result;
  } catch (error: any) {
    console.error("Error fetching user orders:", error);
    throw error;
  }
};

export const getOrderDetail = async (orderId: number): Promise<Order> => {
  try {
    const response = await apiClient.get<Order>(`/orders/my-orders/${orderId}`);
    if (!response?.data) {
      throw new Error("سفارش یافت نشد");
    }
    return response.data;
  } catch (error) {
    console.error("Error fetching order detail:", error);
    throw error;
  }
};

/**
 * Helper function to get full image URL
 */
const getFullImageUrl = (url: string): string => {
  if (!url) return "";
  return resolveAssetUrl(url);
};

// Export all functions as a service object
const OrderService = {
  verifyPayment,
  getOrderStatus,
  getOrderPaymentStatus,
  reconcileOrderPayment,
  getMyOrders,
  getOrderDetail,
  getActiveReserve,
  releaseReserve,
  async generateAnipoBarcode(orderId: number, weight?: number, boxSizeId?: number): Promise<any> {
    try {
      const body: any = {};
      if (weight !== undefined) body.weight = weight;
      if (boxSizeId !== undefined) body.boxSizeId = boxSizeId;

      const res = await apiClient.post(`/orders/${orderId}/anipo-barcode`, body);
      return res as any;
    } catch (error: any) {
      console.error("Error generating Anipo barcode:", {
        error,
        message: error?.message,
        response: error?.response?.data,
        status: error?.response?.status,
        orderId,
        weight,
        boxSizeId,
      });
      throw error;
    }
  },
};

/** Kept for test/backward compatibility; order history is intentionally fetched fresh. */
export const __clearOrderCache = () => undefined;

export default OrderService;
