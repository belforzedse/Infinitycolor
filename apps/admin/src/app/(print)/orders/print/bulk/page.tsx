"use client";

import { useEffect, useState, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { apiClient } from "@/services";
import Invoice, { type InvoiceOrder } from "@/components/invoice";
import { getSiteIdentity } from "@/services/site-identity";
import type { SiteIdentity } from "@/types/site-identity";
import { normalizeOrderForInvoice } from "../normalizeOrder";
import { waitForInvoiceAssets } from "../waitForInvoiceAssets";

export default function BulkPrintPage() {
  const params = useSearchParams();
  const [orders, setOrders] = useState<InvoiceOrder[]>([]);
  const [identity, setIdentity] = useState<SiteIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const hasPrinted = useRef(false);

  useEffect(() => {
    let active = true;
    const idsParam = params.get("ids")?.split(",").filter(Boolean) ?? [];

    if (!idsParam.length) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    const fetchOrders = async () => {
      try {
        setError("");
        const [results, siteIdentity] = await Promise.all([
          Promise.all(
            idsParam.map(async (id) => {
              const res = await apiClient.get(
                `/orders/${id}?populate[0]=user
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
            }),
          ),
          getSiteIdentity(),
        ]);
        if (active) {
          setOrders(results.filter((order): order is InvoiceOrder => Boolean(order)));
          setIdentity(siteIdentity);
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "خطا در دریافت اطلاعات فاکتورها");
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void fetchOrders();
    return () => {
      active = false;
    };
  }, [params]);

  useEffect(() => {
    if (orders.length && identity && !hasPrinted.current) {
      hasPrinted.current = true;
      let active = true;
      void waitForInvoiceAssets().then(() => {
        if (active) window.print();
      });
      return () => {
        active = false;
      };
    }
  }, [identity, orders]);

  if (loading) return <div className="p-6">در حال بارگذاری سفارش‌ها…</div>;
  if (error) return <div className="p-6">{error}</div>;
  if (!orders.length) return <div className="p-6">سفارشی انتخاب نشده است.</div>;
  if (!identity) return <div className="p-6">اطلاعات فروشگاه در دسترس نیست.</div>;

  return (
    <div className="print:bg-white print:p-0">
      {orders.map((order) => (
        <div key={order.id} className="invoice-bulk-sheet">
          <Invoice order={order} identity={identity} />
        </div>
      ))}
    </div>
  );
}
