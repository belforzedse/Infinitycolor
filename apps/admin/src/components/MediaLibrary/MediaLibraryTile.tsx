"use client";

import { Check, Film, ImageIcon, Loader2 } from "lucide-react";
import { faNum } from "@/utils/faNum";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import {
  isFailedVideo,
  VIDEO_PROCESSING_STATUSES,
  type MediaLibraryItem,
} from "@/services/super-admin/files/mediaLibrary";

interface MediaLibraryTileProps {
  item: MediaLibraryItem;
  selectionMode: "single" | "multiple";
  selected: boolean;
  /** 1-based pick order in multi-select, shown on the check badge. */
  order?: number;
  locked?: boolean;
  lockedLabel?: string;
  /** Not selectable for this picker (wrong type, failed transcode). */
  unavailableReason?: string | null;
  isCurrentCover?: boolean;
  showUsage?: boolean;
  onToggle: (item: MediaLibraryItem) => void;
  onQuickConfirm?: (item: MediaLibraryItem) => void;
}

export function formatMediaSize(sizeKb: number | null): string | null {
  if (sizeKb === null || !Number.isFinite(sizeKb)) return null;
  if (sizeKb >= 1024) return `${faNum(sizeKb / 1024, { maximumFractionDigits: 1 })} MB`;
  return `${faNum(Math.max(1, Math.round(sizeKb)))} KB`;
}

function usageLabel(item: MediaLibraryItem): { text: string; tone: "used" | "removed" | "loose" } {
  const { productCount, removedProductCount } = item.usage;
  if (productCount > 0) return { text: `در ${faNum(productCount)} محصول`, tone: "used" };
  if (removedProductCount > 0) return { text: "فقط محصول حذف‌شده", tone: "removed" };
  return { text: "بدون اتصال", tone: "loose" };
}

function usageTooltip(item: MediaLibraryItem): string {
  const { products, productCount, removedProductCount } = item.usage;
  if (products.length === 0) return "این فایل به هیچ محصولی متصل نیست";
  const lines = products.map(
    (product) =>
      `${product.title}${product.asCover ? " (کاور)" : ""}${product.removed ? " (حذف‌شده)" : ""}`,
  );
  const hidden = productCount + removedProductCount - products.length;
  if (hidden > 0) lines.push(`و ${faNum(hidden)} مورد دیگر`);
  return lines.join("\n");
}

const USAGE_TONE_CLASS = {
  used: "bg-sky-50 text-sky-700 ring-sky-200",
  removed: "bg-amber-50 text-amber-700 ring-amber-200",
  loose: "bg-slate-100 text-slate-600 ring-slate-200",
} as const;

export default function MediaLibraryTile({
  item,
  selectionMode,
  selected,
  order,
  locked = false,
  lockedLabel,
  unavailableReason,
  isCurrentCover = false,
  showUsage = true,
  onToggle,
  onQuickConfirm,
}: MediaLibraryTileProps) {
  const isVideo = item.mime.startsWith("video/");
  const thumbnail = item.thumbnailUrl ? resolveAssetUrl(item.thumbnailUrl) : "";
  const disabled = locked || Boolean(unavailableReason);
  const processing = isVideo && VIDEO_PROCESSING_STATUSES.has(item.video?.status ?? "");
  const size = formatMediaSize(item.size);
  const dimensions =
    item.width && item.height
      ? `${faNum(item.width, { useGrouping: false })}×${faNum(item.height, { useGrouping: false })}`
      : null;
  const usage = usageLabel(item);

  return (
    <button
      type="button"
      role={selectionMode === "multiple" ? "checkbox" : "radio"}
      aria-checked={selected}
      aria-disabled={disabled}
      data-testid="media-library-tile"
      data-file-id={item.id}
      title={unavailableReason ?? (locked ? lockedLabel : item.name)}
      onClick={() => {
        if (!disabled) onToggle(item);
      }}
      onDoubleClick={() => {
        if (!disabled && selectionMode === "single") onQuickConfirm?.(item);
      }}
      className={`group relative flex flex-col overflow-hidden rounded-xl border bg-white text-right transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary focus-visible:ring-offset-2 ${
        selected
          ? "border-infinity-primary shadow-md ring-2 ring-infinity-primary/30"
          : "border-slate-200 hover:border-infinity-primary-lighter hover:shadow-sm"
      } ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
    >
      <div className="relative aspect-square w-full overflow-hidden bg-slate-50">
        {thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnail}
            alt={item.alternativeText ?? item.name}
            loading="lazy"
            decoding="async"
            className={`h-full w-full object-contain transition duration-200 ${
              disabled ? "opacity-40 grayscale" : "group-hover:scale-[1.03]"
            }`}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-300">
            {isVideo ? (
              <Film className="h-10 w-10" aria-hidden="true" />
            ) : (
              <ImageIcon className="h-10 w-10" aria-hidden="true" />
            )}
          </div>
        )}

        {isVideo && thumbnail ? (
          <span className="absolute bottom-2 left-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white">
            <Film className="h-4 w-4" aria-hidden="true" />
          </span>
        ) : null}

        <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
          {isCurrentCover && !locked ? (
            <span className="rounded-pill bg-infinity-primary px-2 py-0.5 text-[10px] font-medium text-white shadow-sm">
              کاور
            </span>
          ) : null}
          {locked && lockedLabel ? (
            <span className="rounded-pill bg-slate-800/80 px-2 py-0.5 text-[10px] font-medium text-white">
              {lockedLabel}
            </span>
          ) : null}
          {processing ? (
            <span className="flex items-center gap-1 rounded-pill bg-amber-500/90 px-2 py-0.5 text-[10px] font-medium text-white">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              در حال پردازش
            </span>
          ) : null}
          {unavailableReason && !locked ? (
            <span className="rounded-pill bg-rose-600/90 px-2 py-0.5 text-[10px] font-medium text-white">
              {isFailedVideo(item) ? "پردازش ناموفق" : "غیرقابل انتخاب"}
            </span>
          ) : null}
        </div>

        <span
          aria-hidden="true"
          className={`absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded-full border-2 text-[11px] font-bold transition ${
            selected
              ? "border-infinity-primary bg-infinity-primary text-white"
              : "border-white/90 bg-black/10 text-transparent opacity-0 group-hover:opacity-100"
          } ${disabled ? "hidden" : ""}`}
        >
          {selected && selectionMode === "multiple" && order ? (
            faNum(order)
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-1 p-2">
        <span className="truncate text-[11px] text-slate-700" dir="ltr">
          {item.name}
        </span>
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-[10px] text-slate-400" dir="ltr">
            {[dimensions, size].filter(Boolean).join(" · ")}
          </span>
          {showUsage ? (
            <span
              title={usageTooltip(item)}
              aria-label={usageTooltip(item)}
              className={`shrink-0 rounded-pill px-1.5 py-0.5 text-[10px] ring-1 ${USAGE_TONE_CLASS[usage.tone]}`}
            >
              {usage.text}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}
