"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import AnipoBarcodeLabel from "@/components/SuperAdmin/Order/AnipoBarcodeLabel";
import {
  getAdminReserveGroup,
  type AnipoParcelSummary,
} from "@/services/super-admin/orders/reserveGroups";

export default function ReserveParcelLabelPage() {
  const params = useParams();
  const key = typeof params.groupId === "string" ? params.groupId : "";
  const [parcel, setParcel] = useState<AnipoParcelSummary | null>(null);
  const [error, setError] = useState("");
  const printed = useRef(false);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void getAdminReserveGroup(key, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          if (result.data?.anipo) setParcel(result.data.anipo);
          else setError("اطلاعات برچسب دریافت نشد؛ صفحه را تازه کنید");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("اطلاعات برچسب دریافت نشد؛ صفحه را تازه کنید");
      });
    return () => controller.abort();
  }, [key]);
  useEffect(() => {
    if (!parcel?.canPrintLabel || printed.current) return;
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (cancelled) return;
      printed.current = true;
      window.print();
    });
    return () => {
      cancelled = true;
    };
  }, [parcel]);
  if (error) return <div className="anipo-loading">{error}</div>;
  if (!parcel) return <div className="anipo-loading">در حال بارگذاری…</div>;
  if (!parcel.canPrintLabel || !parcel.barcode)
    return (
      <div className="anipo-loading">
        {parcel.blockedReason || "بارکد بسته هنوز صادر نشده است"}
      </div>
    );
  const issued = parcel.issuedAt ? new Date(parcel.issuedAt) : null;
  return (
    <AnipoBarcodeLabel
      barcodeNumber={parcel.barcode}
      recipientName={parcel.recipient?.name}
      recipientPhone={parcel.recipient?.phone || undefined}
      recipientAddress={parcel.recipient?.address}
      postalCode={parcel.recipient?.postalCode || undefined}
      destination={[parcel.recipient?.province, parcel.recipient?.city]
        .filter(Boolean)
        .join("، ")}
      weight={
        parcel.registeredWeight
          ? `${parcel.registeredWeight.toLocaleString("fa-IR")} گرم`
          : undefined
      }
      packageSize={
        parcel.registeredBoxSizeId
          ? `سایز ${parcel.registeredBoxSizeId.toLocaleString("fa-IR")}`
          : undefined
      }
      date={issued?.toLocaleDateString("fa-IR")}
      time={issued?.toLocaleTimeString("fa-IR", {
        hour: "2-digit",
        minute: "2-digit",
      })}
    />
  );
}
