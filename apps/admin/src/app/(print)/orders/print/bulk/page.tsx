"use client";

import { useEffect, useState, useRef } from "react";
import { useSearchParams } from "next/navigation";
import Invoice, { type InvoiceOrder } from "@/components/invoice";
import { getSiteIdentity } from "@/services/site-identity";
import type { SiteIdentity } from "@/types/site-identity";
import { loadInvoiceOrder } from "../loadInvoiceOrder";
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
          Promise.all(idsParam.map(loadInvoiceOrder)),
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
