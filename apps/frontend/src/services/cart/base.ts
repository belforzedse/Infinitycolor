import { checkoutPath } from "./checkout-path";
import { apiClient } from "../index";
import type { CartResponse } from "./types/cart";

export const getUserCart = async (baleCheckoutId?: string): Promise<CartResponse> => {
  const response = await apiClient.get<CartResponse>(checkoutPath("/carts/me", baleCheckoutId));
  return response.data;
};
