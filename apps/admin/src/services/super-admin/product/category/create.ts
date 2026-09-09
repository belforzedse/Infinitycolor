import { apiClient } from "@/services";
import { ENDPOINTS } from "@/constants/api";
import type { ApiResponse } from "@/types/api";
import type { CategoryData } from "./categoryWritePayload";

export type { CategoryData } from "./categoryWritePayload";
export { buildCategoryWritePayload } from "./categoryWritePayload";

export const createCategory = async (
  category: CategoryData,
): Promise<ApiResponse<unknown>> => {
  const endpoint = ENDPOINTS.PRODUCT.CATEGORY;

  try {
    const response = await apiClient.post<ApiResponse<unknown>>(endpoint, {
      data: category,
    });
    return response.data;
  } catch (error) {
    console.error("Error creating category:", error);
    throw error;
  }
};
