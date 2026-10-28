"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Invoice, { type InvoiceOrder } from "@/components/invoice";
import { getAdminReserveGroup } from "@/services/super-admin/orders/reserveGroups";
import { getSiteIdentity } from "@/services/site-identity";
import type { SiteIdentity } from "@/types/site-identity";
import { combineReserveOrders } from "../../combineReserveOrders";
import { loadInvoiceOrder } from "../../loadInvoiceOrder";
import { waitForInvoiceAssets } from "../../waitForInvoiceAssets";

export default function PrintReserveGroupPage() {
  const { groupId } = useParams();
  const groupKey = typeof groupId === "string" ? groupId : "";
  const [order, setOrder] = useState<InvoiceOrder | null>(null);
  const [identity, setIdentity] = useState<SiteIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const hasPrinted = useRef(false);

  useEffect(() => {
    let active = true;
    hasPrinted.current = false;

    const load = async () => {
      setLoading(true);
      setError("");
      setOrder(null);
      try {
        if (!groupKey) throw new Error("بسته رزروی یافت نشد.");
        const [response, siteIdentity] = await Promise.all([
          getAdminReserveGroup(groupKey),
          getSiteIdentity(),
        ]);
        const group = response.data;
        if (!group || group.groupKey !== groupKey) {
          throw new Error("بسته رزروی یافت نشد.");
        }
        const memberOrders = await Promise.all(
          group.orders.map((member) => loadInvoiceOrder(String(member.id))),
        );
        if (memberOrders.some((member) => !member)) {
          throw new Error("اطلاعات همه سفارش‌های بسته در دسترس نیست. دوباره تلاش کنید.");
        }
        const combined = combineReserveOrders(group, memberOrders as InvoiceOrder[]);
        if (active) {
          setOrder(combined);
          setIdentity(siteIdentity);
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : "خطا در دریافت فاکتور");
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [groupKey]);

  useEffect(() => {
    if (!order || !identity || hasPrinted.current) return;
    hasPrinted.current = true;
    let active = true;
    void waitForInvoiceAssets().then(() => {
      if (active) window.print();
    });
    return () => {
      active = false;
    };
  }, [order, identity]);

  if (loading) return <div className="p-6">در حال بارگذاری فاکتور…</div>;
  if (error || !order || !identity) {
    return <div className="p-6">{error || "اطلاعات فاکتور در دسترس نیست."}</div>;
  }

  return <Invoice order={order} identity={identity} />;
}
