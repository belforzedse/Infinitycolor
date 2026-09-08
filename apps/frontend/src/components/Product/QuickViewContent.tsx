"use client";

import { useMemo, useState } from "react";
import {
  getGenericAttributeSelectors,
  getVariationGenericSelection,
  type ProductDetail,
} from "@/services/product/product";
import { resolveAssetUrl } from "@/utils/resolveAssetUrl";
import { computeDiscountForVariation } from "@/utils/discounts";
import QuickViewGallery from "./QuickViewGallery";
import QuickViewVariationSelector from "./QuickViewVariationSelector";
import QuickViewPricing from "./QuickViewPricing";

interface QuickViewContentProps {
  productData: ProductDetail;
  productId: number;
  onViewFullDetails: () => void;
  onClose: () => void;
}

type VariationUI = {
  id: number;
  price: number;
  discountPrice?: number | null;
  stock: number;
  color: { title: string; colorCode: string | null } | null;
  size: { title: string } | null;
  generic: Record<string, string>;
};

export default function QuickViewContent({
  productData,
  productId: _productId, // keep prop shape, avoid unused lint
  onViewFullDetails,
  onClose,
}: QuickViewContentProps) {
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [selectedColorCode, setSelectedColorCode] = useState<string | null>(null);
  const [selectedSizeTitle, setSelectedSizeTitle] = useState<string | null>(null);
  const [selectedGeneric, setSelectedGeneric] = useState<Record<string, string>>({});

  const { Title, CoverImage, Media, product_variations } = productData.attributes;

  const allImages = useMemo(() => {
    const images: string[] = [];

    // Add cover image/video if it exists
    if (CoverImage?.data?.attributes?.url) {
      const coverMime = CoverImage.data.attributes.mime;
      // Only include images in QuickView for performance (videos can be viewed in full PDP)
      if (coverMime?.startsWith("image/")) {
        const resolvedUrl = resolveAssetUrl(CoverImage.data.attributes.url);
        if (resolvedUrl) images.push(resolvedUrl);
      }
    }

    // Add media gallery images (exclude videos for QuickView performance)
    if (Media?.data) {
      for (const media of Media.data) {
        const mediaMime = media.attributes?.mime;
        if (media.attributes?.url && mediaMime?.startsWith("image/")) {
          const resolvedUrl = resolveAssetUrl(media.attributes.url);
          if (resolvedUrl) images.push(resolvedUrl);
        }
      }
    }

    // de-dupe (optional)
    return Array.from(new Set(images));
  }, [CoverImage, Media]);

  const variations: VariationUI[] = useMemo(() => {
    if (!product_variations?.data) return [];

    return product_variations.data
      .filter((v) => v.attributes?.IsPublished !== false)
      .map((variation) => {
        const {
          Price,
          DiscountPrice,
          product_stock,
          product_variation_color,
          product_variation_size,
        } = variation.attributes;

        const stock = product_stock?.data?.attributes?.Count ?? 0;
        const color = product_variation_color?.data?.attributes;
        const size = product_variation_size?.data?.attributes;

        const price = typeof Price === "string" ? parseFloat(Price) : (Price ?? 0);
        const discountPrice =
          DiscountPrice == null
            ? null
            : typeof DiscountPrice === "string"
              ? parseFloat(DiscountPrice)
              : DiscountPrice;

        return {
          id: variation.id,
          price,
          discountPrice,
          stock,
          color: color ? { title: color.Title, colorCode: color.ColorCode ?? null } : null,
          size: size ? { title: size.Title } : null,
          generic: getVariationGenericSelection(variation),
        };
      });
  }, [product_variations]);

  // Defaults (derived) so UI highlights something even before user clicks
  const effectiveColorCode = selectedColorCode ?? variations[0]?.color?.colorCode ?? null;
  const effectiveSizeTitle = selectedSizeTitle ?? variations[0]?.size?.title ?? null;
  const genericSelectors = useMemo(() => getGenericAttributeSelectors(productData), [productData]);
  const effectiveGeneric = useMemo(
    () =>
      Object.keys(selectedGeneric).length > 0 ? selectedGeneric : variations[0]?.generic || {},
    [selectedGeneric, variations],
  );

  const currentVariation = useMemo(() => {
    if (!variations.length) return undefined;

    const matches = variations.filter((v) => {
      const okColor = effectiveColorCode ? v.color?.colorCode === effectiveColorCode : true;
      const okSize = effectiveSizeTitle ? v.size?.title === effectiveSizeTitle : true;
      const okGeneric = genericSelectors.every(
        (selector) =>
          v.generic[String(selector.attributeId)] ===
          effectiveGeneric[String(selector.attributeId)],
      );
      return okColor && okSize && okGeneric;
    });

    return matches[0];
  }, [variations, effectiveColorCode, effectiveSizeTitle, effectiveGeneric, genericSelectors]);

  const hasDiscount = useMemo(() => {
    if (!currentVariation) return false;
    const { price, discountPrice } = currentVariation;
    return Boolean(discountPrice && discountPrice > 0 && discountPrice < price);
  }, [currentVariation]);

  const discountPercent = useMemo(() => {
    if (!hasDiscount || !currentVariation?.discountPrice) return 0;
    const result = computeDiscountForVariation({
      Price: currentVariation.price,
      DiscountPrice: currentVariation.discountPrice,
    });
    return result?.discountPercent ?? 0;
  }, [hasDiscount, currentVariation]);

  const colors = useMemo(() => {
    // Only include colors with a valid hex code. Hex-less colors (null colorCode)
    // are excluded from the product-card quick-view swatch selector.
    const uniqueColors = new Map<string, { title: string; colorCode: string }>();
    for (const v of variations) {
      if (v.color?.colorCode && !uniqueColors.has(v.color.colorCode)) {
        uniqueColors.set(v.color.colorCode, v.color as { title: string; colorCode: string });
      }
    }
    return Array.from(uniqueColors.values());
  }, [variations]);

  const sizes = useMemo(() => {
    const uniqueSizes = new Map<string, { title: string }>();
    for (const v of variations) {
      if (v.size && !uniqueSizes.has(v.size.title)) uniqueSizes.set(v.size.title, v.size);
    }
    return Array.from(uniqueSizes.values());
  }, [variations]);

  const isInStock = currentVariation ? currentVariation.stock > 0 : false;

  // Optional: sizes available under selected color (better UX)
  const availableSizesForColor = useMemo(() => {
    if (!effectiveColorCode) return new Set(sizes.map((s) => s.title));
    const set = new Set<string>();
    for (const v of variations) {
      if (v.color?.colorCode === effectiveColorCode && v.size?.title) set.add(v.size.title);
    }
    return set;
  }, [effectiveColorCode, sizes, variations]);
  const availableGenericTermIds = useMemo(() => {
    const ids = new Set<string>();
    variations.forEach((variation) => {
      if (variation.stock <= 0) return;
      Object.values(variation.generic).forEach((termId) => ids.add(termId));
    });
    return ids;
  }, [variations]);

  return (
    <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-2" data-testid="quick-view-content">
      <QuickViewGallery
        images={allImages}
        title={Title}
        selectedIndex={selectedImageIndex}
        onSelectIndex={setSelectedImageIndex}
        hasDiscount={hasDiscount}
        discountPercent={discountPercent}
      />

      {/* Info */}
      <div className="flex min-h-0 flex-col gap-4">
        <div className="space-y-2">
          <h2
            id="quick-view-title"
            className="text-lg font-semibold text-gray-900 sm:text-xl lg:text-2xl"
          >
            {Title}
          </h2>

          {/* Stock pill */}
          <div
            className={[
              "inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ring-1",
              isInStock
                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                : "bg-rose-50 text-rose-700 ring-rose-200",
            ].join(" ")}
          >
            <span className="h-2 w-2 rounded-full bg-current opacity-70" />
            <span>{isInStock ? "موجود در انبار" : "ناموجود"}</span>
          </div>
        </div>

        {/* Price and Actions */}
        {currentVariation ? (
          <QuickViewPricing
            price={currentVariation.price}
            discountPrice={currentVariation.discountPrice}
            hasDiscount={hasDiscount}
            onViewFullDetails={onViewFullDetails}
            onClose={onClose}
          />
        ) : (
          <div className="flex flex-col gap-5">
            <div className="rounded-3xl bg-amber-50 p-4 ring-1 ring-amber-200">
              <p className="text-sm text-amber-800">
                ترکیب انتخاب‌شده موجود نیست. لطفاً رنگ یا سایز دیگری انتخاب کنید.
              </p>
            </div>

            <div className="sticky bottom-0 -mx-4 mt-auto border-t border-black/5 bg-white/80 p-4 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onViewFullDetails}
                  data-testid="quick-view-full-details"
                  className="flex-1 rounded-2xl bg-infinity-primary px-5 py-3 text-sm font-medium text-white shadow-sm transition hover:bg-infinity-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2"
                >
                  مشاهده جزئیات کامل
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  data-testid="quick-view-close"
                  className="rounded-2xl bg-white px-5 py-3 text-sm font-medium text-gray-700 ring-1 ring-black/10 transition hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300 focus-visible:ring-offset-2"
                >
                  بستن
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Variations */}
        <QuickViewVariationSelector
          colors={colors}
          sizes={sizes}
          effectiveColorCode={effectiveColorCode}
          effectiveSizeTitle={effectiveSizeTitle}
          availableSizesForColor={availableSizesForColor}
          onSelectColor={(colorCode) => {
            setSelectedColorCode(colorCode);
            // Re-compute available sizes for the NEW color inline to decide if we should reset size
            const sizesForNewColor = new Set(
              variations
                .filter((v) => v.color?.colorCode === colorCode && v.size?.title)
                .map((v) => v.size!.title),
            );
            if (selectedSizeTitle && !sizesForNewColor.has(selectedSizeTitle)) {
              setSelectedSizeTitle(null);
            }
          }}
          onSelectSize={setSelectedSizeTitle}
          genericSelectors={genericSelectors}
          genericSelection={effectiveGeneric}
          availableGenericTermIds={availableGenericTermIds}
          onSelectGeneric={(attributeId, termId) => {
            const candidates = variations.filter(
              (variation) => variation.stock > 0 && variation.generic[attributeId] === termId,
            );
            const best = candidates
              .map((variation) => ({
                variation,
                score:
                  Object.entries(effectiveGeneric).filter(
                    ([key, value]) => key !== attributeId && variation.generic[key] === value,
                  ).length +
                  (variation.color?.colorCode === effectiveColorCode ? 1 : 0) +
                  (variation.size?.title === effectiveSizeTitle ? 1 : 0),
              }))
              .sort((left, right) => right.score - left.score)[0]?.variation;
            if (!best) return;
            setSelectedGeneric(best.generic);
            setSelectedColorCode(best.color?.colorCode ?? null);
            setSelectedSizeTitle(best.size?.title ?? null);
          }}
        />

        {/* Description intentionally omitted — shown on the full PDP. */}
      </div>
    </div>
  );
}
