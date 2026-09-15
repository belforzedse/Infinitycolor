"use client";

import Button from "@/components/Kits/PLP/Button";
import ChatIcon from "../../Icons/ChatIcon";
import HeartIcon from "../../Icons/HeartIcon";
import ShareIcon from "../../Icons/ShareIcon";
import BasketIcon from "../../Icons/BasketIcon";
import { useState, useEffect } from "react";
import Select from "@/components/Kits/Form/Select";
import useProductLike from "@/hooks/useProductLike";
import useAddToCart from "@/hooks/useAddToCart";
import {
  hasStockForVariation,
  getAvailableStockCount,
  LOW_STOCK_DISPLAY_THRESHOLD,
} from "@/services/product/product";
import { faNum } from "@/utils/faNum";
import notify from "@/utils/notify";
import logger from "@/utils/logger";
import { useScrollToComments } from "./useScrollToComments";
import { trackAnalyticsEvent } from "@/lib/analytics";

type ShareModalComponent = (typeof import("@/components/Product/ShareModal"))["default"];

let shareModulePromise: Promise<typeof import("@/components/Product/ShareModal")> | null = null;

function loadShareModule() {
  shareModulePromise ??= import("@/components/Product/ShareModal");
  return shareModulePromise;
}

/**
 * Props for the PDPHeroInfoAction component
 * @interface PDPHeroInfoActionProps
 * @property {string} productId - Unique identifier for the product
 * @property {string} name - Name of the product
 * @property {string} category - Product category
 * @property {number} price - Product price
 * @property {string} image - Product image URL
 * @property {string} [color] - Selected color variation (optional)
 * @property {string} [size] - Selected size variation (optional)
 * @property {string} [model] - Selected model variation (optional)
 * @property {string} [variationId] - Selected product variation ID (optional)
 * @property {boolean} [hasStock] - Whether product is in stock (defaults to true)
 * @property {any} [currentVariation] - Current variation data for stock validation
 */
interface PDPHeroInfoActionProps {
  productId: string;
  name: string;
  category: string;
  price: number;
  originalPrice?: number;
  discountPercentage?: number;
  image: string;
  color?: string;
  size?: string;
  model?: string;
  variationId?: string;
  productSlug?: string;
  hasStock?: boolean;
  currentVariation?: any; // Add current variation data
}

/**
 * Product Detail Page Hero Action Component
 *
 * Renders the action buttons section of a product detail page, including:
 * - Add to cart functionality with quantity selection
 * - Share product button
 * - Add to favorites button
 * - Navigate to comments button
 *
 * Features:
 * - Real-time stock validation
 * - Quantity adjustment based on available stock
 * - Toast notifications for user feedback
 * - URL sharing with clipboard support
 *
 * @param {PDPHeroInfoActionProps} props Component props
 * @returns {JSX.Element} Rendered component
 */
export default function PDPHeroInfoAction({
  productId = "",
  name = "",
  category = "",
  price = 0,
  originalPrice,
  discountPercentage,
  image = "",
  color,
  size,
  model,
  variationId,
  productSlug,
  hasStock = true,
  currentVariation,
}: PDPHeroInfoActionProps) {
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [ShareModal, setShareModal] = useState<ShareModalComponent | null>(null);
  const [isClientMounted, setIsClientMounted] = useState(false);

  // Initialize product like hook
  const { isLiked, isLoading, toggleLike } = useProductLike({
    productId,
  });

  // Snapshot used to cap cart controls. Cart mutations still verify current
  // stock on the server in case inventory changes after this page was loaded.
  const availableStock = currentVariation ? getAvailableStockCount(currentVariation) : 0;

  // Initialize add to cart hook
  const { quantity, setQuantity, isAdding, isInCart, isCartReady, addToCart } = useAddToCart({
    productId,
    name,
    category,
    price,
    originalPrice,
    discountPercentage,
    image,
    color,
    size,
    model,
    variationId,
    productSlug,
    availableStock,
  });

  // Validate if selected quantity is available
  /**
   * Validates if requested quantity is available in stock
   * @param {number} requestedQuantity - Quantity to validate
   * @returns {boolean} True if quantity is available, false otherwise
   */
  const validateQuantity = (requestedQuantity: number): boolean => {
    if (!currentVariation) {
      return false;
    }

    return hasStockForVariation(currentVariation, requestedQuantity);
  };

  // Enhanced add to cart handler with stock validation
  /**
   * Handles adding items to cart with stock validation
   * @param {number} requestedQuantity - Quantity to add to cart
   */
  const handleAddToCart = (requestedQuantity: number = 1) => {
    if (isInCart) {
      addToCart();
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      logger.info("=== ADD TO CART DEBUG ===");
      logger.info("Requested quantity", { requestedQuantity });
      logger.info("Current variation ID being sent to cart", { variationId });
      logger.info("Current variation object we're checking stock for", {
        currentVariation,
      });
      logger.info("Available stock count", { availableStock });
    }

    // Validate stock before adding to cart
    if (!validateQuantity(requestedQuantity)) {
      if (process.env.NODE_ENV !== "production") {
        logger.info("❌ Stock validation failed");
      }
      notify.error(`موجودی کافی نیست. موجودی فعلی: ${availableStock} عدد`);
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      logger.info("✅ Stock validation passed - calling addToCart");
      logger.info("Product details being sent to cart", {
        productId,
        name,
        category,
        price,
        image,
        color,
        size,
        model,
        variationId,
      });
      logger.info("=== END ADD TO CART DEBUG ===");
    }

    // Call the original add to cart function
    trackAnalyticsEvent({
      category: "engagement",
      action: "click_add_to_cart",
      properties: {
        product_id: productId,
        ...(variationId ? { variant_id: variationId } : {}),
        quantity: requestedQuantity,
      },
    });
    addToCart(requestedQuantity);
  };

  const handleShare = () => {
    trackAnalyticsEvent({
      category: "engagement",
      action: "share_product",
      properties: { product_id: productId },
    });
    setIsShareOpen(true);
    void loadShareModule()
      .then((module) => setShareModal(() => module.default))
      .catch(() => setIsShareOpen(false));
  };

  // Handle scroll to comments
  // Shared with the review-count link in CommentsInfo so both reach the same anchor.
  const handleScrollToComments = useScrollToComments(productId);

  // Clean up timeout on component unmount
  useEffect(() => {
    setIsClientMounted(true);
  }, []);

  // Handle quantity change
  /**
   * Handles quantity selection changes with stock validation
   * Shows error toast if selected quantity exceeds available stock
   * @param {any} option - Selected quantity option
   */
  const handleQuantityChange = (option: any) => {
    const newQuantity = Number(option.id);

    // Validate the new quantity against available stock
    if (!validateQuantity(newQuantity)) {
      notify.error(`موجودی کافی نیست. موجودی فعلی: ${availableStock} عدد`);
      return;
    }

    setQuantity(newQuantity);
  };

  const handleToggleLike = async (e: React.MouseEvent<HTMLButtonElement>) => {
    try {
      await toggleLike(e);
      trackAnalyticsEvent({
        category: "engagement",
        action: isLiked ? "remove_from_wishlist" : "add_to_wishlist",
        properties: { product_id: productId },
      });
    } catch (err) {
      logger.error("Failed to toggle like", { productId, name, error: err });
      notify.error("خطا در به‌روزرسانی علاقه‌مندی");
    }
  };

  /**
   * Quantity choices, capped at the lower of the per-order limit and what is
   * actually available (physical stock minus live reservations). Returns an
   * empty list at zero rather than falling back to a static 1..5: the selector
   * is not rendered in the out-of-stock branch, and a stale fallback there
   * would silently offer quantities that cannot be bought.
   */
  const generateQuantityOptions = () => {
    const maxOptions = Math.min(LOW_STOCK_DISPLAY_THRESHOLD, availableStock);
    return Array.from({ length: maxOptions }, (_, i) => ({
      id: i + 1,
      name: `${faNum(i + 1)} عدد`,
    }));
  };

  const dynamicOptions = availableStock > 0 ? generateQuantityOptions() : [];
  const showLowStockHint =
    hasStock && availableStock > 0 && availableStock <= LOW_STOCK_DISPLAY_THRESHOLD;

  // Find the current option based on quantity
  const currentOption = dynamicOptions.find((opt) => opt.id === quantity) || null;
  const isCartActionReady = isClientMounted && isCartReady;
  const isCartActionPending = isClientMounted && !isCartReady;
  const productNumericId = Number.parseInt(productId, 10);
  const variantLabel = [color, size, model].filter(Boolean).join(" / ");
  const iconButtonClass =
    "flex h-[46px] flex-1 items-center justify-center rounded-xl border border-slate-200 bg-white text-neutral-800 transition-colors hover:border-infinity-primary-lighter hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 md:w-[46px] md:flex-auto";

  return (
    <div
      className="relative flex flex-col items-center gap-3 md:flex-row"
      data-testid="pdp-cart-action"
      data-cart-ready={isCartActionReady ? "true" : "false"}
    >
      <div className="flex w-full items-center gap-3 md:w-auto">
        <button
          type="button"
          className={iconButtonClass}
          onClick={handleShare}
          aria-label="اشتراک‌گذاری محصول"
        >
          <ShareIcon />
        </button>

        <button
          type="button"
          className={iconButtonClass}
          onClick={handleScrollToComments}
          aria-label="مشاهده نظرات"
        >
          <ChatIcon />
        </button>

        <button
          type="button"
          className={`${iconButtonClass} ${isLoading ? "cursor-wait opacity-50" : ""}`}
          onClick={handleToggleLike}
          disabled={isLoading}
          aria-label={isLiked ? "حذف از علاقه‌مندی‌ها" : "افزودن به علاقه‌مندی‌ها"}
        >
          <HeartIcon
            filled={isLiked}
            className={isLiked ? "text-infinity-primary" : "text-neutral-800"}
          />
        </button>
      </div>

      <div className="flex w-full flex-1 flex-col gap-1.5">
        <div className="flex w-full gap-3">
          {!hasStock ? (
            <Button
              className="flex h-[46px] flex-1 cursor-not-allowed items-center justify-center rounded-xl bg-gray-400 py-0 text-base text-white"
              text="ناموجود"
              disabled={true}
            />
          ) : (
            <>
              <Button
                className={`flex h-[46px] flex-1 items-center justify-center rounded-xl py-0 text-base ${
                  isInCart
                    ? "border-2 border-infinity-primary bg-infinity-primary-lighter/20 !text-infinity-primary hover:border-infinity-primary hover:bg-infinity-primary-lighter/30"
                    : "bg-actions-primary !text-gray-100"
                } ${isAdding || isCartActionPending ? "cursor-wait opacity-50" : ""}`}
                text={isInCart ? "در سبد خرید (مشاهده)" : "افزودن به سبد خرید"}
                // `outline` keeps .btn-primary's hover fill from repainting the
                // in-cart button navy, which would hide the now-navy icon.
                variant={isInCart ? "outline" : "primary"}
                testId="pdp-add-to-cart"
                leftIcon={<BasketIcon />}
                disabled={isCartActionPending}
                onClick={
                  isAdding || isCartActionPending
                    ? undefined
                    : () => {
                        handleAddToCart(quantity || 1);
                      }
                }
              />
              <Select
                className="w-[126px]"
                selectButtonClassName="h-[46px] py-0"
                options={dynamicOptions}
                value={currentOption}
                onChange={handleQuantityChange}
                placeholder="تعداد"
              />
            </>
          )}
        </div>
        {/*
          Availability is `Count - reservedCount`, so a shopper used to learn the
          real number only from the rejection toast after overshooting. Say it up
          front instead, but only near the cap — above it the number is noise.
        */}
        {showLowStockHint && (
          <p
            className="text-xs text-neutral-500"
            data-testid="pdp-low-stock-hint"
            aria-live="polite"
          >
            {`تنها ${faNum(availableStock)} عدد باقی مانده`}
          </p>
        )}
      </div>

      {isShareOpen && ShareModal && (
        <ShareModal
          open={isShareOpen}
          onOpenChange={setIsShareOpen}
          product={{
            id: Number.isFinite(productNumericId) ? productNumericId : 0,
            title: name,
            imageUrl: image,
            price: originalPrice ?? price,
            discountPrice: originalPrice ? price : undefined,
            variantLabel: variantLabel || undefined,
          }}
        />
      )}
    </div>
  );
}
