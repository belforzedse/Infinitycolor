import { checkoutPath } from "./checkout-path";
import { apiClient } from "../index";
import { unwrap } from "./helpers/response";
import type { ShippingAddressContext } from "../shipping";

type DiscountPayload =
  | string
  | ({
      code: string;
      shippingId?: number;
    } & ShippingAddressContext);

interface DiscountResponse {
  success: boolean;
  code: string;
  type: "Discount" | "Cash";
  amount: number;
  discount: number;
  summary: {
    subtotal: number;
    eligibleSubtotal: number;
    tax: number;
    shipping: number;
    total: number;
    taxPercent: number;
  };
}

const normaliseDiscountPayload = (payload: DiscountPayload) =>
  typeof payload === "string" ? { code: payload } : payload;

export const applyDiscount = async (payload: DiscountPayload, baleCheckoutId?: string): Promise<DiscountResponse> => {
  const response = await apiClient.post<DiscountResponse>(checkoutPath("/carts/apply-discount", baleCheckoutId), normaliseDiscountPayload(payload));
  return unwrap<DiscountResponse>(response);
};
