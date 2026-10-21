"use client";
import { useState, useEffect, useMemo } from "react";
import Action from "./Action";
import Color from "./Color";
import CommentsInfo from "./CommentsInfo";
import { useScrollToComments } from "./useScrollToComments";
import FAQItem from "./FAQItem";
import Main from "./Main";
import Model from "./Model";
import Price from "./Price";
import Size from "./Size";
import GenericAttributes from "./GenericAttributes";
import {
  findProductVariation,
  getGenericAttributeSelectors,
  getInitialPdpSelection,
  getVariationGenericSelection,
  getVariationRelationIds,
  hasStockForVariation,
  type ProductDetail,
} from "@/services/product/product";
import logger from "@/utils/logger";

// Runtime-aware debug logger. It checks NODE_ENV and a runtime flag stored
// in localStorage (`pdp_debug`) or the build-time env `NEXT_PUBLIC_PDP_DEBUG`.
const isDebugActive = () => {
  if (process.env.NODE_ENV === "production") return false;
  try {
    if (typeof window !== "undefined") {
      const ls = localStorage.getItem("pdp_debug");
      if (ls !== null) return ls === "1";
    }
  } catch {
    // ignore localStorage access errors
  }
  return process.env.NEXT_PUBLIC_PDP_DEBUG === "true";
};

const debugLog = (...args: any[]) => {
  if (!isDebugActive()) return;
  const [message, ...meta] = args;
  logger.info(message, meta.length ? { meta } : undefined);
};

type Props = {
  product: {
    title: string;
    description: string;
    cleaningInstructions: string;
    returnPolicy: string;
    price: number;
    discount?: number;
    discountPrice?: number;
    category: string;
  };

  sizes: {
    id: string;
    title: string;
    variations: {
      title: string;
      value: string;
    }[];
  }[];

  colors: {
    id: string;
    title: string;
    colorCode: string | null | undefined;
  }[];

  models?: {
    id: string;
    title: string;
  }[];

  // Minimal typed shape for productData used in this component
  productData?: ProductDetail | null;
  productId: string;
  onSelectedColorChange?: (colorId: string) => void;
};

// Minimal types used by this component (narrowed from Strapi shape)
// Reuse shared types from `src/types/product.ts`

export default function PDPHeroInfo(props: Props) {
  const { product, sizes, colors, models = [], productData, productId } = props;
  const handleScrollToComments = useScrollToComments(productId);

  // Runtime toggle for debug panel (persisted in localStorage)
  const [isDebugEnabled, setIsDebugEnabled] = useState<boolean>(() => {
    try {
      if (typeof window !== "undefined") {
        const val = localStorage.getItem("pdp_debug");
        if (val !== null) return val === "1";
      }
    } catch {
      // ignore
    }
    return process.env.NEXT_PUBLIC_PDP_DEBUG === "true" && process.env.NODE_ENV !== "production";
  });

  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem("pdp_debug", isDebugEnabled ? "1" : "0");
      }
    } catch {
      // ignore
    }
  }, [isDebugEnabled]);

  const initialSelection = useMemo(
    () => getInitialPdpSelection(productData, colors, sizes, models),
    [productData, colors, sizes, models],
  );

  const selectionIdentity = `${productData?.id ?? productId}:${productData ? "ready" : "pending"}`;
  const [selectionState, setSelectionState] = useState({
    identity: selectionIdentity,
    ...initialSelection,
  });
  const selection =
    selectionState.identity === selectionIdentity
      ? selectionState
      : { identity: selectionIdentity, ...initialSelection };
  const selectedColor = selection.colorId;
  const selectedSize = selection.sizeId;
  const selectedModel = selection.modelId;
  const selectedGeneric = selection.generic;
  useEffect(() => {
    setSelectionState((current) =>
      current.identity === selectionIdentity
        ? current
        : { identity: selectionIdentity, ...initialSelection },
    );
  }, [selectionIdentity, initialSelection]);
  const changeSelection = (change: Partial<typeof initialSelection>) => {
    setSelectionState((current) => ({
      ...(current.identity === selectionIdentity
        ? current
        : { identity: selectionIdentity, ...initialSelection }),
      ...change,
    }));
  };
  const genericSelectors = useMemo(() => getGenericAttributeSelectors(productData), [productData]);

  // Compute disabled ids for colors, sizes and models based on productData stock
  const {
    disabledColors,
    disabledSizes,
    disabledModels,
    disabledGenericTerms,
    availableVariations,
  } = useMemo(() => {
    const disabledColors: string[] = [];
    const disabledSizes: string[] = [];
    const disabledModels: string[] = [];

    if (!productData?.attributes?.product_variations?.data) {
      return {
        disabledColors,
        disabledSizes,
        disabledModels,
        disabledGenericTerms: new Set<string>(),
        availableVariations: [],
      };
    }

    const variations: any[] = productData.attributes.product_variations.data;

    // Helper to mark option id as enabled when any variation containing it has stock
    const colorHasStock: Record<string, boolean> = {};
    const sizeHasStock: Record<string, boolean> = {};
    const modelHasStock: Record<string, boolean> = {};

    const availableVars: any[] = [];
    const genericTermHasStock = new Set<string>();
    variations.forEach((variation) => {
      // require published + stock to be considered purchasable
      const published = variation.attributes.IsPublished === true;
      const stockOk = hasStockForVariation(variation, 1);
      const purchasable = published && stockOk;
      if (purchasable) availableVars.push(variation);

      const { colorId, sizeId, modelId } = getVariationRelationIds(variation);
      if (purchasable) {
        Object.values(getVariationGenericSelection(variation)).forEach((termId) =>
          genericTermHasStock.add(termId),
        );
      }

      if (colorId) colorHasStock[colorId] = colorHasStock[colorId] || purchasable;
      if (sizeId) sizeHasStock[sizeId] = sizeHasStock[sizeId] || purchasable;
      if (modelId) modelHasStock[modelId] = modelHasStock[modelId] || purchasable;
    });

    colors.forEach((c) => {
      if (!colorHasStock[c.id]) disabledColors.push(c.id);
    });

    sizes.forEach((s) => {
      if (!sizeHasStock[s.id]) disabledSizes.push(s.id);
    });

    models.forEach((m) => {
      if (!modelHasStock[m.id]) disabledModels.push(m.id);
    });
    const disabledGenericTerms = new Set<string>();
    genericSelectors.forEach((selector) =>
      selector.options.forEach((option) => {
        if (!genericTermHasStock.has(option.id)) disabledGenericTerms.add(option.id);
      }),
    );

    return {
      disabledColors,
      disabledSizes,
      disabledModels,
      disabledGenericTerms,
      availableVariations: availableVars,
    };
  }, [productData, colors, sizes, models, genericSelectors]);

  // Selection, price and cart identity are derived together in the same render.
  const currentVariation = productData
    ? (findProductVariation(
        productData,
        selectedColor ? Number(selectedColor) : undefined,
        selectedSize ? Number(selectedSize) : undefined,
        selectedModel ? Number(selectedModel) : undefined,
        selectedGeneric,
      ) ?? null)
    : null;
  const hasStock = Boolean(currentVariation && hasStockForVariation(currentVariation, 1));
  const currentPrice = Number(currentVariation?.attributes.Price ?? 0);
  const salePrice = Number(currentVariation?.attributes.DiscountPrice ?? 0);
  const currentDiscountPrice = salePrice > 0 && salePrice < currentPrice ? salePrice : 0;
  const currentDiscount = currentDiscountPrice
    ? Math.round((1 - currentDiscountPrice / currentPrice) * 100)
    : 0;
  const currentVariationId = currentVariation ? String(currentVariation.id) : undefined;
  const handleSizeChange = (id: string) => changeSelection({ sizeId: id });
  const handleColorChange = (id: string) => {
    changeSelection({ colorId: id });
    props.onSelectedColorChange?.(id);
  };
  const handleModelChange = (id: string) => changeSelection({ modelId: id });
  const handleGenericChange = (attributeId: string, termId: string) =>
    changeSelection({ generic: { ...selectedGeneric, [attributeId]: termId } });

  // Get selected color and size objects
  const selectedColorObj = colors.find((color) => color.id === selectedColor);
  const selectedSizeObj = sizes.find((size) => size.id === selectedSize);
  const selectedModelObj = models.find((model) => model.id === selectedModel);

  const showSizeGuide = true;
  const showSizeSelector = sizes.length > 0;
  const showColorSelector = colors.length > 1;
  const hasVisibleVariationSelectors =
    showSizeGuide ||
    showSizeSelector ||
    showColorSelector ||
    models.length > 0 ||
    genericSelectors.length > 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 md:max-w-[400px] tablet:max-w-[500px] lg:max-w-[688px]">
      {process.env.NODE_ENV !== "production" && (
        <div>
          <div className="mb-2">
            <button
              type="button"
              onClick={() => setIsDebugEnabled((s) => !s)}
              className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-800"
            >
              {isDebugEnabled ? "Hide PDP Debug" : "Show PDP Debug"}
            </button>
          </div>

          {isDebugEnabled && (
            <div
              className="dev-debug-panel"
              style={{
                backgroundColor: "#f8fafc",
                padding: 12,
                fontSize: 12,
                color: "#334155",
              }}
            >
              <div style={{ fontWeight: 600 }}>DEV DEBUG: variations</div>
              <div style={{ marginTop: 8 }}>
                <div>
                  Available variation IDs:{" "}
                  {availableVariations && availableVariations.length
                    ? availableVariations.map((v: any) => v.id).join(", ")
                    : "(none)"}
                </div>
                <div>Disabled colors: {disabledColors.join(", ") || "(none)"}</div>
                <div>Disabled sizes: {disabledSizes.join(", ") || "(none)"}</div>
                <div>Disabled models: {disabledModels.join(", ") || "(none)"}</div>
                <div>
                  Selected: color={selectedColor} size={selectedSize} model=
                  {selectedModel}
                </div>
                <div>CurrentVariationId: {currentVariationId || "(none)"}</div>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="hidden md:block">
        <Main
          category={product.category}
          title={product.title}
          discount={hasStock ? currentDiscount : 0}
        />
      </div>

      <div className="h-[1px] bg-slate-100" />

      <Price price={currentPrice} discountPrice={currentDiscountPrice} hasStock={hasStock} />

      {hasVisibleVariationSelectors && (
        <>
          <div className="h-[1px] bg-slate-100" />

          <div className="flex flex-col gap-7">
            {showSizeGuide && (
              <Size
                sizes={sizes}
                onSizeChange={handleSizeChange}
                selectedSize={selectedSize}
                disabledSizeIds={disabledSizes}
                sizeHelper={productData?.attributes?.product_size_helper?.data}
                showSizeOptions={showSizeSelector}
              />
            )}

            {showColorSelector && (
              <Color
                colors={colors}
                onColorChange={handleColorChange}
                selectedColor={selectedColor}
                disabledColorIds={disabledColors}
              />
            )}

            {models.length > 0 && (
              <Model
                models={models}
                onModelChange={handleModelChange}
                selectedModel={selectedModel}
                disabledModelIds={disabledModels}
              />
            )}

            <GenericAttributes
              selectors={genericSelectors}
              selection={selectedGeneric}
              disabledTermIds={disabledGenericTerms}
              onChange={handleGenericChange}
            />
          </div>
        </>
      )}

      <div className="h-[1px] bg-slate-100" />

      <Action
        productId={productId}
        name={product.title}
        category={product.category}
        price={currentDiscountPrice > 0 ? currentDiscountPrice : currentPrice}
        originalPrice={currentDiscountPrice > 0 ? currentPrice : undefined}
        discountPercentage={currentDiscount > 0 ? currentDiscount : undefined}
        image={productData?.attributes?.CoverImage?.data?.attributes?.url || ""}
        color={selectedColorObj?.title}
        size={selectedSizeObj?.title}
        model={selectedModelObj?.title}
        variationId={currentVariationId}
        productSlug={productData?.attributes?.Slug || productId}
        hasStock={hasStock}
        currentVariation={currentVariation}
      />

      <div className="h-[1px] bg-slate-100" />

      <div className="flex flex-col gap-7">
        <CommentsInfo
          commentCount={productData?.attributes?.RatingCount || 0}
          rateCount={productData?.attributes?.RatingCount || 0}
          last24hoursSeenCount={productData?.attributes?.SeenCount || 0}
          onOpenComments={handleScrollToComments}
        />

        {productData?.attributes?.Description && (
          <FAQItem title="جزئیات محصول" content={productData.attributes.Description} defaultOpen />
        )}

        {productData?.attributes?.CleaningTips && (
          <FAQItem title="توضیحات" content={productData.attributes.CleaningTips} />
        )}

        {productData?.attributes?.ReturnConditions && (
          <FAQItem title="شرایط مرجوع" content={productData.attributes.ReturnConditions} />
        )}
      </div>
    </div>
  );
}
