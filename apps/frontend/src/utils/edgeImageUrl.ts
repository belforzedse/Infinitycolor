import type { ImageLoaderProps } from "next/image";
import {
  buildOptimizedImageUrl,
  getNextImageWidth,
  isMediaCdnImageUrl,
  resolveSafeImageSrc,
} from "@/utils/imageSecurity";

/**
 * Formats ArvanCloud's Image Resize will actually resize.
 *
 * From the vendor documentation (docs.arvancloud.ir/fa/cdn/acceleration):
 * "این قابلیت روی تصاویر با فرمت‌های JPG ،PNG و WebP قابل پیاده‌سازی است و اگر
 * فرمت تصویر ورودی متفاوت باشد، تغییر اندازه روی آن اعمال نخواهد شد."
 *
 * Anything outside this set is returned by the edge untouched, so appending a
 * width to it would only mint one cache key per breakpoint for a byte-identical
 * response.
 */
const EDGE_RESIZABLE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

/**
 * GIF is the case that matters. The same documentation: "در فایل‌های GIF نیز
 * تنها اولین فریم تغییر سایز داده می‌شود و به‌عنوان فایل عکس غیر انیمیشنی
 * ذخیره می‌شود." A resized GIF loses its animation, which `apps/frontend/AGENTS.md`
 * forbids for storefront GIFs. Leaving the width off keeps the original bytes —
 * animated, and still served from the edge rather than the origin.
 */
function isEdgeResizable(pathname: string): boolean {
  const extension = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase();
  return EDGE_RESIZABLE_EXTENSIONS.has(extension);
}

/**
 * The single image-URL policy, shared by every loader.
 *
 * Deliberately free of a `"use client"` directive: `Product/CardParts/ImageCard.tsx`
 * and `Hero/ResponsiveHeroImage.tsx` are server components that pass `imageLoader`
 * as an explicit `loader` prop, so this has to be callable on both sides of the
 * boundary. Only `arvanImageLoader` — the module Next serializes for
 * `images.loaderFile` — carries the directive.
 *
 * Catalogue media goes to the edge, which resizes from the original and caches
 * the result; the origin then serves originals off disk and sharp never runs for
 * them. Everything else keeps the Next optimizer:
 *
 *   - no `NEXT_PUBLIC_MEDIA_CDN_URL` (dev, staging, any environment without the
 *     CDN) leaves `resolveSafeImageSrc` on the API origin, which cannot resize;
 *   - local `public/` assets are a fixed set of 145 files whose derivatives the
 *     gateway holds for a year, so their optimizer cost is paid once, and the
 *     largest of them exceed Arvan's 2 MB resize input limit anyway;
 *   - `NEXT_PUBLIC_IMAGE_LOADER=next` forces the old path for everything, which
 *     is the rollback: rebuild with one changed build argument, no code change.
 *
 * `quality` reaches the optimizer branches only. Arvan's resize takes `width` and
 * `height` and nothing else, so passing a quality would just fork the cache key
 * for an identical image.
 */
export function buildEdgeImageUrl({ src, width, quality = 70 }: ImageLoaderProps): string {
  if (process.env.NEXT_PUBLIC_IMAGE_LOADER === "next") {
    return buildOptimizedImageUrl(src, width, quality);
  }

  const resolved = resolveSafeImageSrc(src);

  // Rejected by the allowlist. Returning "" matches what the optimizer path
  // does rather than inventing a new failure mode for the same bad input.
  if (!resolved) return "";

  // A data URI is already the image, and a local public asset is served by the
  // app itself at a path Arvan does not host.
  if (resolved.startsWith("data:") || !isMediaCdnImageUrl(resolved)) {
    return buildOptimizedImageUrl(src, width, quality);
  }

  const url = new URL(resolved);
  if (!isEdgeResizable(url.pathname)) return url.toString();

  url.searchParams.set("width", String(getNextImageWidth(width)));
  return url.toString();
}

export default buildEdgeImageUrl;
