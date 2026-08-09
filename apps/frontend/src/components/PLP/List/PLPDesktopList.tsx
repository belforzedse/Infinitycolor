"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { formatProductsToCardProps } from "@/services/product/product";
import type { PLPProduct } from "@/components/PLP/types";
import { StorefrontGrid } from "@/components/storefront";
import { useAdaptiveQuality } from "@/lib/adaptive-quality";
import { trackAnalyticsEvent } from "@/lib/analytics";

const ProductCard = dynamic(() => import("@/components/Product/Card"), {
  loading: () => <div className="skeleton-shimmer h-48 rounded-lg" />,
});

interface PLPDesktopListProps {
  products: PLPProduct[];
}

export default function PLPDesktopList({ products }: PLPDesktopListProps) {
  const quality = useAdaptiveQuality();
  const includeMedia = quality.media === "high";
  const pathname = usePathname();
  const productIds = products.map((product) => product.id).join(",");

  useEffect(() => {
    if (!productIds) return;
    trackAnalyticsEvent({
      category: "ecommerce",
      action: "view_item_list",
      properties: {
        placement: "plp",
        result_count: products.length,
      },
      onceKey: `view-item-list:${pathname}:${productIds}`,
    });
    // productIds is derived from products and is the real dependency (a stable
    // signature of which items are shown) — products itself is a new array
    // reference on every render, which would defeat the once-guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productIds, pathname]);

  return (
    <StorefrontGrid variant="plp" data-aq-product-list="responsive">
      {products.map((product, index) => {
        const card = formatProductsToCardProps([product])[0];
        if (!card) return null;

        return (
          <ProductCard
            key={product.id}
            {...card}
            images={includeMedia ? card.images : card.images.slice(0, 1)}
            priority={index < 2}
            listPosition={index}
          />
        );
      })}
    </StorefrontGrid>
  );
}
