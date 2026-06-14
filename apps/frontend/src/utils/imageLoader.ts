import type { ImageLoaderProps } from "next/image";
import { buildOptimizedImageUrl } from "@/utils/imageSecurity";

export default function imageLoader({ src, width, quality = 70 }: ImageLoaderProps) {
  // Ensure width is a valid number (required by Next.js)
  const validWidth = width && width > 0 ? width : 1920; // Default to a large size if width is invalid
  return buildOptimizedImageUrl(src, validWidth, quality);
}
