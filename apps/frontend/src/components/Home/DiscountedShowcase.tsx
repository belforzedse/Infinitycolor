"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ProductCard, { type ProductCardProps } from "@/components/Product/Card";
import ArrowLeftIcon from "@/components/PDP/Icons/ArrowLeftIcon";
import OffIcon from "@/components/PDP/Icons/OffIcon";
import PDPHeroNavigationButtons from "@/components/PDP/NavigationButtons";

type DiscountedShowcaseProps = {
  products: ProductCardProps[];
};

export default function DiscountedShowcase({ products }: DiscountedShowcaseProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [windowWidth, setWindowWidth] = useState(1440);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
      setCurrentPage(0);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const productsPerPage =
    windowWidth >= 2560 ? 5 : windowWidth >= 1920 ? 4 : windowWidth >= 1280 ? 3 : 2;
  const totalPages = Math.max(1, Math.ceil(products.length / productsPerPage));
  const startIndex = currentPage * productsPerPage;
  const currentProducts = products.slice(startIndex, startIndex + productsPerPage);
  const visibleProducts =
    currentProducts.length > 0 ? currentProducts : products.slice(0, productsPerPage);

  useEffect(() => {
    const maxPage = Math.max(0, totalPages - 1);
    if (currentPage > maxPage) {
      setCurrentPage(maxPage);
    }
  }, [currentPage, totalPages]);

  const goToNextProduct = () => {
    if (currentPage > 0 && !isAnimating) {
      setIsAnimating(true);
      setTimeout(() => {
        setCurrentPage(currentPage - 1);
        setTimeout(() => setIsAnimating(false), 50);
      }, 150);
    }
  };

  const goToPreviousProduct = () => {
    if (currentPage < totalPages - 1 && !isAnimating) {
      setIsAnimating(true);
      setTimeout(() => {
        setCurrentPage(currentPage + 1);
        setTimeout(() => setIsAnimating(false), 50);
      }, 150);
    }
  };

  if (products.length === 0) return null;

  return (
    <section
      dir="rtl"
      className="relative left-1/2 right-1/2 -mx-[50vw] w-screen overflow-hidden bg-[#1E2850]"
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

      <div className="mx-auto w-full max-w-[1360px] px-2 py-7 sm:px-5 md:py-9 lg:px-[60px] lg:py-[50px] 3xl:max-w-[1440px] 4xl:max-w-[1760px] 4xl:px-20">
        <div className="lg:hidden">
          <div className="mb-4 flex items-center justify-between gap-4">
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

          <div className="w-full overflow-hidden">
            <div
              ref={scrollRef}
              className="scrollbar-hide smooth-scroll flex snap-x snap-mandatory gap-1.5 overflow-x-auto scroll-smooth transition-transform duration-300 ease-out"
              style={{
                WebkitOverflowScrolling: "touch",
                scrollbarWidth: "none",
                msOverflowStyle: "none",
                width: "100%",
                maxWidth: "none",
              }}
            >
              {products.map((product, index) => (
                <div
                  key={product.id}
                  data-product-card-slide
                  className="w-[calc(50%-0.1875rem)] shrink-0 snap-start transition-transform duration-200 ease-out"
                  style={{
                    animationDelay: `${index * 60}ms`,
                    animation: `fadeInUp 0.3s ease-out forwards ${index * 60}ms`,
                  }}
                >
                  <ProductCard {...product} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {totalPages > 1 && (
          <div dir="ltr" className="mb-4 hidden items-center gap-3 lg:flex">
            <div dir="rtl">
              <PDPHeroNavigationButtons
                goToNextImage={goToNextProduct}
                goToPreviousImage={goToPreviousProduct}
              />
            </div>
            <div className="flex items-center gap-1 text-xs text-white/75">
              <span>{currentPage + 1}</span>
              <span>/</span>
              <span>{totalPages}</span>
            </div>
          </div>
        )}

        <div className="hidden items-center gap-4 lg:grid lg:grid-cols-3 xl:grid-cols-4 3xl:grid-cols-5 4xl:grid-cols-6">
          <div className="flex h-full min-w-0 flex-col items-center justify-center gap-5 text-center">
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

          {visibleProducts.map((product) => (
            <div
              key={product.id}
              className={`min-w-0 transform transition-all duration-200 ease-out hover:-translate-y-1 hover:scale-[1.02] ${
                isAnimating ? "scale-95 opacity-0" : "scale-100 opacity-100"
              }`}
            >
              <ProductCard {...product} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
