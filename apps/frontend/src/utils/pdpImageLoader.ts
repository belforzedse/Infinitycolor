import type { ImageLoaderProps } from "next/image";
import { buildEdgeImageUrl } from "@/utils/edgeImageUrl";

/**
 * The loader for PDP (Product Detail Page) imagery.
 *
 * The quality argument no longer changes anything: nothing in the pipeline
 * re-encodes. Catalogue media is resized by the edge, which takes `width` and
 * `height` only, and every other source is served as its own original. It is
 * kept so the call sites that pass a quality keep type-checking, and so the
 * intent — PDP imagery must not be degraded — stays recorded.
 */
export default function pdpImageLoader({ src, width, quality = 95 }: ImageLoaderProps) {
  return buildEdgeImageUrl({ src, width, quality });
}
