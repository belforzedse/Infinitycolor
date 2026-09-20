"use client";

import Image from "next/image";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ProductCategorySummary } from "@/services/product/categories";
import { StorefrontContainer } from "@/components/storefront/StorefrontContainer";
import { getCategoryPlpHref } from "@/utils/plpRoutes";
import { getStorefrontMenuArtwork } from "@/utils/storefrontMenuArtwork";
import {
  getViewAllCategoryLabel,
  isSyntheticStorefrontMenuCategory,
  type StorefrontMenuTaxonomyItem,
} from "@/utils/storefrontMenuTaxonomy";

type MenuItem = StorefrontMenuTaxonomyItem<ProductCategorySummary>;

type Props = {
  item: MenuItem;
  onLinkClick?: () => void;
};

function getItemLabel(item: MenuItem): string {
  return item.type === "group" ? item.label : item.category.name;
}

function getBannerImage(item: MenuItem) {
  const hardcoded = getStorefrontMenuArtwork(item.key);
  if (hardcoded) return hardcoded;
  if (item.type === "group") return null;

  const category = item.category;
  const src = category.megaMenuImageUrl || category.imageUrl;
  if (!src) return null;

  return {
    src,
    alt: category.megaMenuImageUrl
      ? category.megaMenuImageAlt || category.name
      : category.imageAlt || category.name,
  };
}

function getImmediateCategories(item: MenuItem): ProductCategorySummary[] {
  return item.type === "group" ? item.categories : (item.category.children ?? []);
}

function hasChildren(category: ProductCategorySummary): boolean {
  return Boolean(category.children?.length);
}

export default function DesktopMegaMenu({ item, onLinkClick }: Props) {
  const label = getItemLabel(item);
  const categories = getImmediateCategories(item);
  const banner = getBannerImage(item);
  const [activeNestedId, setActiveNestedId] = useState<number | null>(null);
  const [renderedNested, setRenderedNested] = useState<ProductCategorySummary | null>(null);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextFocusOpenRef = useRef(false);

  const activeNested =
    categories.find((category) => category.id === activeNestedId && hasChildren(category)) ?? null;

  const openNested = (category: ProductCategorySummary) => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    setRenderedNested(category);
    setActiveNestedId(category.id);
  };

  useEffect(() => {
    if (activeNestedId !== null || !renderedNested) return;

    const timeout = setTimeout(() => {
      setRenderedNested(null);
      closeTimeoutRef.current = null;
    }, 170);
    closeTimeoutRef.current = timeout;

    return () => {
      clearTimeout(timeout);
      if (closeTimeoutRef.current === timeout) closeTimeoutRef.current = null;
    };
  }, [activeNestedId, renderedNested]);

  const closeNested = () => setActiveNestedId(null);

  const openNestedFromFocus = (category: ProductCategorySummary) => {
    if (suppressNextFocusOpenRef.current) {
      suppressNextFocusOpenRef.current = false;
      return;
    }
    openNested(category);
  };

  const handleLinkClick = () => {
    closeNested();
    onLinkClick?.();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || activeNestedId === null) return;
    const triggerId = activeNestedId;
    event.preventDefault();
    event.stopPropagation();
    closeNested();
    window.requestAnimationFrame(() => {
      const trigger = document.getElementById(`desktop-mega-trigger-${triggerId}`);
      if (trigger && document.activeElement !== trigger) {
        suppressNextFocusOpenRef.current = true;
        trigger.focus();
      }
    });
  };

  const topLevelViewAllCount = item.type === "category" ? 1 : 0;
  const menuItemCount = categories.length + topLevelViewAllCount;
  const gridColumnsClass = menuItemCount > 1 ? "grid-cols-3" : "grid-cols-1";

  const renderCategoryRow = (category: ProductCategorySummary, index: number) => {
    const categoryHasChildren = hasChildren(category);
    const isExpanded = activeNestedId === category.id;
    const gridIndex = index + topLevelViewAllCount;
    const flyoutAlignmentClass =
      gridIndex % 3 === 0
        ? "right-0"
        : gridIndex % 3 === 1
          ? "left-1/2 -translate-x-1/2"
          : "left-0";
    const sharedClassName = [
      "pressable flex h-[41px] w-full min-w-0 items-center justify-end rounded-[10px] bg-[#FAFAF9] px-3 py-1 text-right font-peyda-fanum text-lg font-normal leading-8 text-neutral-800 transition-colors hover:bg-stone-100 hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white",
      isExpanded ? "bg-infinity-primary-lighter/20 text-infinity-primary" : "",
    ].join(" ");

    if (!categoryHasChildren) {
      return (
        <Link
          key={category.id}
          href={getCategoryPlpHref(category.slug)}
          prefetch={false}
          onClick={handleLinkClick}
          onFocus={closeNested}
          onPointerEnter={closeNested}
          className={sharedClassName}
        >
          <span className="block w-full truncate">{category.name}</span>
        </Link>
      );
    }

    return (
      <div key={category.id} className="relative h-[41px] w-full min-w-0">
        <button
          id={`desktop-mega-trigger-${category.id}`}
          type="button"
          aria-expanded={isExpanded}
          aria-controls={`desktop-mega-flyout-${category.id}`}
          onClick={() => (isExpanded ? closeNested() : openNested(category))}
          onFocus={() => openNestedFromFocus(category)}
          onPointerEnter={() => openNested(category)}
          className={[sharedClassName, "relative"].join(" ")}
          data-testid="desktop-mega-nested-trigger"
        >
          <span className="block w-full truncate pl-5">{category.name}</span>
          <ChevronLeft
            className="absolute left-3 h-4 w-4 text-infinity-primary"
            aria-hidden="true"
          />
        </button>

        {renderedNested?.id === category.id && (
          <div
            className={["absolute top-[calc(100%+8px)] z-30 w-full", flyoutAlignmentClass].join(
              " ",
            )}
          >
            <div
              id={`desktop-mega-flyout-${renderedNested.id}`}
              className="storefront-mega-flyout relative z-50 max-h-[320px] w-full shrink-0 overflow-y-auto rounded-xl border border-stone-200 bg-white p-3 shadow-[0_18px_45px_rgba(15,23,42,0.16)]"
              data-state={activeNested ? "open" : "closed"}
              data-testid="desktop-mega-menu-flyout"
              aria-label={`زیرمجموعه‌های ${renderedNested.name}`}
              onAnimationEnd={() => {
                if (!activeNested) {
                  if (closeTimeoutRef.current) {
                    clearTimeout(closeTimeoutRef.current);
                    closeTimeoutRef.current = null;
                  }
                  setRenderedNested(null);
                }
              }}
            >
              <p className="mb-2 border-b border-stone-100 px-1 pb-2 text-sm font-semibold text-neutral-900">
                {renderedNested.name}
              </p>
              <div className="space-y-1">
                {!isSyntheticStorefrontMenuCategory(renderedNested) && (
                  <Link
                    href={getCategoryPlpHref(renderedNested.slug)}
                    prefetch={false}
                    onClick={handleLinkClick}
                    className="block rounded-[10px] bg-infinity-primary-lighter/20 px-3 py-2 text-sm font-semibold text-infinity-primary-dark transition-colors hover:bg-infinity-primary-lighter/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary"
                  >
                    {getViewAllCategoryLabel(renderedNested.name)}
                  </Link>
                )}
                {(renderedNested.children ?? []).map((child) => (
                  <Link
                    key={child.id}
                    href={getCategoryPlpHref(child.slug)}
                    prefetch={false}
                    onClick={handleLinkClick}
                    className="block rounded-[10px] bg-[#FAFAF9] px-3 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-stone-100 hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary"
                  >
                    <span className="block truncate">{child.name}</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="overflow-hidden rounded-b-[24px] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.18)] ring-1 ring-black/5"
      data-testid="desktop-mega-menu"
      role="region"
      aria-label={`دسته‌بندی ${label}`}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white px-0 py-5">
        <StorefrontContainer>
          <div className="flex min-h-[430px] flex-row items-start justify-start gap-6" dir="rtl">
            <div
              className="relative h-[430px] w-[363px] shrink-0 overflow-hidden rounded-xl bg-stone-50"
              onPointerEnter={closeNested}
            >
              {banner ? (
                <Image
                  src={banner.src}
                  alt={banner.alt}
                  fill
                  sizes="363px"
                  className="object-cover"
                  priority={false}
                  unoptimized={banner.src.startsWith("/")}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-stone-50 px-8 text-center text-sm text-neutral-400">
                  تصویر مگامنو تنظیم نشده است
                </div>
              )}
            </div>

            <div
              data-testid="desktop-mega-menu-links"
              className={[
                "grid min-w-0 flex-1 auto-rows-[41px] grid-cols-[repeat(3,minmax(0,1fr))] gap-x-4 gap-y-[21px] overflow-visible pb-1",
                gridColumnsClass,
              ].join(" ")}
            >
              {item.type === "category" && (
                <Link
                  href={getCategoryPlpHref(item.category.slug)}
                  prefetch={false}
                  onClick={handleLinkClick}
                  onFocus={closeNested}
                  onPointerEnter={closeNested}
                  className="pressable flex h-[41px] min-w-0 items-center justify-end rounded-[10px] bg-[#FAFAF9] px-3 py-1 text-right font-peyda-fanum text-lg font-normal leading-8 text-neutral-800 transition-colors hover:bg-stone-100 hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                >
                  <span className="block w-full truncate">{getViewAllCategoryLabel(label)}</span>
                </Link>
              )}
              {categories.map(renderCategoryRow)}
            </div>
          </div>
        </StorefrontContainer>
      </div>
    </div>
  );
}
