import type { ImageLoaderProps } from "next/image";
import { buildEdgeImageUrl } from "@/utils/edgeImageUrl";

/**
 * High-quality image loader specifically for PDP (Product Detail Page) images
 * Uses quality=95 to prevent compression and maintain image quality
 *
 * The quality only reaches the Next optimizer fallback (local assets, or any
 * environment without the media CDN). Arvan's resize takes no quality parameter,
 * so catalogue media on the edge is unaffected by it.
 */
export default function pdpImageLoader({ src, width, quality = 95 }: ImageLoaderProps) {
  return buildEdgeImageUrl({ src, width, quality });
}
