import type { ImageLoaderProps } from "next/image";
import { getNextImageWidth, isMediaCdnImageUrl, resolveSafeImageSrc } from "@/utils/imageSecurity";

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
 * EVERY RETURNED URL MUST BE DIRECTLY SERVABLE. `next.config.ts` sets
 * `images.loader: "custom"`, and the Next server answers `/_next/image` with
 * `render404()` whenever `images.loader !== "default"`
 * (`next/dist/server/next-server.js`, inside `handleNextImageRequest`). There is
 * no optimizer to fall back to: a loader that emits `/_next/image` emits a 404.
 * Configuring `loaderFile` and keeping an optimizer fallback is precisely the
 * mistake that took the storefront logo and every other `public/` image down in
 * `wt202609121652`.
 *
 * So the policy is a two-way split rather than a fallback chain:
 *
 *   - catalogue media on the media CDN gets `?width=`, and the edge resizes from
 *     the original — the origin serves originals off disk and sharp never runs;
 *   - everything else (local `public/` assets, `data:` URIs, and uploads still on
 *     the API origin because no CDN is configured) is returned untouched, because
 *     each of those is already a URL that serves the image on its own.
 *
 * `quality` is accepted for signature compatibility with `ImageLoaderProps` and
 * deliberately unused: Arvan's resize takes `width` and `height` and nothing
 * else, and no other branch re-encodes anything.
 */
export function buildEdgeImageUrl({ src, width }: ImageLoaderProps): string {
  const resolved = resolveSafeImageSrc(src);

  // Rejected by the allowlist. "" is the existing contract for bad input.
  if (!resolved) return "";

  // Already the image itself.
  if (resolved.startsWith("data:")) return resolved;

  // A local `public/` asset (origin-relative path) or an upload on the API
  // origin. Served as-is; neither host resizes, and neither needs to.
  if (!isMediaCdnImageUrl(resolved)) return resolved;

  const url = new URL(resolved);
  if (!isEdgeResizable(url.pathname)) return url.toString();

  // The rollback lever: rebuild with NEXT_PUBLIC_IMAGE_LOADER=next and the edge
  // stops being asked to resize, while every URL stays servable. It can no
  // longer mean "use the Next optimizer" — under a custom loader there isn't
  // one — so it means "originals only".
  if (process.env.NEXT_PUBLIC_IMAGE_LOADER === "next") return url.toString();

  url.searchParams.set("width", String(getNextImageWidth(width)));
  return url.toString();
}

export default buildEdgeImageUrl;
