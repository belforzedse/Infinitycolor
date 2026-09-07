import { apiClient } from "@/services";
import { ENDPOINTS } from "@/constants/api";
import type { PaginatedResponse } from "@/types/api";

export interface CategoryAttributes {
  Title: string;
  Slug?: string;
  Parent?: string;
  /**
   * Populated so pickers can show where a category sits. The legacy `Parent`
   * string above is unused in current data; this relation is the real one.
   */
  parent?: {
    data?: { id: number; attributes?: { Title?: string } } | null;
  } | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface categoryResponseType {
  id: number;
  attributes: CategoryAttributes;
}

export const getAllCategories = async (): Promise<PaginatedResponse<categoryResponseType>> => {
  const endpoint = `${ENDPOINTS.PRODUCT.CATEGORY}`;
  try {
    // Use no-store cache for super-admin pages to ensure fresh data
    const response = await apiClient.get<PaginatedResponse<categoryResponseType>>(endpoint, {
      params: {
        "pagination[limit]": -1, // Fetch ALL categories without pagination limit
        "populate[parent]": "*", // Needed to show each category's place in the tree
        sort: "createdAt:desc", // Sort by newest first so new categories appear at the top
      },
      cache: "no-store",
    });
    return response.data;
  } catch (error) {
    // Error will be thrown and handled by caller
    throw error;
  }
};
