import type { ImageLoaderProps } from "next/image";
import { buildOptimizedImageUrl } from "@/utils/imageSecurity";

/**
 * High-quality image loader specifically for PDP (Product Detail Page) images
 * Uses quality=95 to prevent compression and maintain image quality
 */
export default function pdpImageLoader({ src, width, quality = 95 }: ImageLoaderProps) {
  // Ensure width is a valid number (required by Next.js)
  const validWidth = width && width > 0 ? width : 1920; // Default to a large size if width is invalid
  return buildOptimizedImageUrl(src, validWidth, quality);
}
