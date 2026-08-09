"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { setAnalyticsContext, trackFunnelStep } from "@/lib/analytics";

type Props = {
  productId: number;
  price?: number;
};

export default function ViewItemTracker({ productId, price }: Props) {
  const pathname = usePathname();

  useEffect(() => {
    if (!productId) return;
    // Attach the stable product id to this product-view action so behavior reports
    // can segment behaviour by product (action-scoped dimension).
    setAnalyticsContext("product_id", productId);
    trackFunnelStep("view_item", {
      valueToman: price,
      properties: { product_id: productId },
      onceKey: `view-item:${productId}:${pathname}`,
    });
  }, [productId, price, pathname]);

  return null;
}
