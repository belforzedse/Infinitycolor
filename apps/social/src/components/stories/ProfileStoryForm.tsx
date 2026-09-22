"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ImagePlus, Loader2, RefreshCcw, ToggleLeft, ToggleRight, Upload, X } from "lucide-react";
import toast from "react-hot-toast";
import { IMAGE_BASE_URL } from "@repo/api";
import { Button } from "@repo/ui/button";
import { uploadFile } from "@/services/upload.service";
import { apiClient } from "@/lib/api-client";
import { ENDPOINTS } from "@/lib/api-endpoints";
import type { CreateStoryData, StoryItem, StoryItemInput, StoryMediaType } from "@/types/story";

/** How often, and for how long, to poll the backend for a normalized replacement of a
 * video the browser could not decode (Chromium has no platform HEVC decoder, so an
 * HEVC/.mov phone recording "plays" with audio but paints zero frames and never fires
 * `error`). 5s x 24 ~= 2 minutes, generous for a short story clip transcode. */
const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_POLL_MAX_ATTEMPTS = 24;
/** Grace period for a `.mov` container that never fires `loadedmetadata` or `error` at
 * all on a platform with no HEVC decoder — it just sits at readyState 0 forever. */
const VIDEO_STUCK_TIMEOUT_MS = 8000;

export type ProfileStoryFormValues = {
  Title: string;
  IsActive: boolean;
  SortOrder: number;
  MediaType: StoryMediaType;
  updatedAt?: string;
  mediaId?: number;
  mediaUrl?: string;
  thumbnailId?: number;
  thumbnailUrl?: string;
  CtaUrl?: string | null;
  /** Full canonical array; profile editing updates item one and preserves the remainder. */
  Items?: StoryItem[];
};

type ProfileStoryFormProps = {
  initialValues?: Partial<ProfileStoryFormValues>;
  heading: string;
  submitLabel: string;
  submittingLabel: string;
  isSubmitting: boolean;
  onBack: () => void;
  onSubmit: (data: CreateStoryData) => Promise<void>;
};

function resolveMediaUrl(url?: string, version?: string): string | undefined {
  if (!url) return undefined;
  const suffix = version ? `${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}` : "";
  if (url.startsWith("http://") || url.startsWith("https://")) return `${url}${suffix}`;
  const base = IMAGE_BASE_URL.replace(/\/+$/, "");
  const path = url.replace(/^\/+/, "");
  return `${base}/${path}${suffix}`;
}

export function ProfileStoryForm({
  initialValues,
  heading,
  submitLabel,
  submittingLabel,
  isSubmitting,
  onBack,
  onSubmit,
}: ProfileStoryFormProps) {
  const [title, setTitle] = useState(initialValues?.Title ?? "");
  const [isActive, setIsActive] = useState(initialValues?.IsActive ?? true);
  const [sortOrder, setSortOrder] = useState(initialValues?.SortOrder ?? 0);
  const [mediaType, setMediaType] = useState<StoryMediaType>(initialValues?.MediaType ?? "image");
  const [mediaId, setMediaId] = useState<number | undefined>(initialValues?.mediaId);
  const [mediaUrl, setMediaUrl] = useState<string | undefined>(initialValues?.mediaUrl);
  const [thumbnailId, setThumbnailId] = useState<number | undefined>(initialValues?.thumbnailId);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | undefined>(initialValues?.thumbnailUrl);
  const [ctaUrl, setCtaUrl] = useState(initialValues?.CtaUrl ?? "");
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [uploadingThumbnail, setUploadingThumbnail] = useState(false);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);

  // Chromium (no platform HEVC decoder) "plays" an HEVC/.mov clip with audio but paints
  // zero frames and never fires `error` — videoWidth/videoHeight stay 0 forever. Phone
  // recordings land in this shape. The backend transcodes them async as soon as they're
  // uploaded (see the `plugin::upload.file` afterCreate hook in apps/backend/src/index.ts),
  // so once a raw source fails to decode we poll for that replacement and swap `mediaUrl`
  // to it — the preview should end up actually playing, not just explaining why it can't.
  const [videoUnplayable, setVideoUnplayable] = useState(false);
  const [isProcessingVideo, setIsProcessingVideo] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pollAttemptsRef = useRef(0);

  const markVideoUnplayable = () => {
    if (mediaId) {
      setIsProcessingVideo(true);
    } else {
      setVideoUnplayable(true);
    }
  };

  useEffect(() => {
    if (mediaType !== "video" || !mediaUrl || videoUnplayable || isProcessingVideo) return;
    // Some `.mov` containers never fire `loadedmetadata` or `error` at all on a platform
    // with no HEVC decoder — they just sit at readyState 0 forever. Fall back after a
    // grace period instead of leaving a black box indefinitely.
    const timer = window.setTimeout(() => {
      if ((videoRef.current?.readyState ?? 0) === 0) {
        markVideoUnplayable();
      }
    }, VIDEO_STUCK_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaType, mediaUrl, videoUnplayable, isProcessingVideo]);

  useEffect(() => {
    if (!isProcessingVideo || !mediaId) return;
    let cancelled = false;
    let timer: number;

    const poll = async () => {
      if (cancelled) return;
      pollAttemptsRef.current += 1;
      try {
        const { data } = await apiClient.get<{ url?: string; mime?: string }>(
          `${ENDPOINTS.FILE.DOWNLOAD}/${mediaId}`,
        );
        // `mime` flips to "video/mp4" once the backend rewrites the row. Checking the
        // mime rather than diffing the URL avoids a false "done" on a poll that returns
        // the same still-unnormalized file.
        if (data?.url && data.mime === "video/mp4") {
          if (!cancelled) {
            setMediaUrl(data.url);
            setIsProcessingVideo(false);
            setVideoUnplayable(false);
          }
          return;
        }
      } catch {
        // Transient network/API hiccup — keep polling silently, no toast spam.
      }
      if (cancelled) return;
      if (pollAttemptsRef.current >= VIDEO_POLL_MAX_ATTEMPTS) {
        setIsProcessingVideo(false);
        setVideoUnplayable(true);
      } else {
        timer = window.setTimeout(poll, VIDEO_POLL_INTERVAL_MS);
      }
    };

    timer = window.setTimeout(poll, VIDEO_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isProcessingVideo, mediaId]);

  async function handleMediaUpload(file: File) {
    setUploadingMedia(true);
    try {
      const [uploaded] = await uploadFile(file);
      if (!uploaded) throw new Error("Upload missing response");
      setMediaId(uploaded.id);
      setMediaUrl(uploaded.url);
      setMediaType(uploaded.mime.startsWith("video/") ? "video" : "image");
      setVideoUnplayable(false);
      setIsProcessingVideo(false);
      pollAttemptsRef.current = 0;
    } catch {
      toast.error("آپلود رسانه ناموفق بود.");
    } finally {
      setUploadingMedia(false);
    }
  }

  async function handleThumbnailUpload(file: File) {
    setUploadingThumbnail(true);
    try {
      const [uploaded] = await uploadFile(file);
      if (!uploaded) throw new Error("Upload missing response");
      setThumbnailId(uploaded.id);
      setThumbnailUrl(uploaded.url);
    } catch {
      toast.error("آپلود تصویر جلد ناموفق بود.");
    } finally {
      setUploadingThumbnail(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) {
      toast.error("عنوان الزامی است.");
      return;
    }
    if (!mediaId) {
      toast.error("آپلود رسانه الزامی است.");
      return;
    }
    const originalItems = initialValues?.Items ?? [];
    const first = originalItems[0];
    const items: StoryItemInput[] = [
      {
        ...(first?.id ? { id: first.id } : {}),
        ...(first?.Key ? { Key: first.Key } : {}),
        MediaType: mediaType,
        Media: mediaId,
        Thumbnail: first?.Thumbnail?.id ?? null,
        DurationMs: first?.DurationMs ?? 5000,
        CtaUrl: ctaUrl.trim() || null,
        Overlays: first?.Overlays ?? [],
      },
      ...originalItems.slice(1).map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        Key: item.Key,
        MediaType: item.MediaType,
        Media: item.Media!.id,
        Thumbnail: item.Thumbnail?.id ?? null,
        DurationMs: item.DurationMs,
        CtaUrl: item.CtaUrl ?? null,
        Overlays: item.Overlays ?? [],
      })),
    ];
    await onSubmit({
      Title: title.trim(),
      IsActive: isActive,
      SortOrder: sortOrder,
      Thumbnail: thumbnailId,
      Items: items,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-6" dir="rtl">
      <div className="flex flex-row items-center gap-3">
        <h1 className="font-peyda text-lg font-semibold text-zinc-800 lg:text-xl">{heading}</h1>
        <button
          type="button"
          onClick={onBack}
          className="hidden rounded-xl bg-white px-3 py-2 font-peyda text-sm text-zinc-700 shadow-[0_0_14.7px_rgba(0,0,0,0.04)] hover:bg-zinc-50 lg:inline-flex"
        >
          بازگشت
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-5">
          {(initialValues?.Items?.length ?? 0) > 1 && (
            <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 font-peyda text-sm text-amber-800">
              این داستان {initialValues?.Items?.length} آیتم دارد. این فرم آیتم اول را ویرایش می‌کند و آیتم‌های دیگر را بدون تغییر نگه می‌دارد.
            </section>
          )}
          <section className="rounded-2xl bg-white p-5 shadow-[0_0_14.7px_rgba(0,0,0,0.04)]">
            <label className="mb-2 block font-peyda text-sm font-medium text-zinc-700">عنوان</label>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-xl border border-zinc-200 px-4 py-2.5 font-peyda text-sm outline-none focus:border-[#566D97]"
              placeholder="عنوان استوری"
            />
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-[0_0_14.7px_rgba(0,0,0,0.04)]">
            <label className="mb-3 block font-peyda text-sm font-medium text-zinc-700">رسانه</label>
            {mediaUrl ? (
              <div className="relative inline-flex">
                {mediaType === "video" ? (
                  isProcessingVideo ? (
                    <div className="flex h-56 w-40 flex-col items-center justify-center gap-2 rounded-xl bg-zinc-800 px-3 text-center">
                      <Loader2 className="size-6 animate-spin text-white/70" aria-hidden />
                      <span className="font-peyda text-xs leading-5 text-white/80">
                        این ویدیو در حال پردازش برای پخش در مرورگر است...
                      </span>
                      <a
                        href={resolveMediaUrl(mediaUrl, initialValues?.updatedAt)}
                        download
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        className="rounded-md bg-white/10 px-3 py-1.5 font-peyda text-[11px] font-medium text-white underline decoration-white/40 hover:bg-white/20"
                      >
                        دانلود ویدیوی اصلی
                      </a>
                    </div>
                  ) : videoUnplayable ? (
                    <div className="flex h-56 w-40 flex-col items-center justify-center gap-2 rounded-xl bg-zinc-800 px-3 text-center">
                      <RefreshCcw className="size-6 text-white/70" aria-hidden />
                      <span className="font-peyda text-xs leading-5 text-white/80">
                        این فرمت ویدیو (احتمالاً HEVC) توسط مرورگر شما قابل پخش نیست، هرچند فایل
                        با موفقیت بارگذاری شده است.
                      </span>
                      <a
                        href={resolveMediaUrl(mediaUrl, initialValues?.updatedAt)}
                        download
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        className="rounded-md bg-white/10 px-3 py-1.5 font-peyda text-[11px] font-medium text-white underline decoration-white/40 hover:bg-white/20"
                      >
                        دانلود ویدیو برای بررسی
                      </a>
                    </div>
                  ) : (
                    <video
                      ref={videoRef}
                      src={resolveMediaUrl(mediaUrl, initialValues?.updatedAt)}
                      controls
                      className="h-56 rounded-xl"
                      onLoadedMetadata={(event) => {
                        if (
                          event.currentTarget.videoWidth === 0 &&
                          event.currentTarget.videoHeight === 0
                        ) {
                          markVideoUnplayable();
                        }
                      }}
                      onError={() => markVideoUnplayable()}
                    />
                  )
                ) : (
                  <img
                    src={resolveMediaUrl(mediaUrl, initialValues?.updatedAt)}
                    alt=""
                    className="h-56 rounded-xl object-cover"
                  />
                )}
                <button
                  type="button"
                  onClick={() => {
                    setMediaId(undefined);
                    setMediaUrl(undefined);
                    setVideoUnplayable(false);
                    setIsProcessingVideo(false);
                    pollAttemptsRef.current = 0;
                  }}
                  className="absolute -right-2 -top-2 rounded-full bg-rose-500 p-1 text-white"
                  aria-label="حذف رسانه"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={uploadingMedia}
                onClick={() => mediaInputRef.current?.click()}
                className="flex min-h-44 w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-zinc-200 font-peyda text-sm text-zinc-400 hover:border-[#98BDFF] hover:text-[#566D97]"
              >
                <Upload className="size-7" aria-hidden />
                {uploadingMedia ? "در حال آپلود..." : "آپلود تصویر یا ویدیو"}
              </button>
            )}
            <input
              ref={mediaInputRef}
              type="file"
              accept="image/*,video/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleMediaUpload(file);
              }}
            />
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-[0_0_14.7px_rgba(0,0,0,0.04)]">
            <label className="mb-3 block font-peyda text-sm font-medium text-zinc-700">تصویر جلد</label>
            {thumbnailUrl ? (
              <div className="relative inline-flex">
                <img
                  src={resolveMediaUrl(thumbnailUrl, initialValues?.updatedAt)}
                  alt=""
                  className="size-32 rounded-xl object-cover"
                />
                <button
                  type="button"
                  onClick={() => {
                    setThumbnailId(undefined);
                    setThumbnailUrl(undefined);
                  }}
                  className="absolute -right-2 -top-2 rounded-full bg-rose-500 p-1 text-white"
                  aria-label="حذف تصویر جلد"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={uploadingThumbnail}
                onClick={() => thumbnailInputRef.current?.click()}
                className="flex h-32 w-40 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-zinc-200 font-peyda text-sm text-zinc-400 hover:border-[#98BDFF] hover:text-[#566D97]"
              >
                <ImagePlus className="size-6" aria-hidden />
                {uploadingThumbnail ? "در حال آپلود..." : "آپلود جلد"}
              </button>
            )}
            <input
              ref={thumbnailInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleThumbnailUpload(file);
              }}
            />
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-[0_0_14.7px_rgba(0,0,0,0.04)]">
            <label htmlFor="profile-story-cta-url" className="mb-2 block font-peyda text-sm font-medium text-zinc-700">
              لینک دکمه «مشاهده لینک»
            </label>
            <input
              id="profile-story-cta-url"
              type="text"
              inputMode="url"
              dir="ltr"
              value={ctaUrl}
              onChange={(event) => setCtaUrl(event.target.value)}
              placeholder="https://example.com یا /pdp/product"
              className="w-full rounded-xl border border-zinc-200 px-4 py-2.5 text-left font-peyda text-sm outline-none focus:border-[#566D97]"
            />
          </section>
        </div>

        <aside className="flex flex-col gap-5">
          <section className="rounded-2xl bg-white p-5 shadow-[0_0_14.7px_rgba(0,0,0,0.04)]">
            <div className="mb-5 flex items-center justify-between gap-3">
              <span className="font-peyda text-sm font-medium text-zinc-700">وضعیت انتشار</span>
              <button
                type="button"
                onClick={() => setIsActive((value) => !value)}
                className="inline-flex items-center gap-2 font-peyda text-sm"
              >
                {isActive ? (
                  <>
                    <ToggleRight className="size-6 text-emerald-500" aria-hidden />
                    <span className="text-emerald-700">فعال</span>
                  </>
                ) : (
                  <>
                    <ToggleLeft className="size-6 text-zinc-400" aria-hidden />
                    <span className="text-zinc-500">غیرفعال</span>
                  </>
                )}
              </button>
            </div>
            <Button variant="blue" type="submit" disabled={isSubmitting} className="w-full">
              {isSubmitting ? submittingLabel : submitLabel}
            </Button>
          </section>

          <section className="rounded-2xl bg-white p-5 shadow-[0_0_14.7px_rgba(0,0,0,0.04)]">
            <label className="mb-2 block font-peyda text-sm font-medium text-zinc-700">ترتیب نمایش</label>
            <input
              type="number"
              min={0}
              value={sortOrder}
              onChange={(event) => setSortOrder(Number(event.target.value))}
              className="w-full rounded-xl border border-zinc-200 px-4 py-2.5 font-peyda text-sm outline-none focus:border-[#566D97]"
            />
          </section>
        </aside>
      </div>
    </form>
  );
}
