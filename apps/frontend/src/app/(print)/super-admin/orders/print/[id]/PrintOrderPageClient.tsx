"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { apiClient } from "@/services";
import Invoice, { type InvoiceOrder } from "@/components/invoice";
import { getSiteIdentity } from "@/services/site-identity";
import type { SiteIdentity } from "@/types/site-identity";
import { normalizeOrderForInvoice } from "../normalizeOrder";
import { waitForInvoiceAssets } from "../waitForInvoiceAssets";

export default function PrintOrderPageClient() {
  const { id } = useParams();
  const searchParams = useSearchParams();
  const [order, setOrder] = useState<InvoiceOrder | null>(null);
  const [identity, setIdentity] = useState<SiteIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const hasPrinted = useRef(false);
  const isPreInvoice = searchParams.get("type") === "pre-invoice";

  useEffect(() => {
    let active = true;

    const fetchData = async () => {
      setLoading(true);
      setError("");
      try {
        const identityPromise = getSiteIdentity();

        // Handle temp pre-invoice case
        if (id === "temp-preview") {
          const tempOrderData = sessionStorage.getItem("tempPreInvoiceOrder");
          if (tempOrderData) {
            const tempOrder = JSON.parse(tempOrderData) as InvoiceOrder;
            const siteIdentity = await identityPromise;
            if (active) {
              setOrder(tempOrder);
              setIdentity(siteIdentity);
            }
            return;
          } else {
            throw new Error("اطلاعات پیش‌فاکتور پیدا نشد");
          }
        }

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

        const normalizedOrder = normalizeOrderForInvoice(
          (res as { data?: unknown }).data,
          id as string,
        );
        if (!normalizedOrder) {
          throw new Error("سفارش پیدا نشد");
        }
        const siteIdentity = await identityPromise;
        if (active) {
          setOrder(normalizedOrder);
          setIdentity(siteIdentity);
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "خطا در دریافت اطلاعات فاکتور");
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void fetchData();
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (order && identity && !hasPrinted.current) {
      hasPrinted.current = true;
      let active = true;
      void waitForInvoiceAssets().then(() => {
        if (active) window.print();
      });
      return () => {
        active = false;
      };
    }
  }, [identity, order]);

  useEffect(() => {
    const afterPrint = () => {
      hasPrinted.current = false; // optional if you want to allow reprint on revisit
    };

    window.addEventListener("afterprint", afterPrint);
    return () => window.removeEventListener("afterprint", afterPrint);
  }, []);

  if (loading) return <div className="p-6">در حال بارگذاری…</div>;
  if (error || !order || !identity) {
    return <div className="p-6">{error || "اطلاعات فاکتور در دسترس نیست."}</div>;
  }

  return <Invoice order={order} identity={identity} isPreInvoice={isPreInvoice} />;
}
