import type { ImageLoaderProps } from "next/image";
import { buildOptimizedImageUrl } from "@/utils/imageSecurity";

/**
 * High-quality image loader specifically for PDP (Product Detail Page) images
 * Uses quality=95 to prevent compression and maintain image quality
 */
export default function pdpImageLoader({ src, width, quality = 95 }: ImageLoaderProps) {
  return buildOptimizedImageUrl(src, width, quality);
}
