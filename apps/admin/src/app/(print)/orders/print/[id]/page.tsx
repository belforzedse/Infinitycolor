"use client";

import { useEffect, useState, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Invoice, { type InvoiceOrder } from "@/components/invoice";
import { getSiteIdentity } from "@/services/site-identity";
import type { SiteIdentity } from "@/types/site-identity";
import { loadInvoiceOrder } from "../loadInvoiceOrder";
import { waitForInvoiceAssets } from "../waitForInvoiceAssets";
import { receivePreInvoice } from "@/utils/preInvoiceTransfer";

export default function PrintOrderPage() {
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
          const channelId = searchParams.get("channel") || "";
          const [tempOrder, siteIdentity] = await Promise.all([
            receivePreInvoice(channelId),
            identityPromise,
          ]);
          if (active) {
            setOrder(tempOrder);
            setIdentity(siteIdentity);
          }
          return;
        }

        const normalizedOrder = await loadInvoiceOrder(id as string);
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
  }, [id, searchParams]);

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
