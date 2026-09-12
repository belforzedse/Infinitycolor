// Required: Next serializes the loader function to the client, which it can
// only do from a Client Component (next/dist/docs .../next-config-js/images.md).
"use client";

import type { ImageLoaderProps } from "next/image";
import {
  buildOptimizedImageUrl,
  getNextImageWidth,
  isMediaCdnImageUrl,
  resolveSafeImageSrc,
} from "@/utils/imageSecurity";

/**
 * Image URLs for the edge.
 *
 * Every `/uploads` image used to be fetched by the Next optimizer over the
 * public API host, resized by sharp, and stored as a derivative on the origin
 * disk — 8,434 of them, at a 58% cache hit rate, each one pulling its source
 * back through three hops and Strapi. The catalogue is already 98% WebP, so
 * almost all of that work produced a file the size of the one it started from.
 *
 * Arvan resizes at the edge from a `?width=` parameter on the original URL, so
 * the origin only ever serves originals, straight off disk.
 *
 * Two deliberate fallbacks, because this must be safe to ship before the CDN is
 * configured and safe to abandon after:
 *
 *   - no `NEXT_PUBLIC_MEDIA_CDN_URL` (dev, staging, any environment without the
 *     CDN) leaves `resolveSafeImageSrc` pointing at the API origin, which cannot
 *     resize — so those go through `/_next/image` exactly as before;
 *   - `NEXT_PUBLIC_IMAGE_LOADER=next` forces the old path for everything, which
 *     is the rollback: rebuild with one changed build argument, no code change.
 *
 * `quality` is accepted and ignored. Arvan's resize takes `width` and `height`
 * only; passing anything else would just create a second cache key for an
 * identical image.
 */
export default function arvanImageLoader({ src, width, quality = 70 }: ImageLoaderProps): string {
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
  url.searchParams.set("width", String(getNextImageWidth(width)));
  return url.toString();
}
