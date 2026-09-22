import React, { useEffect, useRef, useState } from "react";
import Image from "next/image";
import imageLoader from "@/utils/imageLoader";
import DeleteIcon from "@/components/Kits/Icons/DeleteIcon";
import { ENDPOINTS, IMAGE_BASE_URL } from "@/constants/api";
import resolveAssetUrl from "@/utils/resolveAssetUrl";
import { apiClient } from "@/services";
import UploadStatusBadge, {
  type UploadStatus,
} from "@/components/Product/add/UploadStatusBadge";
import { Loader2, RefreshCcw } from "lucide-react";
import VideoPreviewModal from "../VideoPreviewModal";

export interface ImagePreviewProps {
  preview: string;
  onRemove: () => void;
  onRetry?: () => void;
  index: number;
  mimeType?: string;
  uploadStatus?: UploadStatus;
  uploadError?: string | null;
  /** Strapi upload file id, used to poll for the backend's web-safe transcode when the
   * raw source can't be decoded in-browser (see `videoUnplayable` below). */
  fileId?: number;
}

/** How often, and for how long, to poll the backend for a normalized replacement of a
 * video the browser could not decode. 5s x 24 ~= 2 minutes, generous for a short
 * marketing clip transcode without leaving the admin staring at a spinner forever. */
const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_POLL_MAX_ATTEMPTS = 24;
/** Grace period for a `.mov` container that never fires `loadedmetadata` or `error`
 * at all on a platform with no HEVC decoder — it just sits at readyState 0. */
const VIDEO_STUCK_TIMEOUT_MS = 8000;

const resolveSrc = (preview: string): string => {
  if (!preview) return "/images/placeholders/image-placeholder.svg";
  const trimmed = preview.trim();
  if (trimmed.startsWith("blob:") || trimmed.startsWith("data:")) {
    return trimmed;
  }
  const resolvedAssetUrl = resolveAssetUrl(trimmed);
  if (resolvedAssetUrl) {
    return resolvedAssetUrl;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\s+/g, "");
  }
  try {
    // try constructing absolute URL; if it fails, fall back
    return new URL(trimmed, IMAGE_BASE_URL).toString();
  } catch {
    const base = IMAGE_BASE_URL.replace(/\/+$/, "");
    return `${base}${trimmed.startsWith("/") ? trimmed : `/${trimmed}`}`;
  }
};

const PhotoUploaderImagePreview: React.FC<ImagePreviewProps> = ({
  preview,
  onRemove,
  onRetry,
  index,
  mimeType,
  uploadStatus,
  uploadError,
  fileId,
}) => {
  const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);
  // Chromium (no platform HEVC decoder) "plays" an HEVC/.mov clip with audio but paints
  // zero frames and never fires `error` — videoWidth/videoHeight stay 0 forever. Phone
  // recordings land in this shape. The backend transcodes them async (see
  // services/media/normalize-upload-video.ts and the `plugin::upload.file` afterCreate
  // hook in apps/backend/src/index.ts), so once a raw source fails to decode we poll for
  // that replacement and swap to it — the preview should end up actually playing, not
  // just explaining why it can't.
  const [videoUnplayable, setVideoUnplayable] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [liveSrc, setLiveSrc] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pollAttemptsRef = useRef(0);
  const isVideo =
    mimeType?.startsWith("video/") ||
    preview?.match(/\.(mp4|webm|ogg|mov)$/i) !== null ||
    (preview?.startsWith("blob:") && preview.includes("video"));
  const currentSrc = liveSrc ?? resolveSrc(preview);

  const markUnplayable = () => {
    if (fileId) {
      setIsProcessing(true);
    } else {
      setVideoUnplayable(true);
    }
  };

  useEffect(() => {
    if (!isVideo || videoUnplayable || isProcessing) return;
    // Some `.mov` containers never fire `loadedmetadata` or `error` at all on a platform
    // with no HEVC decoder — they just sit at readyState 0 forever. Fall back after a
    // grace period instead of leaving a black box indefinitely.
    const timer = window.setTimeout(() => {
      if ((videoRef.current?.readyState ?? 0) === 0) {
        markUnplayable();
      }
    }, VIDEO_STUCK_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo, videoUnplayable, isProcessing, currentSrc]);

  useEffect(() => {
    if (!isProcessing || !fileId) return;
    let cancelled = false;
    let timer: number;

    const poll = async () => {
      if (cancelled) return;
      pollAttemptsRef.current += 1;
      try {
        const { data } = await apiClient.get<{ url?: string; mime?: string }>(
          `${ENDPOINTS.FILE.DOWNLOAD}/${fileId}`,
        );
        // `mime` flips to "video/mp4" once normalizeUploadFile rewrites the row (see
        // apps/backend/src/services/media/normalize-upload-video.ts). Checking the mime
        // rather than diffing the URL avoids a false "done" on the very first poll, where
        // `currentSrc` is still the local `blob:` preview and would never string-match the
        // server URL even for an unchanged file.
        const nextUrl = data?.url ? resolveAssetUrl(data.url) : "";
        if (nextUrl && data?.mime === "video/mp4") {
          if (!cancelled) {
            setLiveSrc(nextUrl);
            setIsProcessing(false);
            setVideoUnplayable(false);
          }
          return;
        }
      } catch {
        // Transient network/API hiccup — keep polling silently, no toast spam.
      }
      if (cancelled) return;
      if (pollAttemptsRef.current >= VIDEO_POLL_MAX_ATTEMPTS) {
        setIsProcessing(false);
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
  }, [isProcessing, fileId]);

  return (
    <>
      <div className="group relative mb-5 flex aspect-square flex-col items-end justify-center overflow-hidden rounded-lg transition-all duration-300 hover:shadow-lg">
        {isVideo ? (
          isProcessing ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-neutral-800 px-3 text-center">
              <Loader2 className="h-6 w-6 animate-spin text-white/70" />
              <span className="text-xs leading-5 text-white/80">
                این ویدیو در حال پردازش برای پخش در مرورگر است...
              </span>
              <a
                href={resolveSrc(preview)}
                download
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="rounded-md bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white underline decoration-white/40 hover:bg-white/20"
              >
                دانلود ویدیوی اصلی
              </a>
            </div>
          ) : videoUnplayable ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-neutral-800 px-3 text-center">
              <RefreshCcw className="h-6 w-6 text-white/70" />
              <span className="text-xs leading-5 text-white/80">
                این فرمت ویدیو (احتمالاً HEVC) توسط مرورگر شما قابل پخش نیست، هرچند فایل با
                موفقیت بارگذاری شده است.
              </span>
              <a
                href={resolveSrc(preview)}
                download
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
                className="rounded-md bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white underline decoration-white/40 hover:bg-white/20"
              >
                دانلود ویدیو برای بررسی
              </a>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                src={currentSrc}
                className="h-full w-full object-contain cursor-pointer"
                controls={false}
                muted
                playsInline
                preload="metadata"
                onClick={() => setIsVideoModalOpen(true)}
                onLoadedMetadata={(event) => {
                  if (event.currentTarget.videoWidth === 0 && event.currentTarget.videoHeight === 0) {
                    markUnplayable();
                  }
                }}
                onError={() => markUnplayable()}
              />
              {/* Luxury play button overlay */}
              <button
                onClick={() => setIsVideoModalOpen(true)}
                className="absolute inset-0 flex items-center justify-center bg-black/0 transition-all duration-300 group-hover:bg-black/10 cursor-pointer"
              >
                <div className="flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                  <div className="h-12 w-12 rounded-full bg-white/95 shadow-xl ring-2 ring-infinity-primary-lighter/50 transition-all duration-300 group-hover:scale-110">
                    <svg
                      className="relative left-[2px] top-1/2 h-5 w-5 -translate-y-1/2 text-infinity-primary"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </div>
              </button>
            </>
          )
        ) : (
          <Image
            src={resolveSrc(preview)}
            alt={`Uploaded image ${index + 1}`}
            fill
            className="rounded-lg object-cover transition-transform duration-300 group-hover:scale-105"
            loader={imageLoader}
          />
        )}

        <div className="absolute bottom-2 left-2 z-10 flex flex-col items-start gap-1">
          <UploadStatusBadge status={uploadStatus} />
          {uploadStatus === "failed" && uploadError ? (
            <span className="max-w-36 rounded-md bg-white/95 px-2 py-1 text-[10px] text-rose-700 shadow-sm">
              {uploadError}
            </span>
          ) : null}
        </div>

        {uploadStatus === "failed" && onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="absolute inset-x-4 top-1/2 z-10 flex -translate-y-1/2 items-center justify-center gap-2 rounded-lg bg-white/95 px-3 py-2 text-xs font-medium text-rose-600 shadow-sm transition hover:bg-white"
          >
            <RefreshCcw className="h-4 w-4" />
            تلاش مجدد
          </button>
        ) : null}

        <button
          onClick={onRemove}
          aria-label="حذف رسانه"
          className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-infinity-primary text-white shadow-sm transition-opacity hover:bg-infinity-primary lg:h-8 lg:w-8 lg:opacity-0 lg:group-hover:opacity-100"
        >
          <DeleteIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Video Preview Modal */}
      {isVideo && (
        <VideoPreviewModal
          videoUrl={liveSrc ?? preview}
          isOpen={isVideoModalOpen}
          onClose={() => setIsVideoModalOpen(false)}
        />
      )}
    </>
  );
};

export default PhotoUploaderImagePreview;
