"use client";

import dynamic from "next/dynamic";
import { formatProductsToCardProps } from "@/services/product/product";
import type { PLPProduct } from "@/components/PLP/types";

const ProductCard = dynamic(() => import("@/components/Product/Card"), {
  loading: () => <div className="skeleton-shimmer h-48 rounded-lg" />,
});

interface PLPMobileListProps {
  products: PLPProduct[];
}

export default function PLPMobileList({ products }: PLPMobileListProps) {
  return (
    <div className="grid grid-cols-2 gap-2 md:hidden">
      {products.map((product, index) => {
        const card = formatProductsToCardProps([product])[0];
        if (!card) return null;

        return (
          <ProductCard
            key={product.id}
            {...card}
            // Keep the mobile payload light; ProductCard lazy-loads secondary
            // media on first interaction.
            images={card.images.slice(0, 1)}
            priority={index < 4}
          />
        );
      })}
    </div>
  );
}
