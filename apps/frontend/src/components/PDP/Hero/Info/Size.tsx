"use client";

import { useState } from "react";
import AttributeChip from "./AttributeChip";
import RulerIcon from "../../Icons/RulerIcon";
import PDPHeroSizeModal from "../SizeModal";
import type { ProductSizeHelper } from "@/services/product/product";

type Props = {
  sizes: {
    id: string;
    title: string;
    available?: boolean; // Add availability flag
    stock?: number; // Optional stock count
    variations: {
      title: string;
      value: string;
      stock?: number; // Optional stock per variation
    }[];
  }[];
  onSizeChange?: (sizeId: string) => void;
  selectedSize?: string;
  sizeHelper?: ProductSizeHelper | null;
  disabledSizeIds?: string[]; // Keep as fallback
  showSizeOptions?: boolean;
};

export default function PDPHeroInfoSize(props: Props) {
  const {
    sizes,
    onSizeChange,
    selectedSize: externalSelectedSize,
    sizeHelper,
    disabledSizeIds = [],
    showSizeOptions = true,
  } = props;

  // Automatically determine disabled sizes based on availability
  const getDisabledSizeIds = () => {
    const autoDisabled = sizes
      .filter((size) => {
        // Check if size is explicitly marked as unavailable
        if (size.available === false) return true;

        // Check if size has no stock
        if (size.stock !== undefined && size.stock <= 0) return true;

        // Check if all variations are out of stock
        const hasAvailableVariations =
          size.variations.length === 0 ||
          size.variations.some((variation) => variation.stock === undefined || variation.stock > 0);

        return !hasAvailableVariations;
      })
      .map((size) => size.id);

    // Combine with manually disabled sizes
    return Array.from(new Set([...autoDisabled, ...disabledSizeIds]));
  };

  const actualDisabledSizeIds = getDisabledSizeIds();

  const [internalSelectedSize, setInternalSelectedSize] = useState<string>(sizes[0]?.id || "");

  // Use either the external selected size if provided, or the internal state
  const selectedSize =
    externalSelectedSize !== undefined ? externalSelectedSize : internalSelectedSize;

  const [openSizeModal, setOpenSizeModal] = useState<boolean>(false);

  const handleSizeClick = (sizeId: string) => {
    // Double check - prevent clicks on disabled sizes
    if (actualDisabledSizeIds.includes(sizeId)) {
      return;
    }

    setInternalSelectedSize(sizeId);
    if (onSizeChange) {
      onSizeChange(sizeId);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <PDPHeroSizeModal
        open={openSizeModal}
        onClose={() => setOpenSizeModal(false)}
        sizeHelper={sizeHelper}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {showSizeOptions && <span className="text-xl text-neutral-800">انتخاب سایز</span>}

          <button
            type="button"
            data-testid="pdp-size-guide-button"
            className="flex cursor-pointer items-center"
            onClick={() => setOpenSizeModal(true)}
          >
            <span className="text-xs text-actions-link underline">راهنمای سایز</span>

            <RulerIcon />
          </button>
        </div>
      </div>

      {showSizeOptions && (
        /**
         * Sizes used to sit in a sideways scroller behind a pair of arrows, which
         * hid options on narrow viewports. They wrap onto extra rows instead, so
         * every size is on screen without a scroll gesture.
         */
        <div
          className="flex flex-wrap items-center gap-2"
          role="radiogroup"
          aria-label="انتخاب سایز محصول"
        >
          {sizes.map((size) => {
            const isSelected = size.id === selectedSize;
            const isDisabled = actualDisabledSizeIds.includes(size.id);
            return (
              <AttributeChip
                key={size.id}
                title={size.title}
                selected={isSelected}
                disabled={isDisabled}
                onClick={() => handleSizeClick(size.id)}
                ariaLabel={isDisabled ? `سایز ${size.title} ناموجود` : `انتخاب سایز ${size.title}`}
                dataProps={{
                  "data-testid": "pdp-size-option",
                  "data-size-id": size.id,
                  "data-size-title": size.title,
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
