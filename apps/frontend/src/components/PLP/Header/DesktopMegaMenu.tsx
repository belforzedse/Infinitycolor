"use client";

import Image from "next/image";
import Link from "next/link";
import type { ProductCategorySummary } from "@/services/product/categories";
import { StorefrontContainer } from "@/components/storefront";
import { getCategoryPlpHref } from "@/utils/plpRoutes";

type Props = {
  category: ProductCategorySummary;
  onLinkClick?: () => void;
};

function getBannerImage(category: ProductCategorySummary) {
  const src = category.megaMenuImageUrl || category.imageUrl;
  if (!src) return null;

  return {
    src,
    alt: category.megaMenuImageUrl
      ? category.megaMenuImageAlt || category.name
      : category.imageAlt || category.name,
  };
}

export default function DesktopMegaMenu({ category, onLinkClick }: Props) {
  const children = category.children ?? [];
  const banner = getBannerImage(category);
  const menuItems = children.length > 0 ? children : [category];
  const gridColumnsClass = menuItems.length > 1 ? "grid-cols-2" : "grid-cols-1";

  return (
    <div
      className="overflow-hidden rounded-b-[24px] bg-white shadow-[0_24px_70px_rgba(15,23,42,0.18)] ring-1 ring-black/5"
      data-testid="desktop-mega-menu"
    >
      <div className="bg-white px-0 py-5">
        <StorefrontContainer>
          <div className="flex min-h-[430px] flex-row items-start justify-start gap-6">
            <div className="relative h-[430px] w-[363px] shrink-0 overflow-hidden rounded-xl bg-stone-50">
              {banner ? (
                <Image
                  src={banner.src}
                  alt={banner.alt}
                  fill
                  sizes="363px"
                  className="object-cover"
                  priority={false}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-stone-50 px-8 text-center text-sm text-neutral-400">
                  تصویر مگامنو تنظیم نشده است
                </div>
              )}
            </div>

            <div
              className={[
                "grid max-h-[430px] min-w-0 flex-1 auto-rows-[41px] gap-x-6 gap-y-[21px] overflow-y-auto overflow-x-hidden pb-1",
                gridColumnsClass,
              ].join(" ")}
            >
              {menuItems.map((item) => (
                <Link
                  key={item.id}
                  href={getCategoryPlpHref(item.slug)}
                  onClick={onLinkClick}
                  className="pressable flex h-[41px] min-w-0 items-center justify-end rounded-[10px] bg-[#FAFAF9] px-3 py-1 text-right font-peyda-fanum text-lg font-normal leading-8 text-neutral-800 transition-colors hover:bg-stone-100 hover:text-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 focus-visible:ring-offset-white"
                >
                  <span className="block w-full truncate">{item.name}</span>
                </Link>
              ))}
            </div>
          </div>
        </StorefrontContainer>
      </div>
    </div>
  );
}
