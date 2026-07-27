"use client";

import ProductCard, { type ProductCardProps } from "@/components/Product/Card";
import ArrowLeftIcon from "./Icons/ArrowLeftIcon";
import Link from "next/link";
import { useRef } from "react";

type Props = {
  icon: React.ReactNode;
  title: string;
  products: ProductCardProps[];
  hideBottomViewMore?: boolean;
};

export default function OffersListHomePage({
  icon,
  title,
  products,
  hideBottomViewMore = false,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const displayedProducts = products.slice(0, 5);

  function getPlpHref(): string {
    if (title.includes("تخفیف")) return "/plp?hasDiscount=true";
    if (title.includes("جدید")) return "/plp?sort=createdAt:desc";
    if (title.includes("محبوب")) return "/plp?sort=AverageRating:desc";
    return "/plp";
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1">
          {icon}
          <span className="text-foreground-primary truncate text-2xl md:text-3xl">
            {title}
          </span>
        </div>

        <Link
          href={getPlpHref()}
          className="hidden shrink-0 text-sm text-infinity-primary underline-offset-4 transition-colors hover:text-infinity-primary-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white md:block"
        >
          مشاهده همه
        </Link>
      </div>

      <div
        ref={scrollRef}
        data-aq-home-product-list
        className="scrollbar-hide flex snap-x snap-mandatory gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] md:grid md:grid-cols-2 md:gap-4 md:overflow-visible lg:grid-cols-3 xl:grid-cols-4 3xl:grid-cols-5 3xl:gap-5"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {displayedProducts.map((product) => (
          <div
            key={product.id}
            data-product-card-slide
            className="w-[calc(50%-0.1875rem)] min-w-0 shrink-0 snap-start md:w-auto"
          >
            <ProductCard {...product} />
          </div>
        ))}
      </div>

      {!hideBottomViewMore && products.length > displayedProducts.length ? (
        <div className="mt-4 flex items-center justify-center md:hidden">
          <Link
            href={getPlpHref()}
            className="text-foreground-primary flex items-center gap-1 text-base underline-offset-4 transition-colors hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <span>مشاهده همه</span>
            <ArrowLeftIcon />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
