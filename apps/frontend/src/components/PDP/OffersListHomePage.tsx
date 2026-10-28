"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore, useState } from "react";
import ProductCard, { type ProductCardProps } from "@/components/Product/Card";
import { ProductRailSlide, ProductRailTrack } from "@/components/storefront/ProductRailTrack";
import { useAdaptiveCarouselTransition } from "@/hooks/useAdaptiveCarouselTransition";
import { cn } from "@/lib/utils";
import { getOfferPlpHref } from "@/utils/plpRoutes";
import ArrowLeftIcon from "./Icons/ArrowLeftIcon";
import PDPHeroNavigationButtons from "./NavigationButtons";

type Props = {
  icon: React.ReactNode;
  title: string;
  products: ProductCardProps[];
  /** Admin-configured «مشاهده همه» target. Omitted rails fall back to the title heuristic below. */
  viewAllHref?: string;
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

/**
 * Which cards the *desktop* grid shows on the first page.
 *
 * This is the SSR/CLS guard: `useSyncExternalStore` reports
 * SERVER_PRODUCTS_PER_PAGE on the server, so the breakpoint has to come from CSS
 * until hydration tells us the real viewport. It used to hide the overflow on
 * every screen (`hidden lg:block`), which is precisely what left a phone with
 * two cards and nothing to scroll — so every rule here is scoped to `lg` and up
 * and mobile always renders the full track.
 */
function firstPageDesktopVisibility(index: number): string {
  if (index <= 2) return "";
  if (index === 3) return "lg:hidden xl:block";
  if (index === 4) return "lg:hidden 3xl:block";
  if (index === 5) return "lg:hidden 4xl:block";
  return "lg:hidden";
}

export default function OffersListHomePage({ icon, title, products, viewAllHref }: Props) {
  const productsPerPage = useProductsPerPage();
  const [currentPage, setCurrentPage] = useState(0);
  const { cancelTransition, isAnimating, richTransition, transitionTo } =
    useAdaptiveCarouselTransition(setCurrentPage);
  const totalPages = Math.max(1, Math.ceil(products.length / productsPerPage));
  const safeCurrentPage = Math.min(currentPage, totalPages - 1);
  const startIndex = safeCurrentPage * productsPerPage;

  useEffect(() => {
    cancelTransition(false);
    // The externally observed responsive page size defines a new page set.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCurrentPage(0);
  }, [cancelTransition, productsPerPage]);

  useEffect(() => {
    if (currentPage !== safeCurrentPage) {
      cancelTransition(false);
      // Product updates can remove the active page; keep the index reachable.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCurrentPage(safeCurrentPage);
    }
  }, [cancelTransition, currentPage, safeCurrentPage]);

  function getPlpHref(): string {
    if (title.includes("تخفیف")) return "/plp?hasDiscount=true";
    if (title.includes("جدید")) return getOfferPlpHref("newest");
    if (title.includes("محبوب")) return "/plp?sort=AverageRating:desc";
    return "/plp";
  }

  const viewAllTarget = viewAllHref || getPlpHref();

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-aq-carousel="product-rail"
      data-aq-carousel-motion={richTransition ? "legacy-rich" : "lightweight"}
      data-aq-carousel-phase={isAnimating ? "transitioning" : "idle"}
      data-aq-carousel-page={safeCurrentPage + 1}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1">
          {icon}
          <span className="text-foreground-primary truncate text-2xl md:text-3xl">{title}</span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {totalPages > 1 ? (
            // Desktop-only: on mobile the rail is swiped, so arrows would be a
            // second, redundant way to move through the same cards.
            <div className="hidden shrink-0 items-center gap-2 lg:flex">
              <PDPHeroNavigationButtons
                goToNextImage={() => transitionTo(Math.max(0, safeCurrentPage - 1))}
                goToPreviousImage={() =>
                  transitionTo(Math.min(totalPages - 1, safeCurrentPage + 1))
                }
                nextDisabled={safeCurrentPage === 0 || isAnimating}
                previousDisabled={safeCurrentPage === totalPages - 1 || isAnimating}
                nextLabel="صفحه قبلی محصولات"
                previousLabel="صفحه بعدی محصولات"
              />
              <div className="flex items-center gap-1 text-xs text-neutral-500" aria-live="polite">
                <span>{safeCurrentPage + 1}</span>
                <span>/</span>
                <span>{totalPages}</span>
              </div>
            </div>
          ) : null}

          <Link
            href={viewAllTarget}
            /* Measured at 127 KB of full-segment RSC per PDP view, competing with the
               hero image for bandwidth. These "view more" links sit below the rail,
               not on the primary path; the homepage hero CTAs keep their prefetch. */
            prefetch={false}
            className="hidden text-sm text-infinity-primary underline-offset-4 transition-colors hover:text-infinity-primary-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white md:block"
          >
            مشاهده همه
          </Link>
        </div>
      </div>

      <div
        className={cn(
          "min-w-0",
          richTransition && "aq-decorative-motion transform transition-all duration-300 ease-out",
          richTransition && (isAnimating ? "scale-95 opacity-0" : "scale-100 opacity-100"),
        )}
        data-aq-carousel-track
      >
        <ProductRailTrack
          desktopClassName="lg:grid-cols-3 xl:grid-cols-4 3xl:grid-cols-5 3xl:gap-5 4xl:grid-cols-6"
          data-aq-home-product-list
          data-products-per-page={productsPerPage}
        >
          {products.map((product, index) => {
            // Every product stays in the DOM so the mobile track always has
            // something to scroll; desktop paging hides the cards outside the
            // current window instead of unmounting them.
            const visibleOnDesktop = index >= startIndex && index < startIndex + productsPerPage;
            return (
              <ProductRailSlide
                key={product.id}
                className={cn(
                  "min-w-0",
                  safeCurrentPage === 0
                    ? firstPageDesktopVisibility(index)
                    : visibleOnDesktop
                      ? "lg:block"
                      : "lg:hidden",
                  richTransition &&
                    "aq-decorative-motion transform transition-all duration-200 ease-out hover:-translate-y-1 hover:scale-[1.02]",
                )}
              >
                <ProductCard {...product} />
              </ProductRailSlide>
            );
          })}
        </ProductRailTrack>
      </div>

      <div className="mt-4 flex items-center justify-center md:hidden">
        <Link
          href={viewAllTarget}
          /* Measured at 127 KB of full-segment RSC per PDP view, competing with the
               hero image for bandwidth. These "view more" links sit below the rail,
               not on the primary path; the homepage hero CTAs keep their prefetch. */
          prefetch={false}
          className="pressable text-foreground-primary flex items-center gap-1 rounded-full border border-infinity-primary-lighter/40 px-4 py-2 text-base underline-offset-4 transition-colors hover:bg-infinity-primary-lighter/20 hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
        >
          <span>مشاهده همه</span>
          <ArrowLeftIcon />
        </Link>
      </div>
    </div>
  );
}
