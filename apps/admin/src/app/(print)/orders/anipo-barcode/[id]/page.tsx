"use client";

import { useEffect, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { apiClient } from "@/services";
import AnipoBarcodeLabel from "@/components/SuperAdmin/Order/AnipoBarcodeLabel";
import { unwrapEntity } from "@/utils/strapi";
import { useCan } from "@/hooks/useCan";

type Order = {
  id: string;
  attributes: {
    ShippingBarcode?: string;
    ShippingWeight?: number;
    ShippingBoxSizeId?: number;
    AnipoSubmittedAt?: string;
    AnipoIssuedAt?: string;
    Description?: string;
    createdAt: string;
    user: {
      data: {
        attributes: {
          Phone: string;
          user_info: {
            data: {
              attributes: {
                FirstName: string;
                LastName: string;
              };
            };
          };
        };
      };
    };
    delivery_address?: {
      data: {
        attributes: {
          FullAddress: string;
          FullName?: string;
          Phone?: string;
          PostalCode?: string;
          shipping_city: {
            data: {
              attributes: {
                Title: string;
                shipping_province: {
                  data: {
                    attributes: {
                      Title: string;
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
    contract?: {
      data: {
        attributes: {
          Amount: number;
        };
      };
    };
  };
};

export default function AnipoBarcodePrintPage() {
  const { id } = useParams();
  const canPrint = useCan("order.print");
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const hasPrinted = useRef(false);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const res = await apiClient.get(
          `/orders/${id}?populate[0]=user&populate[1]=user.user_info&populate[2]=delivery_address.shipping_city.shipping_province&populate[3]=contract`,
        );

        const normalized = unwrapEntity((res as any).data);
        setOrder(
          normalized
            ? ({
                id: String(normalized.id ?? id),
                attributes: normalized,
              } as unknown as Order)
            : null,
        );
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id]);

  useEffect(() => {
    if (
      canPrint &&
      order &&
      order.attributes.ShippingBarcode &&
      !hasPrinted.current
    ) {
      hasPrinted.current = true;
      const timeout = setTimeout(() => window.print(), 600);
      return () => clearTimeout(timeout);
    }
  }, [order, canPrint]);

  useEffect(() => {
    const afterPrint = () => {
      hasPrinted.current = false;
    };

    window.addEventListener("afterprint", afterPrint);
    return () => window.removeEventListener("afterprint", afterPrint);
  }, []);

  if (loading || !order) {
    return <div className="anipo-loading">در حال بارگذاری...</div>;
  }

  if (!order.attributes.ShippingBarcode) {
    return <div className="anipo-loading">بارکد برای این سفارش موجود نیست</div>;
  }

  // Prepare data for the label component
  const userInfo = unwrapEntity(order.attributes.user);
  const userProfile = unwrapEntity(userInfo?.user_info);
  const addressData = unwrapEntity(order.attributes.delivery_address);
  const fullName =
    addressData?.FullName?.trim() ||
    `${userProfile?.FirstName || ""} ${userProfile?.LastName || ""}`.trim();
  const cityData = unwrapEntity(addressData?.shipping_city);
  const provinceData = unwrapEntity(cityData?.shipping_province);
  const city = cityData?.Title || "";
  const province = provinceData?.Title || "";

  if (!canPrint) return <div className="anipo-loading">دسترسی چاپ ندارید</div>;
  const issuedAt = order.attributes.AnipoIssuedAt;
  const date = issuedAt ? new Date(issuedAt) : null;
  const labelProps = {
    packageNumber: String(id),
    packageSize:
      order.attributes.AnipoSubmittedAt && order.attributes.ShippingBoxSizeId
        ? `سایز ${order.attributes.ShippingBoxSizeId.toLocaleString("fa-IR")}`
        : undefined,
    destination: [province, city].filter(Boolean).join("، "),
    weight:
      order.attributes.AnipoSubmittedAt && order.attributes.ShippingWeight
        ? `${order.attributes.ShippingWeight.toLocaleString("fa-IR")} گرم`
        : undefined,
    date: date?.toLocaleDateString("fa-IR"),
    time: date?.toLocaleTimeString("fa-IR", {
      hour: "2-digit",
      minute: "2-digit",
    }),
    barcodeNumber: order.attributes.ShippingBarcode,
    recipientName: fullName,
    recipientPhone:
      addressData?.Phone || userInfo?.Phone || userInfo?.phone || "",
    recipientAddress: addressData?.FullAddress || "",
    postalCode: addressData?.PostalCode || undefined,
  };

  return <AnipoBarcodeLabel {...labelProps} />;
}
