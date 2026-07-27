"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore, useState } from "react";
import ProductCard, { type ProductCardProps } from "@/components/Product/Card";
import { StorefrontGrid } from "@/components/storefront";
import ArrowLeftIcon from "./Icons/ArrowLeftIcon";
import PDPHeroNavigationButtons from "./NavigationButtons";

type Props = {
  icon: React.ReactNode;
  title: string;
  products: ProductCardProps[];
  hideBottomViewMore?: boolean;
};

const SERVER_PRODUCTS_PER_PAGE = 6;
const viewportSubscribers = new Set<() => void>();

function productsPerPageForWidth(width: number): number {
  if (width >= 2560) return 6;
  if (width >= 1920) return 5;
  if (width >= 1280) return 4;
  if (width >= 1024) return 3;
  return 2;
}

function getViewportProductsPerPage(): number {
  return typeof window === "undefined"
    ? SERVER_PRODUCTS_PER_PAGE
    : productsPerPageForWidth(window.innerWidth);
}

function subscribeToViewport(listener: () => void): () => void {
  viewportSubscribers.add(listener);
  if (viewportSubscribers.size === 1) {
    window.addEventListener("resize", notifyViewportSubscribers, {
      passive: true,
    });
  }

  return () => {
    viewportSubscribers.delete(listener);
    if (viewportSubscribers.size === 0) {
      window.removeEventListener("resize", notifyViewportSubscribers);
    }
  };
}

function notifyViewportSubscribers() {
  viewportSubscribers.forEach((listener) => listener());
}

function useProductsPerPage(): number {
  return useSyncExternalStore(
    subscribeToViewport,
    getViewportProductsPerPage,
    () => SERVER_PRODUCTS_PER_PAGE,
  );
}

function initialResponsiveVisibility(index: number): string {
  if (index < 2) return "";
  if (index === 2) return "hidden lg:block";
  if (index === 3) return "hidden xl:block";
  if (index === 4) return "hidden 3xl:block";
  return "hidden 4xl:block";
}

export default function OffersListHomePage({
  icon,
  title,
  products,
  hideBottomViewMore = false,
}: Props) {
  const productsPerPage = useProductsPerPage();
  const [currentPage, setCurrentPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(products.length / productsPerPage));
  const safeCurrentPage = Math.min(currentPage, totalPages - 1);
  const startIndex = safeCurrentPage * productsPerPage;
  const currentProducts = products.slice(startIndex, startIndex + productsPerPage);

  useEffect(() => {
    setCurrentPage(0);
  }, [productsPerPage]);

  useEffect(() => {
    if (currentPage !== safeCurrentPage) {
      setCurrentPage(safeCurrentPage);
    }
  }, [currentPage, safeCurrentPage]);

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
          <span className="text-foreground-primary truncate text-2xl md:text-3xl">{title}</span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {totalPages > 1 ? (
            <>
              <PDPHeroNavigationButtons
                goToNextImage={() => setCurrentPage((page) => Math.max(0, page - 1))}
                goToPreviousImage={() =>
                  setCurrentPage((page) => Math.min(totalPages - 1, page + 1))
                }
                nextDisabled={safeCurrentPage === 0}
                previousDisabled={safeCurrentPage === totalPages - 1}
                nextLabel="صفحه قبلی محصولات"
                previousLabel="صفحه بعدی محصولات"
              />
              <div
                className="hidden items-center gap-1 text-xs text-neutral-500 sm:flex"
                aria-live="polite"
              >
                <span>{safeCurrentPage + 1}</span>
                <span>/</span>
                <span>{totalPages}</span>
              </div>
            </>
          ) : null}

          <Link
            href={getPlpHref()}
            className="hidden text-sm text-infinity-primary underline-offset-4 transition-colors hover:text-infinity-primary-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white md:block"
          >
            مشاهده همه
          </Link>
        </div>
      </div>

      <StorefrontGrid
        variant="products"
        data-aq-home-product-list
        data-products-per-page={productsPerPage}
      >
        {currentProducts.map((product, index) => (
          <div
            key={product.id}
            data-product-card-slide
            className={`min-w-0 ${initialResponsiveVisibility(index)}`}
          >
            <ProductCard {...product} />
          </div>
        ))}
      </StorefrontGrid>

      {!hideBottomViewMore && products.length > productsPerPage ? (
        <div className="mt-4 flex items-center justify-center md:mt-6">
          <Link
            href={getPlpHref()}
            className="pressable text-foreground-primary flex items-center gap-1 rounded-full border border-infinity-primary-lighter/40 px-4 py-2 text-base underline-offset-4 transition-colors hover:bg-infinity-primary-lighter/20 hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
          >
            <span>مشاهده محصولات بیشتر</span>
            <ArrowLeftIcon />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
