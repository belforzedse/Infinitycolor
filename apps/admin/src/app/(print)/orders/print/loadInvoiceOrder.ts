import { apiClient } from "@/services";
import { normalizeOrderForInvoice } from "./normalizeOrder";

export async function loadInvoiceOrder(id: string) {
  const res = await apiClient.get(
    `/orders/${encodeURIComponent(id)}?populate[0]=user
     &populate[1]=contract
     &populate[2]=order_items
     &populate[3]=order_items.product_variation.product.CoverImage
     &populate[4]=order_items.product_variation.Price
     &populate[5]=order_items.product_variation.DiscountPrice
     &populate[6]=order_items.product_color
     &populate[7]=order_items.product_size
     &populate[8]=order_items.product_variation_model
     &populate[9]=user.user_info
     &populate[10]=delivery_address.shipping_city.shipping_province
     &populate[11]=shipping
     &populate[12]=contract.contract_transactions.payment_gateway`,
  );
  return normalizeOrderForInvoice((res as { data?: unknown }).data, id);
}
