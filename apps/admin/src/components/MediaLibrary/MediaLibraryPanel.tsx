"use client";

import { useRef, useState } from "react";
import toast from "react-hot-toast";
import { ImageOff, Loader2, RefreshCcw, Search, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useMediaLibrary } from "@/hooks/useMediaLibrary";
import { uploadFile } from "@/services/super-admin/files/upload";
import {
  isFailedVideo,
  uploadedImageToLibraryItem,
  type MediaLibraryItem,
  type MediaLibraryType,
  type MediaLibraryUsageFilter,
} from "@/services/super-admin/files/mediaLibrary";
import { faNum } from "@/utils/faNum";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import MediaLibraryTile from "./MediaLibraryTile";

export interface MediaLibraryPanelProps {
  selection: "single" | "multiple";
  allowedTypes: readonly MediaLibraryType[];
  confirmLabel: (count: number) => string;
  onConfirm: (items: MediaLibraryItem[]) => void;
  onCancel: () => void;
  /** Files that are already where the pick would put them (current cover, gallery). */
  lockedIds?: ReadonlySet<number>;
  lockedLabel?: string;
  currentCoverId?: number | null;
  /** This product's own images, for the «این محصول» tab. */
  ownMedia?: MediaLibraryItem[];
  maxSelection?: number;
  allowUpload?: boolean;
}

type Tab = "library" | "own";

const TYPE_LABELS: Record<MediaLibraryType, string> = { image: "تصویر", video: "ویدیو" };
const USAGE_OPTIONS: Array<{ value: MediaLibraryUsageFilter; label: string }> = [
  { value: "all", label: "همه" },
  { value: "attached", label: "استفاده‌شده در محصولات" },
  { value: "unattached", label: "بدون اتصال" },
];
const SKELETON_TILES = Array.from({ length: 12 }, (_, index) => index);

function chipClass(active: boolean) {
  return `shrink-0 rounded-pill px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary ${
    active
      ? "bg-infinity-primary text-white shadow-sm"
      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
  }`;
}

export default function MediaLibraryPanel({
  selection,
  allowedTypes,
  confirmLabel,
  onConfirm,
  onCancel,
  lockedIds,
  lockedLabel,
  currentCoverId = null,
  ownMedia = [],
  maxSelection,
  allowUpload = true,
}: MediaLibraryPanelProps) {
  const library = useMediaLibrary({ initialType: allowedTypes[0] ?? "image" });
  const [tab, setTab] = useState<Tab>("library");
  const [selected, setSelected] = useState<MediaLibraryItem[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedIndex = new Map(selected.map((item, index) => [item.id, index]));
  const accept = allowedTypes.map((type) => `${type}/*`).join(",");
  const showOwnTab = ownMedia.length > 0;
  const limitReached = maxSelection !== undefined && selected.length >= maxSelection;

  const unavailableReason = (item: MediaLibraryItem): string | null => {
    if (!allowedTypes.some((type) => item.mime.startsWith(`${type}/`))) {
      return "این نوع فایل در اینجا قابل استفاده نیست";
    }
    if (isFailedVideo(item)) return "پردازش این ویدیو ناموفق بوده است";
    return null;
  };

  const addToSelection = (item: MediaLibraryItem) => {
    if (lockedIds?.has(item.id) || unavailableReason(item)) return;
    if (selection === "single") {
      setSelected([item]);
      return;
    }
    setSelected((previous) => {
      if (previous.some((existing) => existing.id === item.id)) return previous;
      if (maxSelection !== undefined && previous.length >= maxSelection) return previous;
      return [...previous, item];
    });
  };

  const toggle = (item: MediaLibraryItem) => {
    if (selection === "single") {
      setSelected([item]);
      return;
    }
    if (selectedIndex.has(item.id)) {
      setSelected((previous) => previous.filter((existing) => existing.id !== item.id));
      return;
    }
    if (limitReached) {
      toast.error(`حداکثر ${faNum(maxSelection!)} فایل را می‌توانید یکجا انتخاب کنید`);
      return;
    }
    addToSelection(item);
  };

  const confirm = (items: MediaLibraryItem[]) => {
    const usable = items.filter((item) => !unavailableReason(item) && !lockedIds?.has(item.id));
    if (usable.length === 0) return;
    onConfirm(usable);
  };

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const accepted = files.filter((file) =>
      allowedTypes.some((type) => file.type.startsWith(`${type}/`)),
    );
    if (accepted.length < files.length) {
      toast.error(
        allowedTypes.includes("video")
          ? "فقط فایل تصویر یا ویدیو قابل آپلود است"
          : "فقط فایل تصویری قابل آپلود است",
      );
    }
    const queue = selection === "single" ? accepted.slice(0, 1) : accepted;
    if (queue.length === 0) return;

    setTab("library");
    setUploadingCount((count) => count + queue.length);
    let uploaded = 0;
    for (const file of queue) {
      try {
        const response = await uploadFile(file);
        const first = response?.[0];
        if (!first) continue;
        const item = uploadedImageToLibraryItem(first);
        library.prepend(item);
        addToSelection(item);
        uploaded += 1;
      } catch (error) {
        console.error("Media library upload failed", error);
        toast.error(`آپلود «${file.name}» ناموفق بود`);
      } finally {
        setUploadingCount((count) => count - 1);
      }
    }
    if (uploaded > 0) {
      toast.success(
        uploaded === 1 ? "فایل آپلود و انتخاب شد" : `${faNum(uploaded)} فایل آپلود و انتخاب شد`,
      );
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    if (!allowUpload) return;
    void uploadFiles(Array.from(event.dataTransfer.files ?? []));
  };

  const visibleItems = tab === "own" ? ownMedia : library.items;
  const isInitialLoading = tab === "library" && library.status === "loading";
  const hasSearch = library.search !== "" || library.usage !== "all";

  const renderGridBody = () => {
    if (isInitialLoading) {
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {SKELETON_TILES.map((index) => (
            <div key={index} className="overflow-hidden rounded-xl border border-slate-100">
              <div className="aspect-square animate-pulse bg-slate-100" />
              <div className="space-y-1.5 p-2">
                <div className="h-2.5 w-3/4 animate-pulse rounded bg-slate-100" />
                <div className="h-2.5 w-1/2 animate-pulse rounded bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (tab === "library" && library.status === "error") {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <p className="text-sm text-rose-600">دریافت کتابخانه رسانه ناموفق بود</p>
          <Button type="button" variant="outline" size="sm" onClick={library.retry}>
            <RefreshCcw className="ml-1.5 h-4 w-4" aria-hidden="true" />
            تلاش مجدد
          </Button>
        </div>
      );
    }

    if (visibleItems.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-slate-500">
          <ImageOff className="h-10 w-10 text-slate-300" aria-hidden="true" />
          {hasSearch ? (
            <>
              <p className="text-sm">
                {library.search
                  ? `نتیجه‌ای برای «${library.search}» پیدا نشد`
                  : "فایلی با این فیلتر پیدا نشد"}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  library.clearSearch();
                  library.setUsage("all");
                }}
              >
                پاک کردن جستجو
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm">هنوز فایلی در کتابخانه نیست</p>
              {allowUpload ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="ml-1.5 h-4 w-4" aria-hidden="true" />
                  آپلود فایل جدید
                </Button>
              ) : null}
            </>
          )}
        </div>
      );
    }

    return (
      <>
        <div
          role={selection === "multiple" ? "group" : "radiogroup"}
          aria-label="فایل‌های کتابخانه"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
        >
          {visibleItems.map((item) => (
            <MediaLibraryTile
              key={item.id}
              item={item}
              selectionMode={selection}
              selected={selectedIndex.has(item.id)}
              order={(selectedIndex.get(item.id) ?? -1) + 1 || undefined}
              locked={lockedIds?.has(item.id) ?? false}
              lockedLabel={lockedLabel}
              unavailableReason={unavailableReason(item)}
              isCurrentCover={currentCoverId === item.id}
              showUsage={tab === "library"}
              onToggle={toggle}
              onQuickConfirm={(picked) => confirm([picked])}
            />
          ))}
        </div>

        {tab === "library" && (library.hasMore || library.status === "loadMoreError") ? (
          <div className="flex justify-center pt-5">
            {library.status === "loadMoreError" ? (
              <Button type="button" variant="outline" size="sm" onClick={library.retry}>
                <RefreshCcw className="ml-1.5 h-4 w-4" aria-hidden="true" />
                خطا در دریافت؛ تلاش مجدد
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={library.status === "loadingMore"}
                onClick={library.loadMore}
              >
                {library.status === "loadingMore" ? (
                  <Loader2 className="ml-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                نمایش بیشتر ({faNum(library.items.length)} از {faNum(library.total)})
              </Button>
            )}
          </div>
        ) : null}
      </>
    );
  };

  return (
    <div className="flex h-[calc(100dvh-8rem)] max-h-[760px] flex-col">
      <div className="shrink-0 space-y-3 border-b border-slate-100 bg-white px-4 py-3 md:px-6">
        {showOwnTab ? (
          <div
            role="tablist"
            aria-label="منبع فایل"
            className="flex items-center gap-1 rounded-xl bg-slate-50 p-1 text-sm font-medium"
          >
            {(
              [
                ["library", "کتابخانه رسانه"],
                ["own", `تصاویر این محصول (${faNum(ownMedia.length)})`],
              ] as Array<[Tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={`flex-1 rounded-lg px-3 py-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-infinity-primary ${
                  tab === key
                    ? "bg-white text-infinity-primary shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {tab === "library" ? (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search
                  className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={library.searchInput}
                  onChange={(event) => library.updateSearch(event.target.value)}
                  placeholder="جستجو در نام فایل یا عنوان محصول…"
                  aria-label="جستجو در کتابخانه"
                  data-testid="media-library-search"
                  className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-9 text-sm text-slate-700 placeholder:text-slate-400 focus:border-infinity-primary-light focus:outline-none focus:ring-2 focus:ring-infinity-primary-lighter/60"
                />
                {library.searchInput ? (
                  <button
                    type="button"
                    onClick={library.clearSearch}
                    aria-label="پاک کردن جستجو"
                    className="absolute left-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {allowUpload ? (
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 gap-1.5"
                  disabled={uploadingCount > 0}
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="media-library-upload"
                >
                  {uploadingCount > 0 ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Upload className="h-4 w-4" aria-hidden="true" />
                  )}
                  {uploadingCount > 0 ? "در حال آپلود…" : "آپلود فایل جدید"}
                </Button>
              ) : null}
            </div>

            <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-0.5">
              {allowedTypes.length > 1
                ? allowedTypes.map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={library.type === type}
                      onClick={() => library.setType(type)}
                      className={chipClass(library.type === type)}
                    >
                      {TYPE_LABELS[type]}
                    </button>
                  ))
                : null}
              {allowedTypes.length > 1 ? (
                <span className="mx-1 h-5 w-px shrink-0 bg-slate-200" aria-hidden="true" />
              ) : null}
              {USAGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={library.usage === option.value}
                  onClick={() => library.setUsage(option.value)}
                  className={chipClass(library.usage === option.value)}
                >
                  {option.label}
                </button>
              ))}
              <span className="mr-auto shrink-0 text-xs text-slate-400" aria-live="polite">
                {library.status === "loading" ? "" : `${faNum(library.total)} فایل`}
              </span>
            </div>
          </>
        ) : null}

        {allowUpload ? (
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            multiple={selection === "multiple"}
            className="hidden"
            data-testid="media-library-file-input"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void uploadFiles(files);
            }}
          />
        ) : null}
      </div>

      <div
        className={`relative min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 ${
          dragActive ? "bg-infinity-primary-lighter/10" : ""
        }`}
        onDragOver={(event) => {
          if (!allowUpload) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragActive(false);
        }}
        onDrop={handleDrop}
      >
        {renderGridBody()}
        {dragActive ? (
          <div className="pointer-events-none absolute inset-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-infinity-primary bg-white/80 text-sm font-medium text-infinity-primary">
            فایل را اینجا رها کنید تا آپلود و انتخاب شود
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col gap-3 border-t border-slate-100 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          {selected.length === 0 && tab === "own" && ownMedia.every((item) => lockedIds?.has(item.id) || unavailableReason(item)) ? null : selected.length === 0 ? (
            <span className="text-xs text-slate-400">
              {selection === "multiple"
                ? "روی تصاویر کلیک کنید تا انتخاب شوند"
                : "یک فایل را انتخاب کنید (دوبار کلیک = انتخاب سریع)"}
            </span>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
                {selected.map((item) => (
                  <span key={item.id} className="relative shrink-0">
                    {item.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={resolveAssetUrl(item.thumbnailUrl)}
                        alt=""
                        className="h-10 w-10 rounded-lg border border-slate-200 object-cover"
                      />
                    ) : (
                      <span className="block h-10 w-10 rounded-lg border border-slate-200 bg-slate-100" />
                    )}
                    {selection === "multiple" ? (
                      <button
                        type="button"
                        aria-label={`حذف ${item.name} از انتخاب`}
                        onClick={() =>
                          setSelected((previous) =>
                            previous.filter((existing) => existing.id !== item.id),
                          )
                        }
                        className="absolute -left-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-slate-700 text-white hover:bg-rose-600"
                      >
                        <X className="h-3 w-3" aria-hidden="true" />
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
              <span className="shrink-0 text-xs text-slate-600">
                {selection === "multiple"
                  ? `${faNum(selected.length)} مورد انتخاب شد${
                      maxSelection ? ` (حداکثر ${faNum(maxSelection)})` : ""
                    }`
                  : selected[0].name}
              </span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            انصراف
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={selected.length === 0 || uploadingCount > 0}
            onClick={() => confirm(selected)}
            data-testid="media-library-confirm"
          >
            {confirmLabel(selected.length)}
          </Button>
        </div>
      </div>
    </div>
  );
}
