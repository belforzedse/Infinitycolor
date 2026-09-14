"use client";

import { useMemo } from "react";
import ProductSearch, { type Product } from "@/components/SuperAdmin/Order/ProductSearch";
import { Button } from "@/components/ui/Button";
import Image from "next/image";
import resolveAssetUrl from "@/utils/resolveAssetUrl";

export type ProductSummary = {
  id: number;
  title: string;
  image?: string;
};

interface HomepageProductPickerProps {
  title: string;
  selectedProductIds: number[];
  productSummaries: ProductSummary[];
  onProductsChange: (ids: number[]) => void;
  onProductAdded?: (product: ProductSummary) => void;
  maxProducts?: number;
  /**
   * Position after which the storefront stops rendering. Display only — it marks the
   * overflow rows instead of blocking them, because the backend silently slices the
   * list and the picker's job is to say so. Distinct from `maxProducts`, which
   * prevents adds and hides the search box entirely once reached.
   */
  renderLimit?: number;
}

type OrderItem = {
  id: number;
  productId: number;
  productName: string;
  productCode: string;
  price: number;
  quantity: number;
};

function getImageUrl(product: Product): string | undefined {
  if (product.image) return product.image;
  const img = product.CoverImage as any;
  if (!img) return undefined;
  const attrs = img?.data?.attributes ?? img;
  const thumb = attrs?.formats?.thumbnail?.url ?? attrs?.formats?.small?.url;
  const url = thumb ?? attrs?.url ?? img?.url;
  return url ? resolveAssetUrl(url) || undefined : undefined;
}

export default function HomepageProductPicker({
  title,
  selectedProductIds,
  productSummaries,
  onProductsChange,
  onProductAdded,
  maxProducts,
  renderLimit,
}: HomepageProductPickerProps) {
  const summaryMap = useMemo(() => {
    const m = new Map<number, ProductSummary>();
    productSummaries.forEach((s) => m.set(s.id, s));
    return m;
  }, [productSummaries]);

  const selectedItems = useMemo<OrderItem[]>(() => {
    return selectedProductIds.map((id, index) => ({
      id: index,
      productId: id,
      productName: summaryMap.get(id)?.title ?? `محصول #${id}`,
      productCode: "",
      price: 0,
      quantity: 0,
    }));
  }, [selectedProductIds, summaryMap]);

  const handleProductSelect = (product: Product) => {
    if (selectedProductIds.includes(product.id)) return;
    if (maxProducts && selectedProductIds.length >= maxProducts) return;
    onProductsChange([...selectedProductIds, product.id]);
    onProductAdded?.({
      id: product.id,
      title: product.Title,
      image: getImageUrl(product),
    });
  };

  const handleRemove = (productId: number) => {
    onProductsChange(selectedProductIds.filter((id) => id !== productId));
  };

  const moveUp = (index: number) => {
    if (index <= 0) return;
    const next = [...selectedProductIds];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    onProductsChange(next);
  };

  const moveDown = (index: number) => {
    if (index >= selectedProductIds.length - 1) return;
    const next = [...selectedProductIds];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    onProductsChange(next);
  };

  const hiddenCount =
    renderLimit && selectedProductIds.length > renderLimit
      ? selectedProductIds.length - renderLimit
      : 0;

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-neutral-800">{title}</h3>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">
          {selectedProductIds.length}
          {maxProducts ? ` / ${maxProducts}` : ""} محصول
          {hiddenCount > 0 ? ` — ${renderLimit} تا نمایش داده می‌شود` : ""}
        </span>
      </div>

      {maxProducts && selectedProductIds.length >= maxProducts ? (
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-sm text-amber-700">
          حداکثر {maxProducts} محصول انتخاب شده است.
        </div>
      ) : (
        <ProductSearch
          onProductSelect={handleProductSelect}
          selectedItems={selectedItems}
          enableVariationSelection={false}
        />
      )}

      {hiddenCount > 0 ? (
        <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-3 text-sm text-amber-700">
          {hiddenCount} محصول پس از جایگاه {renderLimit} ذخیره شده ولی در سایت نمایش داده
          نمی‌شود. برای نمایش، آن‌ها را بالاتر بیاورید.
        </div>
      ) : null}

      {selectedProductIds.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium text-neutral-700">ترتیب نمایش (قابل تغییر)</p>
          <ul className="space-y-2">
            {selectedProductIds.map((id, index) => {
              const summary = summaryMap.get(id);
              const displayTitle = summary?.title ?? `محصول #${id}`;
              const imageUrl = summary?.image;
              const notRendered = Boolean(renderLimit && index >= renderLimit);
              return (
                <li
                  key={id}
                  data-testid={notRendered ? "picker-row-not-rendered" : "picker-row"}
                  className={`flex items-center gap-3 rounded-lg border p-2 ${
                    notRendered
                      ? "border-dashed border-amber-200 bg-amber-50/40 opacity-60"
                      : "border-neutral-100 bg-neutral-50/50"
                  }`}
                >
                  <div className="flex flex-shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => moveUp(index)}
                      disabled={index === 0}
                      aria-label="بالا"
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => moveDown(index)}
                      disabled={index === selectedProductIds.length - 1}
                      aria-label="پایین"
                    >
                      ↓
                    </Button>
                  </div>
                  {imageUrl ? (
                    <div className="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-neutral-200">
                      <Image
                        src={imageUrl}
                        alt=""
                        fill
                        className="object-cover"
                        sizes="40px"
                      />
                    </div>
                  ) : (
                    <div className="h-10 w-10 flex-shrink-0 rounded bg-neutral-200" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
                    {displayTitle}
                  </span>
                  {notRendered ? (
                    <span className="flex-shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">
                      نمایش داده نمی‌شود
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-red-600 hover:bg-red-50 hover:text-red-700"
                    onClick={() => handleRemove(id)}
                  >
                    حذف
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
