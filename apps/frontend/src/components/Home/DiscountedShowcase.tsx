"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import ProductCard, { type ProductCardProps } from "@/components/Product/Card";
import ArrowLeftIcon from "@/components/PDP/Icons/ArrowLeftIcon";
import OffIcon from "@/components/PDP/Icons/OffIcon";
import PDPHeroNavigationButtons from "@/components/PDP/NavigationButtons";
import { useAdaptiveCarouselTransition } from "@/hooks/useAdaptiveCarouselTransition";
import { cn } from "@/lib/utils";

type DiscountedShowcaseProps = {
  products: ProductCardProps[];
};

type ProductsPerPage = 2 | 3 | 4 | 5;

const PRODUCT_PAGE_BREAKPOINTS: Array<{ query: string; count: ProductsPerPage }> = [
  { query: "(min-width: 2560px)", count: 5 },
  { query: "(min-width: 1920px)", count: 4 },
  { query: "(min-width: 1280px)", count: 3 },
];

function getProductsPerPageFromViewport(): ProductsPerPage {
  const match = PRODUCT_PAGE_BREAKPOINTS.find(
    (breakpoint) => window.matchMedia(breakpoint.query).matches,
  );
  return match?.count ?? 2;
}

export default function DiscountedShowcase({ products }: DiscountedShowcaseProps) {
  const [currentPage, setCurrentPage] = useState(0);
  const [productsPerPage, setProductsPerPage] = useState<ProductsPerPage>(3);
  const { cancelTransition, isAnimating, richTransition, transitionTo } =
    useAdaptiveCarouselTransition(setCurrentPage);

  useEffect(() => {
    const mediaQueries = PRODUCT_PAGE_BREAKPOINTS.map((breakpoint) =>
      window.matchMedia(breakpoint.query),
    );
    const handleBreakpointChange = () => {
      cancelTransition(false);
      setProductsPerPage(getProductsPerPageFromViewport());
      setCurrentPage(0);
    };

    handleBreakpointChange();
    mediaQueries.forEach((query) => query.addEventListener("change", handleBreakpointChange));
    return () => {
      mediaQueries.forEach((query) => query.removeEventListener("change", handleBreakpointChange));
    };
  }, [cancelTransition]);

  const totalPages = Math.max(1, Math.ceil(products.length / productsPerPage));
  const startIndex = currentPage * productsPerPage;

  useEffect(() => {
    const maxPage = Math.max(0, totalPages - 1);
    if (currentPage > maxPage) {
      cancelTransition(false);
      // Product updates can remove the active page; keep the index reachable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentPage(maxPage);
    }
  }, [cancelTransition, currentPage, totalPages]);

  const goToNextProduct = () => {
    if (currentPage > 0) transitionTo(currentPage - 1);
  };

  const goToPreviousProduct = () => {
    if (currentPage < totalPages - 1) transitionTo(currentPage + 1);
  };

  if (products.length === 0) return null;

  return (
    <section
      dir="rtl"
      data-home-full-bleed="discounted"
      data-aq-carousel="discounted-products"
      data-aq-carousel-motion={richTransition ? "legacy-rich" : "lightweight"}
      data-aq-carousel-phase={isAnimating ? "transitioning" : "idle"}
      data-aq-carousel-page={currentPage + 1}
      className="home-full-bleed overflow-hidden bg-[#1E2850]"
    >
      <style jsx>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .smooth-scroll {
          scroll-behavior: smooth;
          transition: scroll-left 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
      `}</style>

      <div
        data-home-contained-content="discounted"
        className="mx-auto w-screen max-w-[1360px] px-2 py-7 sm:px-5 md:py-9 lg:px-[60px] lg:py-[50px] 3xl:max-w-[1440px] 4xl:max-w-[1760px] 4xl:px-20"
      >
        <div className="mb-4 flex items-center justify-between gap-4 lg:hidden">
          <h2 className="flex items-center gap-1 font-peyda text-xl font-medium text-white md:text-2xl">
            <span className="[filter:brightness(0)_invert(1)]" aria-hidden="true">
              <OffIcon />
            </span>
            تخفیف‌های شگفت‌انگیز
          </h2>
          <Link
            href="/plp?hasDiscount=true"
            className="inline-flex items-center gap-1 text-sm font-medium text-white underline-offset-4 transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <span>مشاهده همه</span>
          </Link>
        </div>

        {totalPages > 1 && (
          <div dir="ltr" className="mb-4 hidden items-center gap-3 lg:flex">
            <div dir="rtl">
              <PDPHeroNavigationButtons
                goToNextImage={goToNextProduct}
                goToPreviousImage={goToPreviousProduct}
                nextDisabled={currentPage === 0 || isAnimating}
                previousDisabled={currentPage === totalPages - 1 || isAnimating}
                nextLabel="صفحه قبلی محصولات تخفیف‌دار"
                previousLabel="صفحه بعدی محصولات تخفیف‌دار"
              />
            </div>
            <div className="flex items-center gap-1 text-xs text-white/75">
              <span>{currentPage + 1}</span>
              <span>/</span>
              <span>{totalPages}</span>
            </div>
          </div>
        )}

        <div
          className="scrollbar-hide smooth-scroll flex snap-x snap-mandatory gap-1.5 overflow-x-auto lg:grid lg:snap-none lg:grid-cols-3 lg:items-center lg:gap-4 lg:overflow-visible xl:grid-cols-4 3xl:grid-cols-5 4xl:grid-cols-6"
          data-aq-carousel-track
          style={{
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
            msOverflowStyle: "none",
          }}
        >
          <div className="hidden h-full min-w-0 flex-col items-center justify-center gap-5 text-center lg:flex">
            <h2
              className="w-max max-w-full text-right font-peyda text-[46px] font-medium leading-[1.08] text-white"
              dir="rtl"
            >
              <span className="block">تخفیف‌هـای</span>
              <span className="block">شگفـــــــــــت</span>
              <span className="block">‌انگیـــــــــــــــز</span>
            </h2>

            <Image
              src="/images/infinity-discount-logo.png"
              alt="اینفینیتی"
              width={400}
              height={250}
              className="h-auto w-[180px]"
              sizes="180px"
            />

            <Link
              href="/plp?hasDiscount=true"
              className="pressable inline-flex h-8 items-center gap-1 rounded-full bg-white px-5 text-sm font-medium text-infinity-primary transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#1E2850]"
            >
              <span>مشاهده همه</span>
              <ArrowLeftIcon />
            </Link>
          </div>

          {products.map((product, index) => {
            const visibleOnDesktop = index >= startIndex && index < startIndex + productsPerPage;
            return (
              <div
                key={product.id}
                data-product-card-slide
                className={cn(
                  "aq-decorative-motion w-[calc(50%-0.1875rem)] shrink-0 snap-start transition-transform duration-200 ease-out lg:w-auto lg:min-w-0 lg:snap-none lg:hover:-translate-y-1 lg:hover:scale-[1.02]",
                  visibleOnDesktop ? "lg:block" : "lg:hidden",
                  richTransition && "lg:transform lg:transition-all lg:duration-300 lg:ease-out",
                  richTransition &&
                    visibleOnDesktop &&
                    (isAnimating ? "lg:scale-95 lg:opacity-0" : "lg:scale-100 lg:opacity-100"),
                )}
                style={{
                  animation: `fadeInUp 0.3s ease-out forwards ${index * 60}ms`,
                }}
              >
                <ProductCard {...product} />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
