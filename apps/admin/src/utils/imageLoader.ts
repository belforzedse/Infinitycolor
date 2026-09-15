import type { ImageLoaderProps } from "next/image";
import { buildOptimizedImageUrl } from "@/utils/imageSecurity";

export default function imageLoader({ src, width, quality = 70 }: ImageLoaderProps) {
  // Local object/data URLs (e.g. freshly selected file previews) aren't
  // servable by the backend's /_next/image optimizer and don't need it;
  // resolveSafeImageSrc would otherwise strip them to "" since they never
  // match the /uploads/ allowlist.
  if (src.startsWith("blob:") || src.startsWith("data:")) {
    return src;
  }
  return buildOptimizedImageUrl(src, width, quality);
}
