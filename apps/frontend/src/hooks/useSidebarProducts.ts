import { useMemo } from "react";
import type { ProductCardProps } from "@/components/Product/Card";
import type { ProductSmallCardProps } from "@/components/Product/SmallCard";

interface UseSidebarProductsArgs {
  /** Already-projected cards. Pass an empty list to skip the derived fallback. */
  cards: ProductCardProps[];
  discountedSidebarProducts?: ProductCardProps[];
  suggestedSidebarProducts?: ProductCardProps[];
}

interface UseSidebarProductsResult {
  sidebarProducts: ProductSmallCardProps[];
  mappedDiscountedSidebar: ProductSmallCardProps[];
  mappedSuggestedSidebar: ProductSmallCardProps[];
}

/**
 * A small card needs an image, a price and available stock; anything else is not
 * worth a suggestion slot. The price guard used to be a throwing branch around
 * `formatProductsToCardProps`, which now runs on the server — a card with a
 * non-positive price never reaches here, but the guard stays so a bad row cannot
 * render "0 تومان".
 */
const mapProductCardToSmallCard = (products: ProductCardProps[]): ProductSmallCardProps[] => {
  return products
    .filter((p) => p.isAvailable && p.images?.[0] && p.price > 0)
    .slice(0, 3)
    .map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      category: p.category,
      likedCount: p.seenCount || 0,
      price: p.price,
      discountedPrice: p.discountPrice,
      discount: p.discount,
      image: p.images[0] || "",
      isAvailable: p.isAvailable,
      colorsCount: p.colorsCount,
      colorCodes: p.colorCodes,
    }));
};

export const useSidebarProducts = ({
  cards,
  discountedSidebarProducts = [],
  suggestedSidebarProducts = [],
}: UseSidebarProductsArgs): UseSidebarProductsResult => {
  const sidebarProducts = useMemo(() => mapProductCardToSmallCard(cards), [cards]);

  const mappedDiscountedSidebar = useMemo(
    () => mapProductCardToSmallCard(discountedSidebarProducts),
    [discountedSidebarProducts],
  );

  const mappedSuggestedSidebar = useMemo(
    () => mapProductCardToSmallCard(suggestedSidebarProducts),
    [suggestedSidebarProducts],
  );

  return { sidebarProducts, mappedDiscountedSidebar, mappedSuggestedSidebar };
};
