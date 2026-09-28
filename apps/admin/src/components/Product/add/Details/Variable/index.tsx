import React, { useState, useEffect } from "react";
import type { ProductVariable, ProductVariableDisplay } from "./types";
import { ProductVariableTable } from "./Table";
import { apiClient } from "@/services";
import toast from "react-hot-toast";
import { useCan } from "@/hooks/useCan";
import Modal from "@/components/Kits/Modal";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import { Ruler, Settings } from "lucide-react";
import AsyncSearchPicker from "@/components/Kits/Form/AsyncSearchPicker";
import { renderColorOption } from "../Features/colorOption";
import { searchColors } from "@/services/product/variation-options";
import { apiCache } from "@/lib/api-cache";
import { extractErrorMessage, translateErrorMessage } from "@/lib/errorTranslations";

interface ProductVariablesProps {
  productId: number;
  refreshKey?: number;
  /** Called after an edit or delete that can change the product's colour/size/model set. */
  onVariationsChanged?: () => void;
}

/** The row label: every attribute the variation actually has, in a fixed order. */
function buildVariableName(
  variation: Pick<ProductVariableDisplay, "size" | "color" | "model" | "genericAttributes">,
) {
  // Absent attributes are `undefined` (not ""), so filter on truthiness to
  // avoid stray " - " separators (e.g. a model-only "کد 1" variation).
  return [
    variation.size,
    variation.color,
    variation.model,
    ...(variation.genericAttributes || []).map((item) => `${item.attribute}: ${item.term}`),
  ]
    .filter((part) => Boolean(part && part.trim()))
    .join(" - ");
}

// DEFAULT_TITLES removed - variations should only show actual size/model values, not defaults

const MAX_STOCK = 1000;
type BulkPublishState = "no-change" | "published" | "draft";

const BULK_FORM_DEFAULT = {
  price: "",
  discountPrice: "",
  stock: "",
  publishState: "no-change" as BulkPublishState,
  removeDiscount: false,
};

const ProductVariables: React.FC<ProductVariablesProps> = ({
  productId,
  refreshKey = 0,
  onVariationsChanged,
}) => {
  const canDeleteVariations = useCan("product.variation.delete");

  const [selectedRows, setSelectedRows] = useState<number[]>([]);
  const [variables, setVariables] = useState<ProductVariableDisplay[]>([]);
  const [loading, setLoading] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [currentVariation, setCurrentVariation] = useState<ProductVariableDisplay | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState(BULK_FORM_DEFAULT);
  const [isBulkSaving, setIsBulkSaving] = useState(false);

  const resetBulkForm = () => {
    setBulkForm(BULK_FORM_DEFAULT);
  };

  const closeBulkModal = () => {
    setBulkModalOpen(false);
    resetBulkForm();
  };

  const parseNumberInput = (value: string) => {
    if (value === "") return undefined;
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      return undefined;
    }
    return parsed;
  };

  const closeEditModal = () => {
    setEditModalOpen(false);
    setCurrentVariation(null);
  };

  // Fetch product variations
  useEffect(() => {
    const fetchVariations = async () => {
      if (!productId) return;

      setLoading(true);
      try {
        const response = await apiClient.get(
          `/product-variations?filters[product][id][$eq]=${productId}&populate[0]=product_variation_color&populate[1]=product_variation_size&populate[2]=product_variation_model&populate[3]=product_stock&populate[4]=general_discounts&populate[5]=selected_attribute_terms&populate[6]=selected_attribute_terms.product_attribute&pagination[pageSize]=100`,
          {
            cache: "no-store",
          },
        );

        // Type assertion to work with the data
        const variations = response.data as ProductVariable[];

        // Debug: Log the API response to see what we're getting
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.log("Product variations API response:", variations);
          variations.forEach((variation, index) => {
            // eslint-disable-next-line no-console
            console.log(`Variation ${index}:`, {
              id: variation.id,
              Price: variation.attributes.Price,
              generalDiscounts: variation.attributes.general_discounts?.data,
              attributes: variation.attributes,
            });
          });
        }

        // Transform API data to display format
        const formattedVariations = variations.map((variation: ProductVariable) => {
          // Extract color, size, model details - only use actual values, no defaults
          const color = variation.attributes.product_variation_color?.data?.attributes?.Title;
          const colorCode =
            variation.attributes.product_variation_color?.data?.attributes?.ColorCode;
          const size = variation.attributes.product_variation_size?.data?.attributes?.Title;
          const model = variation.attributes.product_variation_model?.data?.attributes?.Title;
          const genericAttributes = (variation.attributes.selected_attribute_terms?.data || [])
            .map((term) => ({
              attributeId: Number(term.attributes.product_attribute?.data?.id || 0),
              attribute: String(
                term.attributes.product_attribute?.data?.attributes?.Title || "ویژگی",
              ),
              termId: Number(term.id),
              term: String(term.attributes.Title || ""),
            }))
            .filter((item) => item.attributeId && item.term)
            .sort((left, right) => left.attribute.localeCompare(right.attribute));

          // Debug: Log color code extraction
          if (process.env.NODE_ENV !== "production" && color) {
            // eslint-disable-next-line no-console
            console.log(`Color extraction for variation ${variation.id}:`, {
              color,
              colorCode,
              colorData: variation.attributes.product_variation_color?.data,
              fullAttributes: variation.attributes.product_variation_color?.data?.attributes,
            });
          }

          const variableName = buildVariableName({ size, color, model, genericAttributes });

          // Get variation-specific discount price (priority)
          const basePrice = Number(variation.attributes.Price || 0);
          // Prices arrive as strings, and a stored "0" is no discount.
          const storedDiscount = Number(variation.attributes.DiscountPrice || 0);
          let discountPrice: number | undefined = storedDiscount > 0 ? storedDiscount : undefined;

          // If no variation-specific discount, calculate from general_discounts
          const generalDiscounts = variation.attributes.general_discounts?.data || [];
          if (!discountPrice && generalDiscounts.length > 0) {
            // Use the first active discount
            const discount = generalDiscounts[0].attributes;
            if (discount.Type === "Discount") {
              // Percentage discount
              const discountAmount = (basePrice * Number(discount.Amount || 0)) / 100;
              discountPrice = Math.max(0, basePrice - discountAmount);
            } else if (discount.Type === "Cash") {
              // Fixed amount discount
              discountPrice = Math.max(0, basePrice - Number(discount.Amount || 0));
            }
          }

          return {
            id: variation.id,
            sku: variation.attributes.SKU || "",
            price: basePrice,
            discountPrice,
            stock: variation.attributes.product_stock?.data?.attributes.Count || 0,
            stockId: variation.attributes.product_stock?.data?.id,
            variable: variableName,
            isPublished: variation.attributes.IsPublished || false,
            colorId: variation.attributes.product_variation_color?.data?.id,
            sizeId: variation.attributes.product_variation_size?.data?.id,
            modelId: variation.attributes.product_variation_model?.data?.id,
            color: color && color.trim() ? color : undefined,
            colorCode: colorCode ? colorCode : undefined,
            size: size && size.trim() ? size : undefined,
            model: model && model.trim() ? model : undefined,
            genericAttributes,
            generalDiscounts: generalDiscounts,
          };
        });

        // Debug: Log the formatted variations
        if (process.env.NODE_ENV !== "production") {
          // eslint-disable-next-line no-console
          console.log("Formatted variations:", formattedVariations);
          formattedVariations.forEach((variation, index) => {
            // eslint-disable-next-line no-console
            console.log(`Formatted variation ${index}:`, {
              id: variation.id,
              price: variation.price,
              discountPrice: variation.discountPrice,
              variable: variation.variable,
            });
          });
        }

        setVariables(formattedVariations);
      } catch (error) {
        console.error("Error fetching product variations:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchVariations();
  }, [productId, refreshKey]);

  const handleCheckboxChange = (id: number) => {
    setSelectedRows((prev) =>
      prev.includes(id) ? prev.filter((rowId) => rowId !== id) : [...prev, id],
    );
  };

  const handleEditVariation = (id: number) => {
    const variation = variables.find((v) => v.id === id);
    if (variation) {
      setCurrentVariation(variation);
      setEditModalOpen(true);
    }
  };

  const handleDeleteVariation = (id: number) => {
    setDeleteId(id);
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteId) return;

    if (!canDeleteVariations) {
      toast.error("شما مجوز حذف تنوع محصول را ندارید");
      setDeleteConfirmOpen(false);
      setDeleteId(null);
      return;
    }

    try {
      // The backend removes the variation and its dependent stock in one
      // transaction, and blocks deletion while inventory is reserved.
      await apiClient.delete(`/product-variations/${deleteId}`);

      // Update local state and refresh
      setVariables((prev) => prev.filter((v) => v.id !== deleteId));
      setDeleteConfirmOpen(false);
      setDeleteId(null);
      toast.success("تنوع محصول با موفقیت حذف شد");
      onVariationsChanged?.();

      // Trigger a refresh by updating refreshKey if parent component supports it
      // This ensures the list is refreshed after deletion
    } catch (error: any) {
      // Check if the error is about relations (which can happen after successful deletion)
      // If variation was deleted (204), we can ignore relation errors
      if (error?.status === 400 && error?.error?.message?.includes("relation")) {
        // Variation was likely deleted successfully, but a relation cleanup failed
        // This is acceptable - the variation is gone
        setVariables((prev) => prev.filter((v) => v.id !== deleteId));
        setDeleteConfirmOpen(false);
        setDeleteId(null);
        toast.success("تنوع محصول با موفقیت حذف شد");
        onVariationsChanged?.();
        return;
      }

      console.error("Error deleting product variation:", error);
      toast.error("خطا در حذف تنوع محصول");
    }
  };

  const handleBulkUpdate = async () => {
    if (!selectedRows.length) return;

    const priceValue = parseNumberInput(bulkForm.price);
    if (priceValue !== undefined && priceValue <= 0) {
      toast.error("قیمت باید بزرگ‌تر از صفر باشد");
      return;
    }

    const discountInput = parseNumberInput(bulkForm.discountPrice);
    let discountValue: number | null | undefined = undefined;
    if (bulkForm.removeDiscount) {
      discountValue = null;
    } else if (discountInput !== undefined) {
      discountValue = Math.max(0, discountInput);
    }

    const stockInput = parseNumberInput(bulkForm.stock);
    const stockValue =
      stockInput !== undefined ? Math.min(Math.max(stockInput, 0), MAX_STOCK) : undefined;

    const publishValue =
      bulkForm.publishState === "no-change" ? undefined : bulkForm.publishState === "published";

    if (!isValidAction(priceValue, discountValue, stockValue, publishValue)) {
      toast.error("هیچ تغییری برای اعمال انتخاب نشده است");
      return;
    }

    setIsBulkSaving(true);
    const stockIdUpdates: Record<number, number | undefined> = {};
    // Per row, which writes actually landed. The screen used to show the new
    // values on every selected row even when a save had failed.
    const savedWrites = new Map<number, { variation: boolean; stock: boolean }>();
    const failedIds: number[] = [];
    const failureLines: string[] = [];

    try {
      for (const variationId of selectedRows) {
        const variation = variables.find((v) => v.id === variationId);
        if (!variation) continue;

        const saved = { variation: false, stock: false };
        try {
          const updatePayload: Record<string, unknown> = {};
          if (priceValue !== undefined) updatePayload.Price = priceValue;
          if (discountValue !== undefined) updatePayload.DiscountPrice = discountValue;
          if (publishValue !== undefined) updatePayload.IsPublished = publishValue;

          if (Object.keys(updatePayload).length > 0) {
            await apiClient.put(`/product-variations/${variationId}`, {
              data: updatePayload,
            });
            saved.variation = true;
          }

          if (stockValue !== undefined) {
            if (variation.stockId) {
              await apiClient.put(`/product-stocks/${variation.stockId}`, {
                data: {
                  Count: stockValue,
                },
              });
            } else {
              const stockResponse = await apiClient.post("/product-stocks", {
                data: {
                  Count: stockValue,
                  product_variation: variationId,
                },
              });
              const stockData = stockResponse.data as { id: number };
              stockIdUpdates[variationId] = stockData.id;
            }
            saved.stock = true;
          }
        } catch (error: any) {
          console.error(`Error updating variation ${variationId}:`, error);
          failedIds.push(variationId);
          failureLines.push(
            `${variation.variable || `#${variationId}`}: ${error?.message || "خطای نامشخص"}`,
          );
        }
        savedWrites.set(variationId, saved);
      }

      setVariables((prev) =>
        prev.map((variation) => {
          const saved = savedWrites.get(variation.id);
          if (!saved) return variation;

          return {
            ...variation,
            ...(saved.variation
              ? {
                  price: priceValue !== undefined ? priceValue : variation.price,
                  discountPrice:
                    discountValue === undefined
                      ? variation.discountPrice
                      : discountValue === null || discountValue <= 0
                        ? undefined
                        : discountValue,
                  isPublished: publishValue !== undefined ? publishValue : variation.isPublished,
                }
              : {}),
            ...(saved.stock
              ? {
                  stock: stockValue !== undefined ? stockValue : variation.stock,
                  stockId:
                    stockIdUpdates[variation.id] !== undefined
                      ? stockIdUpdates[variation.id]
                      : variation.stockId,
                }
              : {}),
          };
        }),
      );

      const updatedCount = savedWrites.size - failedIds.length;
      if (failedIds.length === 0) {
        toast.success(`تغییرات روی ${updatedCount} تنوع اعمال شد`);
        setSelectedRows([]);
        closeBulkModal();
      } else {
        if (updatedCount > 0) {
          toast.success(`تغییرات روی ${updatedCount} از ${savedWrites.size} تنوع اعمال شد`);
        }
        toast.error(`این تنوع‌ها ذخیره نشدند:\n${failureLines.join("\n")}`, {
          duration: 10000,
          style: { whiteSpace: "pre-line" },
        });
        // Leave just the failed rows selected so a retry is one click.
        setSelectedRows(failedIds);
      }
    } finally {
      setIsBulkSaving(false);
    }
  };

  const confirmBulkDelete = async () => {
    if (!selectedRows.length) return;

    if (!canDeleteVariations) {
      toast.error("شما مجوز حذف تنوع محصول را ندارید");
      setBulkDeleteConfirmOpen(false);
      return;
    }

    setIsBulkDeleting(true);
    const deletedIds: number[] = [];
    const reservedStockLabels: string[] = [];
    let otherFailureCount = 0;

    try {
      for (const variationId of selectedRows) {
        try {
          // Same transactional delete as the single-row action: removes the
          // linked stock row too, and blocks while inventory is reserved.
          await apiClient.delete(`/product-variations/${variationId}`);
          deletedIds.push(variationId);
        } catch (error: any) {
          // A relation-cleanup 400 after a successful delete is the same
          // acceptable quirk confirmDelete() tolerates for single deletes.
          if (error?.status === 400 && error?.error?.message?.includes("relation")) {
            deletedIds.push(variationId);
            continue;
          }

          if (error?.status === 409) {
            const variation = variables.find((v) => v.id === variationId);
            reservedStockLabels.push(variation?.variable || `#${variationId}`);
          } else {
            otherFailureCount++;
          }
          console.error(`Error deleting variation ${variationId}:`, error);
        }
      }

      if (deletedIds.length > 0) {
        setVariables((prev) => prev.filter((v) => !deletedIds.includes(v.id)));
        setSelectedRows((prev) => prev.filter((id) => !deletedIds.includes(id)));
        onVariationsChanged?.();
      }

      const failedCount = reservedStockLabels.length + otherFailureCount;

      if (failedCount === 0) {
        toast.success(`${deletedIds.length} تنوع محصول با موفقیت حذف شد`);
        setBulkDeleteConfirmOpen(false);
      } else if (deletedIds.length > 0) {
        const reasonParts: string[] = [];
        if (reservedStockLabels.length > 0) {
          reasonParts.push(
            `${reservedStockLabels.length} مورد به دلیل موجودی رزرو شده حذف نشد: ${reservedStockLabels.join("، ")}`,
          );
        }
        if (otherFailureCount > 0) {
          reasonParts.push(`${otherFailureCount} مورد با خطا مواجه شد`);
        }
        toast.error(`${deletedIds.length} مورد حذف شد؛ ${reasonParts.join(" و ")}`);
        setBulkDeleteConfirmOpen(false);
      } else {
        toast.error(
          reservedStockLabels.length > 0
            ? `هیچ موردی حذف نشد؛ همه به دلیل موجودی رزرو شده حذف نشدند: ${reservedStockLabels.join("، ")}`
            : "حذف گروهی با خطا مواجه شد",
        );
      }
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const isValidAction = (
    priceValue: number | undefined,
    discountValue: number | null | undefined,
    stockValue: number | undefined,
    publishValue: boolean | undefined,
  ): boolean => {
    if (
      priceValue === undefined &&
      discountValue === undefined &&
      stockValue === undefined &&
      publishValue === undefined
    ) {
      return false;
    }
    return true;
  };

  const handleSaveVariation = async (updatedVariation: ProductVariableDisplay) => {
    try {
      if (updatedVariation.stock > MAX_STOCK) {
        toast.error(`موجودی هر تنوع نمی‌تواند بیشتر از ${MAX_STOCK.toLocaleString()} باشد.`);
        return;
      }
      if (updatedVariation.stock < 0) {
        toast.error("موجودی نمی‌تواند مقدار منفی باشد.");
        return;
      }

      const original = variables.find((v) => v.id === updatedVariation.id);
      const colorChanged =
        Boolean(updatedVariation.colorId) && updatedVariation.colorId !== original?.colorId;

      // Update variation data. The colour goes only when it changed: the backend
      // refuses a combination another variation of this product already has.
      await apiClient.put(`/product-variations/${updatedVariation.id}`, {
        data: {
          SKU: updatedVariation.sku,
          Price: updatedVariation.price,
          DiscountPrice: updatedVariation.discountPrice || null,
          IsPublished: updatedVariation.isPublished,
          ...(colorChanged ? { product_variation_color: updatedVariation.colorId } : {}),
        },
      });

      // Update stock if it exists, or create new stock
      if (updatedVariation.stockId) {
        await apiClient.put(`/product-stocks/${updatedVariation.stockId}`, {
          data: {
            Count: Math.min(Math.max(updatedVariation.stock, 0), MAX_STOCK),
          },
        });
      } else {
        // Create new stock and link to variation
        const stockResponse = await apiClient.post("/product-stocks", {
          data: {
            Count: Math.min(Math.max(updatedVariation.stock, 0), MAX_STOCK),
            product_variation: updatedVariation.id,
          },
        });

        // Update stockId in local state
        const stockData = stockResponse.data as { id: number };
        updatedVariation.stockId = stockData.id;
      }

      // Update local state
      const saved = { ...updatedVariation, variable: buildVariableName(updatedVariation) };
      setVariables((prev) => prev.map((v) => (v.id === saved.id ? saved : v)));

      setEditModalOpen(false);
      setCurrentVariation(null);
      toast.success("تنوع محصول با موفقیت به‌روزرسانی شد");
      if (colorChanged) {
        apiCache.clearByPattern(/product-variation/i);
        onVariationsChanged?.();
      }
    } catch (error) {
      console.error("Error updating product variation:", error);
      toast.error(
        translateErrorMessage(extractErrorMessage(error), "ذخیره تنوع محصول با خطا مواجه شد"),
      );
    }
  };

  const handleSelectAll = () => {
    setSelectedRows(variables.map((v) => v.id));
  };

  return (
    <div className="w-full p-5 pt-0" dir="rtl">
      <h2 className="mb-4 text-base text-neutral-400">متغیر های محصول</h2>

      {variables.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-100 bg-white p-4 text-sm text-slate-600">
          <div>
            {selectedRows.length > 0
              ? `${selectedRows.length} تنوع انتخاب شده`
              : "هیچ تنوعی انتخاب نشده است"}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                if (selectedRows.length === variables.length && variables.length > 0) {
                  setSelectedRows([]);
                } else {
                  handleSelectAll();
                }
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-60"
              disabled={variables.length === 0}
            >
              {selectedRows.length === variables.length && variables.length > 0
                ? "برداشتن انتخاب"
                : "انتخاب همه"}
            </button>
            <button
              onClick={() => setBulkModalOpen(true)}
              disabled={selectedRows.length === 0}
              className="rounded-lg bg-infinity-primary px-4 py-2 text-white transition-colors hover:bg-infinity-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              ویرایش گروهی
            </button>
            {canDeleteVariations && (
              <button
                onClick={() => setBulkDeleteConfirmOpen(true)}
                disabled={selectedRows.length === 0}
                className="rounded-lg bg-red-600 px-4 py-2 text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                حذف گروهی
              </button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center">در حال بارگذاری...</div>
      ) : variables.length === 0 ? (
        <div className="rounded-lg border border-slate-100 p-8 text-center">
          <p className="text-slate-500">هیچ متغیری برای این محصول تعریف نشده است.</p>
          <p className="mt-2 text-sm text-slate-400">
            ابتدا ویژگی‌های محصول را تعریف کنید و سپس تنوع‌های محصول را ایجاد کنید.
          </p>
        </div>
      ) : (
        <ProductVariableTable
          variables={variables}
          selectedRows={selectedRows}
          onSelectRow={handleCheckboxChange}
          onEditRow={handleEditVariation}
          onDeleteRow={canDeleteVariations ? handleDeleteVariation : undefined}
          editingVariationId={currentVariation?.id}
        />
      )}

      <Modal
        isOpen={editModalOpen && !!currentVariation}
        onClose={closeEditModal}
        title="ویرایش متغیر محصول"
      >
        {currentVariation && (
          <>
            {/* Variation Indicator */}
            <div className="mb-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="mb-3 text-sm font-medium text-slate-700">تنوع در حال ویرایش:</div>
              <div className="flex flex-wrap items-center gap-2">
                {currentVariation.color && currentVariation.color.trim() && (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <span
                      className="h-5 w-5 rounded-full border border-slate-200"
                      style={{ backgroundColor: currentVariation.colorCode || "#f5f5f5" }}
                      aria-label={`کد رنگ ${currentVariation.colorCode || "نامشخص"}`}
                    />
                    <span className="text-sm font-medium text-slate-700">
                      {currentVariation.color}
                    </span>
                  </div>
                )}
                {currentVariation.size && currentVariation.size.trim() && (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <Ruler className="h-5 w-5 text-slate-500" />
                    <span className="text-sm font-medium text-slate-700">
                      سایز: {currentVariation.size}
                    </span>
                  </div>
                )}
                {currentVariation.model && currentVariation.model.trim() && (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <Settings className="h-5 w-5 text-slate-500" />
                    <span className="text-sm font-medium text-slate-700">
                      مدل: {currentVariation.model}
                    </span>
                  </div>
                )}
                {(!currentVariation.color || !currentVariation.color.trim()) &&
                  (!currentVariation.size || !currentVariation.size.trim()) &&
                  (!currentVariation.model || !currentVariation.model.trim()) && (
                    <span className="text-sm text-slate-500">بدون ویژگی خاص</span>
                  )}
              </div>
            </div>

            <div className="space-y-4">
              {currentVariation.colorId && (
                <div>
                  <label className="mb-1 block text-sm">رنگ این تنوع</label>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <span
                        className="h-5 w-5 rounded-full border border-slate-200"
                        style={{ backgroundColor: currentVariation.colorCode || "#f5f5f5" }}
                        aria-hidden="true"
                      />
                      <span className="text-sm text-slate-700">{currentVariation.color}</span>
                    </div>
                    <div className="min-w-[14rem] flex-1">
                      <AsyncSearchPicker
                        placeholder="تغییر به رنگ دیگر..."
                        search={searchColors}
                        selectedIds={new Set([String(currentVariation.colorId)])}
                        onPick={(option) =>
                          setCurrentVariation({
                            ...currentVariation,
                            colorId: Number(option.id),
                            color: option.title,
                            colorCode: option.colorCode,
                          })
                        }
                        renderOption={(option, isSelected) =>
                          renderColorOption(option, isSelected, "رنگ فعلی")
                        }
                      />
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    فقط رنگ همین تنوع عوض می‌شود. برای تغییر رنگ همه‌ی تنوع‌های یک رنگ، از دکمه
                    «تغییر رنگ» در جدول ویژگی‌ها استفاده کنید.
                  </p>
                </div>
              )}

              <div>
                <label className="mb-1 block text-sm">کد محصول (SKU)</label>
                <input
                  type="text"
                  value={currentVariation.sku}
                  onChange={(e) =>
                    setCurrentVariation({
                      ...currentVariation,
                      sku: e.target.value,
                    })
                  }
                  className="w-full rounded-lg border border-slate-300 p-2"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm">قیمت اصلی (تومان)</label>
                <input
                  type="number"
                  value={currentVariation.price}
                  onChange={(e) =>
                    setCurrentVariation({
                      ...currentVariation,
                      price: Number(e.target.value),
                    })
                  }
                  className="w-full rounded-lg border border-slate-300 p-2"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm">تخفیف اختصاصی این متغیر (تومان)</label>
                <input
                  type="number"
                  value={currentVariation.discountPrice || ""}
                  onChange={(e) =>
                    setCurrentVariation({
                      ...currentVariation,
                      discountPrice: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                  placeholder="خالی بگذارید برای عدم تخفیف"
                  className="w-full rounded-lg border border-slate-300 p-2"
                />
                <div className="mt-1 text-xs text-slate-500">
                  تخفیف مخصوص این متغیر - مستقل از تخفیف‌های عمومی
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm">تخفیف‌های عمومی</label>
                <div className="min-h-[40px] rounded-lg border border-slate-300 bg-slate-50 p-2">
                  {currentVariation.generalDiscounts &&
                  currentVariation.generalDiscounts.length > 0 ? (
                    currentVariation.generalDiscounts.map((discount, index: number) => (
                      <div key={index} className="text-sm text-slate-600">
                        {discount.attributes.Type === "Discount"
                          ? `${discount.attributes.Amount}% تخفیف`
                          : `${Number(discount.attributes.Amount).toLocaleString()} تومان تخفیف`}
                      </div>
                    ))
                  ) : (
                    <div className="text-sm text-slate-400">هیچ تخفیف فعالی تعریف نشده</div>
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  برای مدیریت تخفیف‌ها از بخش &quot;تخفیف‌های عمومی&quot; استفاده کنید
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm">موجودی</label>
                <input
                  type="number"
                  value={currentVariation.stock}
                  onChange={(e) =>
                    setCurrentVariation({
                      ...currentVariation,
                      stock: Math.min(Math.max(Number(e.target.value), 0), MAX_STOCK),
                    })
                  }
                  max={MAX_STOCK}
                  min={0}
                  className="w-full rounded-lg border border-slate-300 p-2"
                />
                <p className="mt-1 text-xs text-slate-500">
                  حداکثر موجودی قابل ثبت برای هر تنوع {MAX_STOCK.toLocaleString()} عدد است.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-sm">وضعیت انتشار</label>
                <div className="flex items-center gap-6">
                  <label className="inline-flex items-center">
                    <input
                      type="radio"
                      checked={currentVariation.isPublished}
                      onChange={() =>
                        setCurrentVariation({
                          ...currentVariation,
                          isPublished: true,
                        })
                      }
                      className="h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="mr-2 text-sm text-gray-700">منتشر شده</span>
                  </label>
                  <label className="inline-flex items-center">
                    <input
                      type="radio"
                      checked={!currentVariation.isPublished}
                      onChange={() =>
                        setCurrentVariation({
                          ...currentVariation,
                          isPublished: false,
                        })
                      }
                      className="h-4 w-4 border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="mr-2 text-sm text-gray-700">پیش نویس</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={closeEditModal}
                className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700"
              >
                انصراف
              </button>
              <button
                onClick={() => currentVariation && handleSaveVariation(currentVariation)}
                className="rounded-lg bg-blue-600 px-4 py-2 text-white"
              >
                ذخیره تغییرات
              </button>
            </div>
          </>
        )}
      </Modal>

      <Modal isOpen={bulkModalOpen} onClose={closeBulkModal} title="ویرایش گروهی تنوع‌ها">
        <p className="mb-4 text-sm text-slate-500">
          تغییرات زیر برای {selectedRows.length} تنوع انتخاب شده اعمال می‌شود. فیلدهایی که خالی
          بمانند بدون تغییر خواهند ماند.
        </p>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm">قیمت جدید (تومان)</label>
            <input
              type="number"
              value={bulkForm.price}
              onChange={(e) => setBulkForm((prev) => ({ ...prev, price: e.target.value }))}
              placeholder="بدون تغییر"
              className="w-full rounded-lg border border-slate-300 p-2"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm">تخفیف اختصاصی (تومان)</label>
            <input
              type="number"
              value={bulkForm.discountPrice}
              onChange={(e) => setBulkForm((prev) => ({ ...prev, discountPrice: e.target.value }))}
              disabled={bulkForm.removeDiscount}
              placeholder="بدون تغییر"
              className="w-full rounded-lg border border-slate-300 p-2 disabled:bg-slate-100"
            />
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={bulkForm.removeDiscount}
                onChange={(e) =>
                  setBulkForm((prev) => ({
                    ...prev,
                    removeDiscount: e.target.checked,
                    discountPrice: e.target.checked ? "" : prev.discountPrice,
                  }))
                }
              />
              حذف تخفیف اختصاصی از همه تنوع‌ها
            </label>
          </div>

          <div>
            <label className="mb-1 block text-sm">موجودی</label>
            <input
              type="number"
              value={bulkForm.stock}
              onChange={(e) => setBulkForm((prev) => ({ ...prev, stock: e.target.value }))}
              placeholder="بدون تغییر"
              className="w-full rounded-lg border border-slate-300 p-2"
            />
            <p className="mt-1 text-xs text-slate-500">
              حداکثر موجودی قابل ثبت {MAX_STOCK.toLocaleString()} عدد است.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm">وضعیت انتشار</label>
            <select
              value={bulkForm.publishState}
              onChange={(e) =>
                setBulkForm((prev) => ({
                  ...prev,
                  publishState: e.target.value as BulkPublishState,
                }))
              }
              className="w-full rounded-lg border border-slate-300 p-2"
            >
              <option value="no-change">بدون تغییر</option>
              <option value="published">منتشر شود</option>
              <option value="draft">به حالت پیش نویس درآید</option>
            </select>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={closeBulkModal}
            className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700"
            disabled={isBulkSaving}
          >
            انصراف
          </button>
          <button
            onClick={handleBulkUpdate}
            className="rounded-lg bg-infinity-primary-light px-4 py-2 text-white disabled:border-infinity-primary-lighter/60 disabled:bg-infinity-primary-lighter/30"
            disabled={isBulkSaving}
          >
            {isBulkSaving ? "در حال اعمال..." : "ثبت تغییرات"}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={deleteConfirmOpen}
        title="حذف متغیر محصول"
        description="آیا از حذف این متغیر محصول اطمینان دارید؟ این عمل قابل بازگشت نیست."
        confirmText="حذف"
        cancelText="انصراف"
        onConfirm={confirmDelete}
        onCancel={() => {
          setDeleteConfirmOpen(false);
          setDeleteId(null);
        }}
      />

      <ConfirmDialog
        isOpen={bulkDeleteConfirmOpen}
        title={`حذف ${selectedRows.length} تنوع محصول`}
        description="آیا از حذف تنوع‌های انتخاب شده اطمینان دارید؟ این عمل قابل بازگشت نیست. تنوع‌هایی که موجودی رزرو شده دارند حذف نخواهند شد."
        confirmText={isBulkDeleting ? "در حال حذف..." : "حذف"}
        cancelText="انصراف"
        variant="danger"
        confirmDisabled={isBulkDeleting}
        onConfirm={confirmBulkDelete}
        onCancel={() => setBulkDeleteConfirmOpen(false)}
      />
    </div>
  );
};

export default ProductVariables;
