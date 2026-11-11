import { apiClient } from "./index";
import { checkoutPath } from "./cart/checkout-path";
import { CHECKOUT_MAX_RETRIES, CHECKOUT_REQUEST_TIMEOUT_MS } from "@/constants/api";

export interface ShippingMethod {
  id: number;
  attributes: {
    Title: string;
    Price: number;
    IsActive: boolean;
    Code?: string;
    Description?: string;
    SortOrder?: number;
    EstimatedDeliveryText?: string;
    Rules?: unknown;
    createdAt: string;
    updatedAt: string;
  };
}

export type ShippingAddressContext = {
  addressId?: number;
  addressPayload?: {
    shipping_city?: number;
  };
};

export interface ShippingOption {
  id: number;
  code: string;
  title: string;
  description?: string;
  estimatedDeliveryText?: string;
  price: number;
  basePrice: number;
  sortOrder: number;
  icon?: unknown;
  matchedRule?: {
    id?: string;
    title?: string;
    priority?: number;
  } | null;
}

export interface ShippingMethodsResponse {
  data: ShippingMethod[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      pageCount: number;
      total: number;
    };
  };
}

export interface ShippingMethodsParams {
  isActive?: boolean;
  page?: number;
  pageSize?: number;
  sort?: string;
}

/**
 * Get available shipping methods
 * @param params Optional parameters for filtering and pagination
 * @returns List of available shipping methods
 */
export const getShippingMethods = async (
  params?: ShippingMethodsParams,
): Promise<ShippingMethod[]> => {
  // Build query parameters
  const queryParams: Record<string, string> = {};

  if (params?.isActive !== undefined) {
    queryParams["filters[IsActive][$eq]"] = params.isActive.toString();
  }

  if (params?.page) {
    queryParams["pagination[page]"] = params.page.toString();
  }

  if (params?.pageSize) {
    queryParams["pagination[pageSize]"] = params.pageSize.toString();
  }

  if (params?.sort) {
    queryParams["sort"] = params.sort;
  }

  // Convert query params to URL parameters
  const queryString = new URLSearchParams(queryParams).toString();
  const endpoint = `/shippings${queryString ? `?${queryString}` : ""}`;

  try {
    const response = await apiClient.getPublic(endpoint, {
      timeout: CHECKOUT_REQUEST_TIMEOUT_MS,
      retries: CHECKOUT_MAX_RETRIES,
    });
    return response.data as ShippingMethod[];
  } catch (error) {
    console.error("Error fetching shipping methods:", error);
    throw error;
  }
};

export const getAvailableShippingOptions = async (
  context?: ShippingAddressContext,
  baleCheckoutId?: string,
): Promise<ShippingOption[]> => {
  try {
    const response = await apiClient.post<{
      data?: { success?: boolean; methods?: ShippingOption[] };
      success?: boolean;
      methods?: ShippingOption[];
    }>(checkoutPath("/carts/shipping-options", baleCheckoutId), context || {}, {
      timeout: CHECKOUT_REQUEST_TIMEOUT_MS,
      retries: CHECKOUT_MAX_RETRIES,
    });
    const payload = response?.data as any;
    const methods = payload?.methods || payload?.data?.methods || [];
    return Array.isArray(methods) ? methods : [];
  } catch (error) {
    console.error("Error fetching available shipping options:", error);
    throw error;
  }
};
