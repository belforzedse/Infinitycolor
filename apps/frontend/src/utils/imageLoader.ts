import type { ImageLoaderProps } from "next/image";
import { buildEdgeImageUrl } from "@/utils/edgeImageUrl";

/**
 * The loader passed explicitly as `loader={imageLoader}` by product cards, the
 * PDP gallery, cart and order rows, blog cards and hero banners.
 *
 * An explicit `loader` prop takes precedence over `images.loaderFile`, so these
 * call sites reach the edge only because this delegates to the same policy.
 */
export default function imageLoader({ src, width, quality = 70 }: ImageLoaderProps) {
  return buildEdgeImageUrl({ src, width, quality });
}
