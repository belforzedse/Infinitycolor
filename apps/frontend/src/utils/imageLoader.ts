import type { ImageLoaderProps } from "next/image";
import { buildOptimizedImageUrl } from "@/utils/imageSecurity";

export default function imageLoader({ src, width, quality = 70 }: ImageLoaderProps) {
  return buildOptimizedImageUrl(src, width, quality);
}
