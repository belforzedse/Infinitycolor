"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import type { ProductCardProps } from "@/components/Product/Card";
import { StorefrontGrid } from "@/components/storefront/StorefrontGrid";
import { useAdaptiveQuality } from "@/lib/adaptive-quality";
import { trackAnalyticsEvent } from "@/lib/analytics";

const ProductCard = dynamic(() => import("@/components/Product/Card"), {
  loading: () => <div className="skeleton-shimmer h-48 rounded-lg" />,
});

interface PLPDesktopListProps {
  /** Projected on the server by `PLPPageView`, not per card on render. */
  cards: ProductCardProps[];
}

export default function PLPDesktopList({ cards }: PLPDesktopListProps) {
  const quality = useAdaptiveQuality();
  const includeMedia = quality.media === "high";
  const pathname = usePathname();
  const productIds = cards.map((card) => card.id).join(",");

  useEffect(() => {
    if (!productIds) return;
    trackAnalyticsEvent({
      category: "ecommerce",
      action: "view_item_list",
      properties: {
        placement: "plp",
        result_count: cards.length,
      },
      onceKey: `view-item-list:${pathname}:${productIds}`,
    });
    // productIds is derived from cards and is the real dependency (a stable
    // signature of which items are shown) — cards itself is a new array
    // reference on every render, which would defeat the once-guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productIds, pathname]);

  return (
    <StorefrontGrid variant="plp" data-aq-product-list="responsive">
      {cards.map((card, index) => (
        <ProductCard
          key={card.id}
          {...card}
          images={
            // The server snapshot is never `high`, so the tier flips after
            // hydration. Slicing unconditionally would hand every card a fresh
            // array for an identical result whenever a card has one image —
            // which is every card on the compact PLP projection.
            includeMedia || card.images.length <= 1 ? card.images : card.images.slice(0, 1)
          }
          priority={index < 2}
          listPosition={index}
        />
      ))}
    </StorefrontGrid>
  );
}
