"use client";

import { useState } from "react";
import toast from "react-hot-toast";
import { HexColorInput, HexColorPicker } from "react-colorful";
import Modal from "@/components/Kits/Modal";
import AsyncSearchPicker from "@/components/Kits/Form/AsyncSearchPicker";
import { useCan } from "@/hooks/useCan";
import { apiCache } from "@/lib/api-cache";
import { extractErrorMessage, translateErrorMessage } from "@/lib/errorTranslations";
import { searchColors, type VariationOption } from "@/services/product/variation-options";
import {
  replaceProductColor,
  type ColorReplaceResult,
  type ColorReplaceTarget,
} from "@/services/product/variation-color-replace";
import { useProductEditor } from "@/hooks/product/ProductEditorContext";
import ProductEditorFields from "@/components/Product/add/ProductEditorFields";
import {
  DEFAULT_COLOR_CODE,
  resolveColorSave,
} from "@/app/(admin)/products/colors/colorForm";
import { renderColorOption } from "./colorOption";

export type ReplaceableColor = {
  id: string;
  value: string;
  colorCode?: string;
};

type ReplaceColorDialogProps = {
  productId: number;
  /** The colour being replaced; null keeps the dialog closed. */
  color: ReplaceableColor | null;
  onClose: () => void;
  onReplaced: () => void | Promise<void>;
};

type Mode = "existing" | "new";

/**
 * Fixes a wrongly chosen colour on one product.
 *
 * Colours are shared rows, so this never edits the colour itself: it moves this
 * product's variations onto another colour (an existing one, or a new one with
 * the right hex) and keeps their price, stock and publication. Nothing needs to
 * be regenerated. Every change is previewed with a dry run first, so the
 * operator sees exactly which variations move and what, if anything, is removed.
 */
export default function ReplaceColorDialog({
  productId,
  color,
  onClose,
  onReplaced,
}: ReplaceColorDialogProps) {
  // Remount per colour so every opening starts from a clean form.
  return (
    <Modal
      isOpen={Boolean(color)}
      onClose={onClose}
      title={color ? `تغییر رنگ «${color.value}» در این محصول` : ""}
      className="max-w-lg"
    >
      <ProductEditorFields>{color && (
        <ReplaceColorForm
          key={color.id}
          productId={productId}
          color={color}
          onClose={onClose}
          onReplaced={onReplaced}
        />
      )}</ProductEditorFields>
    </Modal>
  );
}

function ReplaceColorForm({
  productId,
  color,
  onClose,
  onReplaced,
}: {
  productId: number;
  color: ReplaceableColor;
  onClose: () => void;
  onReplaced: () => void | Promise<void>;
}) {
  const { client, canEdit } = useProductEditor();
  const canDeleteVariations = useCan("product.variation.delete");
  const [mode, setMode] = useState<Mode>("existing");
  const [picked, setPicked] = useState<VariationOption | null>(null);
  const [newColor, setNewColor] = useState({
    title: color.value,
    colorCode: color.colorCode || DEFAULT_COLOR_CODE,
    noColor: !color.colorCode,
  });
  const [preview, setPreview] = useState<ColorReplaceResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const fromColorId = Number(color.id);
  const selectedIds = new Set([color.id]);

  const resetPreview = () => {
    setPreview(null);
    setPreviewError(null);
  };

  const resolveTarget = (): ColorReplaceTarget | null => {
    if (mode === "existing") {
      return picked ? { toColorId: Number(picked.id) } : null;
    }
    const resolved = resolveColorSave(newColor);
    if (!resolved.ok) {
      setPreviewError(resolved.message);
      return null;
    }
    return { newColor: { title: resolved.title, colorCode: resolved.colorCode } };
  };

  const runPreview = async (target: ColorReplaceTarget | null) => {
    if (!target) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      setPreview(await replaceProductColor(productId, fromColorId, target, { dryRun: true }, client));
    } catch (error) {
      setPreview(null);
      setPreviewError(
        translateErrorMessage(extractErrorMessage(error), "بررسی تغییر رنگ با خطا مواجه شد"),
      );
    } finally {
      setPreviewing(false);
    }
  };

  const handlePick = (option: VariationOption) => {
    setPicked(option);
    void runPreview({ toColorId: Number(option.id) });
  };

  const handleApply = async () => {
    const target = resolveTarget();
    if (!target || !preview || !canEdit) return;
    setApplying(true);
    try {
      const result = await replaceProductColor(productId, fromColorId, target, {
        removeEmptyDrafts: preview.emptyDrafts.length > 0,
      }, client);
      // The pickers and the variation list read through the admin cache.
      apiCache.clearByPattern(/product-variation/i);
      toast.success(
        `رنگ «${color.value}» در ${result.moving.length} تنوع با «${result.targetColor.title}» جایگزین شد`,
      );
      await onReplaced();
      onClose();
    } catch (error) {
      toast.error(
        translateErrorMessage(extractErrorMessage(error), "تغییر رنگ با خطا مواجه شد"),
      );
      // The product may have changed underneath the preview; show the new state.
      void runPreview(target);
    } finally {
      setApplying(false);
    }
  };

  const blocked = Boolean(preview && preview.blocking.length > 0);
  const draftsNeedDelete = Boolean(
    preview && preview.emptyDrafts.length > 0 && !canDeleteVariations,
  );
  const canApply = canEdit && Boolean(preview) && !blocked && !draftsNeedDelete && !previewing && !applying;

  return (
    <div className="space-y-5 text-sm" dir="rtl">
      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <Swatch colorCode={color.colorCode} />
        <div className="min-w-0">
          <p className="font-medium text-slate-700">{color.value}</p>
          <p className="text-xs text-slate-500" dir="ltr">
            {color.colorCode ? color.colorCode.toUpperCase() : "بدون کد رنگ"}
          </p>
        </div>
      </div>
      <p className="text-xs leading-6 text-slate-500">
        فقط تنوع‌های همین محصول به رنگ جدید منتقل می‌شوند. قیمت، موجودی و وضعیت انتشار آن‌ها
        تغییری نمی‌کند و نیازی به ساخت دوباره‌ی تنوع‌ها نیست. محصولات دیگر و سفارش‌های قبلی
        دست نمی‌خورند.
      </p>

      <div className="flex gap-2" role="tablist">
        {(
          [
            ["existing", "انتخاب از رنگ‌های موجود"],
            ["new", "رنگ جدید با کد دیگر"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => {
              setMode(value);
              resetPreview();
            }}
            className={`rounded-lg border px-3 py-1.5 text-xs transition ${
              mode === value
                ? "border-blue-500 bg-blue-50 text-blue-700"
                : "border-slate-200 text-slate-600 hover:border-slate-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "existing" ? (
        <div className="space-y-3">
          <AsyncSearchPicker
            placeholder="جستجوی نام یا کد رنگ..."
            search={searchColors}
            selectedIds={selectedIds}
            onPick={handlePick}
            renderOption={(option, isSelected) =>
              renderColorOption(option, isSelected, "رنگ فعلی")
            }
          />
          {picked && (
            <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50/50 p-3">
              <Swatch colorCode={picked.colorCode} />
              <div>
                <p className="font-medium text-slate-700">{picked.title}</p>
                <p className="text-xs text-slate-500" dir="ltr">
                  {picked.colorCode ? picked.colorCode.toUpperCase() : "بدون کد رنگ"}
                </p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-600" htmlFor="replace-color-title">
              نام رنگ
            </label>
            <input
              id="replace-color-title"
              type="text"
              value={newColor.title}
              onChange={(e) => {
                setNewColor((prev) => ({ ...prev, title: e.target.value }));
                resetPreview();
              }}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={newColor.noColor}
              onChange={(e) => {
                const noColor = e.target.checked;
                setNewColor((prev) => ({
                  ...prev,
                  noColor,
                  colorCode: noColor ? prev.colorCode : prev.colorCode || DEFAULT_COLOR_CODE,
                }));
                resetPreview();
              }}
            />
            بدون رنگ
          </label>
          {!newColor.noColor && (
            <div className="flex flex-col gap-3 sm:flex-row">
              <HexColorPicker
                color={newColor.colorCode}
                onChange={(value) => {
                  setNewColor((prev) => ({ ...prev, colorCode: value.toLowerCase() }));
                  resetPreview();
                }}
              />
              <div className="flex-1 space-y-2">
                <span className="text-xs text-slate-500">کد HEX</span>
                <HexColorInput
                  prefixed
                  color={newColor.colorCode}
                  onChange={(value) => {
                    setNewColor((prev) => ({ ...prev, colorCode: value.toLowerCase() }));
                    resetPreview();
                  }}
                  aria-label="کد رنگ"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 uppercase focus:border-blue-500 focus:outline-none"
                />
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Swatch colorCode={color.colorCode} />
                  <span>←</span>
                  <Swatch colorCode={newColor.colorCode} />
                </div>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => void runPreview(resolveTarget())}
            disabled={previewing}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {previewing ? "در حال بررسی..." : "بررسی تغییر"}
          </button>
        </div>
      )}

      {previewing && mode === "existing" && (
        <p className="text-xs text-slate-500">در حال بررسی...</p>
      )}
      {previewError && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert">
          {previewError}
        </p>
      )}
      {preview && <PreviewSummary preview={preview} mode={mode} />}
      {draftsNeedDelete && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert">
          برای ادامه باید تنوع‌های پیش‌نویس بالا حذف شوند و شما مجوز حذف تنوع را ندارید.
        </p>
      )}

      <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-slate-300 px-4 py-2 text-slate-700"
        >
          انصراف
        </button>
        <button
          type="button"
          onClick={() => void handleApply()}
          disabled={!canApply}
          className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {applying ? "در حال اعمال..." : "اعمال روی این محصول"}
        </button>
      </div>
    </div>
  );
}

function PreviewSummary({ preview, mode }: { preview: ColorReplaceResult; mode: Mode }) {
  const target = preview.targetColor;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
        <p className="mb-2">
          {preview.moving.length} تنوع به رنگ «{target.title}» منتقل می‌شود:
        </p>
        <VariationChips items={preview.moving} />
        {mode === "new" && (
          <p className="mt-2">
            {target.created
              ? `رنگ «${target.title}» به فهرست رنگ‌ها افزوده می‌شود.`
              : "رنگی با همین نام و کد از قبل وجود دارد و همان استفاده می‌شود."}
          </p>
        )}
      </div>

      {preview.emptyDrafts.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <p className="mb-2">
            این محصول از قبل {preview.emptyDrafts.length} تنوع پیش‌نویسِ خالی (بدون قیمت، موجودی و
            سفارش) با رنگ جدید دارد؛ احتمالاً از تلاش قبلی برای افزودن رنگ. این پیش‌نویس‌ها حذف
            می‌شوند تا تنوع‌های فعلی جای آن‌ها را بگیرند:
          </p>
          <VariationChips items={preview.emptyDrafts} />
        </div>
      )}

      {preview.blocking.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert">
          <p className="mb-2">
            این تنوع‌ها با رنگ جدید از قبل وجود دارند و قیمت، موجودی یا سفارش دارند. ابتدا آن‌ها را
            از فهرست تنوع‌ها حذف یا ویرایش کنید:
          </p>
          <VariationChips items={preview.blocking} />
        </div>
      )}
    </div>
  );
}

function VariationChips({
  items,
}: {
  items: Array<{ id: number; label: string; sku: string | null; isPublished: boolean }>;
}) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li
          key={item.id}
          className="rounded-md border border-current/20 bg-white/70 px-2 py-0.5"
          title={item.sku ?? undefined}
        >
          {item.label}
          <span className="mr-1 opacity-70">{item.isPublished ? "· منتشر شده" : "· پیش‌نویس"}</span>
        </li>
      ))}
    </ul>
  );
}

function Swatch({ colorCode }: { colorCode?: string | null }) {
  return colorCode ? (
    <span
      className="h-6 w-6 shrink-0 rounded-full border border-slate-200"
      style={{ backgroundColor: colorCode }}
      aria-hidden="true"
    />
  ) : (
    <span
      aria-hidden="true"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-dashed border-slate-300 bg-white text-[10px] text-slate-400"
    >
      —
    </span>
  );
}
